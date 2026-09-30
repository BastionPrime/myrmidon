import { z } from "zod";

/**
 * Workspace hygiene quotas (myrmidon WORKSPACE-HYGIENE, part C).
 *
 * Execution workspaces carry their own `node_modules` and their own build
 * output. On 30.09.2026 the work volume filled to 100 % with workspaces of
 * already merged branches and agents started failing with "session storage
 * could not be written". Nothing in the product measured them and nothing
 * capped them, so the disk filled silently. This module is the shared part of
 * the fix: how much disk one workspace may use, how big it actually is, and
 * when the sweep should raise its "clean up" signal.
 *
 * Two values are stored in `instance_settings.general.workspaceHygiene`:
 *
 * - `workspaceQuotaMb` — ceiling for a single execution workspace;
 * - `totalQuotaMb` — ceiling for the sum of the measured workspaces of one
 *   company.
 *
 * `null` means "the cap is off", which is also the built-in default: an
 * instance that never sets a value is never signalled, so shipping this module
 * changes no behaviour until an operator (or the deployment) sets a quota.
 *
 * Precedence per value, decided here once and read from two places:
 *
 * - the stored settings value, when `general.workspaceHygiene` holds a value
 *   the validator accepts;
 * - otherwise the environment variable, which stays the default for an
 *   instance whose row was never written;
 * - otherwise the built-in default (`off`).
 *
 * The stored object is canonical: both keys present, each `null` or a positive
 * integer. A hand-edited row that does not match is ignored as a whole, so the
 * sweep can never read a quota it did not validate.
 *
 * The measurement record (`metadata.workspaceHygiene` of one workspace) lives
 * here too: the sweep writes it, the API reads it, and `lastSignalAt` is what
 * keeps the "clean up" signal at most once per day per workspace.
 */

/** Environment variable per quota — the names the deployment sets. */
export const WORKSPACE_HYGIENE_ENV_KEYS = {
  workspaceQuotaMb: "MYRMIDON_WORKSPACE_QUOTA_MB",
  totalQuotaMb: "MYRMIDON_WORKSPACE_TOTAL_QUOTA_MB",
} as const;

export const WORKSPACE_HYGIENE_LIMIT_KEYS = ["workspaceQuotaMb", "totalQuotaMb"] as const;

export type WorkspaceHygieneLimitKey = (typeof WORKSPACE_HYGIENE_LIMIT_KEYS)[number];

/** Where an effective quota came from: stored settings, the environment, or the default. */
export type WorkspaceHygieneLimitSource = "settings" | "env" | "default";

/** Key of the measurement record inside an execution workspace `metadata` object. */
export const WORKSPACE_HYGIENE_METADATA_KEY = "workspaceHygiene";

/** Activity actions: one workspace over its quota, and one company over its total. */
export const WORKSPACE_QUOTA_EXCEEDED_ACTION = "workspace.quota_exceeded";
export const WORKSPACE_TOTAL_QUOTA_EXCEEDED_ACTION = "workspace.total_quota_exceeded";

/** Action of a quota change, written for every company like every instance settings write. */
export const WORKSPACE_HYGIENE_UPDATED_ACTION = "instance.workspace_hygiene.updated";

/** An over-quota workspace is signalled at most once per this window. */
export const WORKSPACE_QUOTA_SIGNAL_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const BYTES_PER_MB = 1024 * 1024;

/**
 * What the signal tells the reader to do. The activity log is read by people,
 * so the hint names the two moves that actually free the disk: drop the
 * workspaces whose work is already merged, or re-provision — a fresh provision
 * installs `node_modules` from the shared store instead of keeping a private
 * copy.
 */
export const WORKSPACE_QUOTA_SIGNAL_HINT =
  "Delete the workspaces whose work is already merged, or re-provision this "
  + "workspace: a fresh provision takes node_modules from the shared store instead "
  + "of keeping a private copy.";

/** A quota: a positive integer, or null for "off". */
const quotaMbSchema = z.number().int().positive().nullable();

/** The canonical stored shape of `instance_settings.general.workspaceHygiene`. */
export const workspaceHygieneLimitsSchema = z
  .object({
    workspaceQuotaMb: quotaMbSchema,
    totalQuotaMb: quotaMbSchema,
  })
  .strict();

/** Body of `PATCH /api/myrmidon/workspace-hygiene`: any subset; absent keys keep their value. */
export const patchWorkspaceHygieneLimitsSchema = z
  .object({
    workspaceQuotaMb: quotaMbSchema.optional(),
    totalQuotaMb: quotaMbSchema.optional(),
  })
  .strict();

export type WorkspaceHygieneLimits = z.infer<typeof workspaceHygieneLimitsSchema>;
export type WorkspaceHygieneLimitsPatch = z.infer<typeof patchWorkspaceHygieneLimitsSchema>;

export interface ResolvedWorkspaceHygieneLimits {
  limits: WorkspaceHygieneLimits;
  sources: Record<WorkspaceHygieneLimitKey, WorkspaceHygieneLimitSource>;
}

/** One sweep measurement of one workspace, as stored in its metadata. */
export interface WorkspaceHygieneMeasurementRecord {
  /** ISO timestamp of the measurement. */
  measuredAt: string;
  /** Apparent size of the measured tree in bytes. */
  sizeBytes: number;
  /** Entries the walk looked at; the walk stops at its own cap. */
  entries: number;
  /** True when the walk stopped at its entry or time cap, so `sizeBytes` is a lower bound. */
  truncated: boolean;
  /** True when the measurement was over the quota in force at that moment. */
  overQuota: boolean;
  /** ISO timestamp of the last "clean up" signal, or null when there was none. */
  lastSignalAt: string | null;
}

const measurementRecordSchema = z
  .object({
    measuredAt: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
    entries: z.number().int().nonnegative(),
    truncated: z.boolean(),
    overQuota: z.boolean(),
    lastSignalAt: z.string().min(1).nullable(),
  })
  .strict();

/** An environment value as a quota: a positive integer, or null for "off". */
export function parseWorkspaceQuotaValue(raw: string | undefined): number | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value <= 0) return null;
  return value;
}

/** The quotas as the environment declares them: both off unless a variable is set. */
export function readWorkspaceHygieneLimitsFromEnv(
  env: Record<string, string | undefined> = {},
): WorkspaceHygieneLimits {
  return {
    workspaceQuotaMb: parseWorkspaceQuotaValue(env[WORKSPACE_HYGIENE_ENV_KEYS.workspaceQuotaMb]),
    totalQuotaMb: parseWorkspaceQuotaValue(env[WORKSPACE_HYGIENE_ENV_KEYS.totalQuotaMb]),
  };
}

/** The stored settings value, or null when the row holds nothing usable. */
export function normalizeWorkspaceHygieneLimits(raw: unknown): WorkspaceHygieneLimits | null {
  const parsed = workspaceHygieneLimitsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Effective quotas and where each one came from. `stored` is the raw
 * `general.workspaceHygiene` value; an unreadable one counts as absent, so the
 * environment (or the default) applies instead.
 */
export function resolveWorkspaceHygieneLimits(options: {
  stored?: unknown;
  env?: Record<string, string | undefined>;
} = {}): ResolvedWorkspaceHygieneLimits {
  const env = options.env ?? {};
  const stored = normalizeWorkspaceHygieneLimits(options.stored);
  if (stored) {
    return {
      limits: stored,
      sources: { workspaceQuotaMb: "settings", totalQuotaMb: "settings" },
    };
  }
  const sources = {} as Record<WorkspaceHygieneLimitKey, WorkspaceHygieneLimitSource>;
  for (const key of WORKSPACE_HYGIENE_LIMIT_KEYS) {
    sources[key] =
      parseWorkspaceQuotaValue(env[WORKSPACE_HYGIENE_ENV_KEYS[key]]) === null ? "default" : "env";
  }
  return { limits: readWorkspaceHygieneLimitsFromEnv(env), sources };
}

/** A patch over the effective values, the shape that gets stored. */
export function mergeWorkspaceHygieneLimits(
  base: WorkspaceHygieneLimits,
  patch: WorkspaceHygieneLimitsPatch,
): WorkspaceHygieneLimits {
  return {
    workspaceQuotaMb:
      patch.workspaceQuotaMb === undefined ? base.workspaceQuotaMb : patch.workspaceQuotaMb,
    totalQuotaMb: patch.totalQuotaMb === undefined ? base.totalQuotaMb : patch.totalQuotaMb,
  };
}

/** The quota as bytes, or null when it is off. */
export function workspaceQuotaBytes(quotaMb: number | null): number | null {
  return quotaMb === null ? null : quotaMb * BYTES_PER_MB;
}

/** True when a measured workspace is over the quota. An absent quota is never exceeded. */
export function isWorkspaceOverQuota(sizeBytes: number, quotaMb: number | null): boolean {
  const quotaBytes = workspaceQuotaBytes(quotaMb);
  return quotaBytes !== null && sizeBytes > quotaBytes;
}

/** Bytes as whole megabytes, the unit the signal and the API report. */
export function megabytesFromBytes(bytes: number): number {
  return Math.max(0, Math.round(bytes / BYTES_PER_MB));
}

/**
 * Whether this measurement must produce a "clean up" signal. True when the
 * workspace is over the quota and it was not signalled within the window, so a
 * workspace that stays over its quota is signalled once a day, not once a tick.
 */
export function shouldSignalWorkspaceQuota(input: {
  sizeBytes: number;
  quotaMb: number | null;
  lastSignalAt: string | null | undefined;
  now: Date;
  intervalMs?: number;
}): boolean {
  if (!isWorkspaceOverQuota(input.sizeBytes, input.quotaMb)) return false;
  const intervalMs = input.intervalMs ?? WORKSPACE_QUOTA_SIGNAL_INTERVAL_MS;
  const last = input.lastSignalAt ? Date.parse(input.lastSignalAt) : Number.NaN;
  if (!Number.isFinite(last)) return true;
  return input.now.getTime() - last >= intervalMs;
}

/** The measurement record of a workspace metadata object, or null when there is none usable. */
export function readWorkspaceHygieneRecord(
  metadata: Record<string, unknown> | null | undefined,
): WorkspaceHygieneMeasurementRecord | null {
  if (!metadata || typeof metadata !== "object") return null;
  const parsed = measurementRecordSchema.safeParse(
    (metadata as Record<string, unknown>)[WORKSPACE_HYGIENE_METADATA_KEY],
  );
  return parsed.success ? parsed.data : null;
}

/**
 * A metadata object with the measurement record written and every other key
 * kept. The row is the workspace's own, so other metadata writers (the
 * lifecycle flags of the workspace service) must survive this write.
 */
export function writeWorkspaceHygieneRecord(
  metadata: Record<string, unknown> | null | undefined,
  record: WorkspaceHygieneMeasurementRecord,
): Record<string, unknown> {
  const base = metadata && typeof metadata === "object" ? metadata : {};
  return { ...base, [WORKSPACE_HYGIENE_METADATA_KEY]: record };
}

/** Details of the per-workspace signal: neutral, no host paths, size in MB, workspace id. */
export function workspaceQuotaSignalDetails(input: {
  workspaceId: string;
  workspaceName: string;
  sizeBytes: number;
  quotaMb: number | null;
  measuredAt: string;
}): Record<string, unknown> {
  return {
    workspaceId: input.workspaceId,
    workspaceName: input.workspaceName,
    sizeMb: megabytesFromBytes(input.sizeBytes),
    quotaMb: input.quotaMb,
    measuredAt: input.measuredAt,
    hint: WORKSPACE_QUOTA_SIGNAL_HINT,
  };
}

/** Details of the per-company total signal. */
export function workspaceTotalQuotaSignalDetails(input: {
  totalBytes: number;
  totalQuotaMb: number | null;
  measuredWorkspaces: number;
}): Record<string, unknown> {
  return {
    totalSizeMb: megabytesFromBytes(input.totalBytes),
    totalQuotaMb: input.totalQuotaMb,
    measuredWorkspaces: input.measuredWorkspaces,
    hint: WORKSPACE_QUOTA_SIGNAL_HINT,
  };
}

/** What the measured workspaces add up to; the API reports it as the current status. */
export function summarizeWorkspaceMeasurements(
  records: ReadonlyArray<{ sizeBytes: number; overQuota: boolean }>,
): { measuredWorkspaces: number; totalBytes: number; overQuotaCount: number } {
  let totalBytes = 0;
  let overQuotaCount = 0;
  for (const record of records) {
    totalBytes += record.sizeBytes;
    if (record.overQuota) overQuotaCount += 1;
  }
  return { measuredWorkspaces: records.length, totalBytes, overQuotaCount };
}