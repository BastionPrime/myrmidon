import { z } from "zod";

/**
 * Per-role task queues with leased claims (myrmidon 1.6, SWARM-CLAIM).
 *
 * Today the lead hands a task to an agent by assignment, and a board that only
 * wakes an agent on assignment leaves it idle whenever a run finishes and
 * another ready task already exists (the IDLE-PICKUP fix of 1.3 addressed the
 * wake half). This contract is the shared half of the 1.6 replacement: a task
 * belongs to the queue of an agent *role* (`agents.role`, the caste), and an
 * agent takes the top task of its own role's queue by acquiring a lease.
 *
 * The lease is what makes the queue safe to share:
 *
 * - a live claim is a row with `releasedAt IS NULL`; each heartbeat of the run
 *   refreshes `heartbeatAt` and pushes `expiresAt` forward by the TTL;
 * - an expired claim (`expiresAt < now`) covers nothing, so the task returns
 *   to its role's queue on the next sweep and the next agent may take it;
 * - releasing is a write to `releasedAt` plus a reason — the release path is
 *   shared by the run lifecycle, the TTL sweep and the supervisor rebalance.
 *
 * The values below are decided here once and read from both the server and the
 * settings page (the same precedence the other myrmidon limits use):
 *
 * - the stored settings value, when `general.swarmClaim` holds a value the
 *   validator accepts;
 * - otherwise the environment variable (the deployment default);
 * - otherwise the built-in default.
 *
 * The pilot flag is deliberately the only value whose default is "off": the
 * whole feature ships dark and an operator turns it on for one team, which is
 * what makes it possible to compare a pilot window against the BASELINE
 * snapshot.
 */

/**
 * Environment variable per setting — the names the server reads.
 *
 * 1.6.1 (SWARM-SETTINGS-UI): these are now *overrides*, not the primary
 * source. The primary source is the instance settings row
 * (`general.swarmClaim`, edited in the UI); a variable set in the process
 * environment wins over the stored value so an operator can force a contour
 * without touching the database. The resolver reports per key whether the
 * effective value came from the UI (`settings`), the override (`env`) or the
 * built-in default (`default`), and the settings screen and the supervisor
 * view both render that origin.
 */
export const SWARM_CLAIM_ENV_KEYS = {
  enabled: "MYRMIDON_SWARM_CLAIM_ENABLED",
  leaseTtlSec: "MYRMIDON_SWARM_LEASE_TTL_SEC",
  maxActiveTasks: "MYRMIDON_SWARM_MAX_ACTIVE_TASKS",
  sweepIntervalSec: "MYRMIDON_SWARM_CLAIM_SWEEP_INTERVAL_SEC",
} as const;

export const SWARM_CLAIM_SETTING_KEYS = [
  "enabled",
  "enabledRoles",
  "enabledCompanyIds",
  "leaseTtlSec",
  "maxActiveTasks",
  "sweepIntervalSec",
  "p0Preemption",
] as const;

export type SwarmClaimSettingKey = (typeof SWARM_CLAIM_SETTING_KEYS)[number];

/** Where an effective value came from: stored settings, the environment, or the default. */
export type SwarmClaimSettingSource = "settings" | "env" | "default";

/**
 * Stored-settings key inside `instance_settings.general` that holds the whole
 * object — one key, like `runLimits` and `workspaceHygiene`, so a partial
 * hand-edit cannot silently enable the pilot.
 */
export const SWARM_CLAIM_SETTINGS_KEY = "swarmClaim";

/** Master switch of the pilot. Off unless a value on the list below turns it on. */
export const DEFAULT_SWARM_CLAIM_ENABLED = false;

/**
 * 1.6.1 (SWARM-SETTINGS-UI): the pilot set. Empty means "no restriction": with
 * `enabled` on, every role of every company claims. A non-empty list narrows
 * the pilot to the listed roles (the pilot on the dev team) — a role not on
 * the list keeps vendor behavior even while the pilot is on elsewhere.
 * An empty string in the env override means "no restriction", the same reading
 * the other list-valued myrmidon settings use.
 */
export const SWARM_CLAIM_ENABLED_ROLES_ENV = "MYRMIDON_SWARM_CLAIM_ENABLED_ROLES";
export const SWARM_CLAIM_ENABLED_COMPANY_IDS_ENV = "MYRMIDON_SWARM_CLAIM_ENABLED_COMPANY_IDS";
export const DEFAULT_SWARM_CLAIM_ENABLED_ROLES: string[] = [];
export const DEFAULT_SWARM_CLAIM_ENABLED_COMPANY_IDS: string[] = [];

/**
 * 1.6.1 (SWARM-SETTINGS-UI): whether a P0 (critical) task preempts the queue
 * order. The 1.6 core hardcodes the preemption; this knob makes it a setting
 * an owner can turn off without a restart. On by default — the 1.6 behavior.
 */
export const SWARM_CLAIM_P0_PREEMPTION_ENV = "MYRMIDON_SWARM_CLAIM_P0_PREEMPTION";
export const DEFAULT_SWARM_CLAIM_P0_PREEMPTION = true;

/** How long one lease lives without a heartbeat. */
export const DEFAULT_SWARM_LEASE_TTL_SEC = 900;
export const MIN_SWARM_LEASE_TTL_SEC = 60;
export const MAX_SWARM_LEASE_TTL_SEC = 24 * 60 * 60;

/**
 * Ceiling of concurrently held tasks per agent. `null` means "no ceiling from
 * this setting": the run admission limits (C0) still cap what actually starts.
 */
export const DEFAULT_SWARM_MAX_ACTIVE_TASKS: number | null = 3;
export const MIN_SWARM_MAX_ACTIVE_TASKS = 1;
export const MAX_SWARM_MAX_ACTIVE_TASKS = 100;

/** How often the expired-lease sweep runs, in seconds. */
export const DEFAULT_SWARM_CLAIM_SWEEP_INTERVAL_SEC = 30;
export const MIN_SWARM_CLAIM_SWEEP_INTERVAL_SEC = 5;

/**
 * The wake reason the queue uses when it wakes the next agent of a role. Part A
 * (the core) and Part B (the supervisor rebalance) both take it from here, so
 * the two wake paths are one reason string, not two.
 */
export const SWARM_CLAIM_WAKE_REASON = "swarm_claim_queue";

/** Prefix of the idempotency key a queue wake carries (tracing, not a constraint). */
export const SWARM_CLAIM_WAKE_IDEMPOTENCY_PREFIX = "swarm_claim_queue";

/** Activity actions of the core claim paths. */
export const SWARM_CLAIM_CLAIMED_ACTION = "issue.swarm_claim.claimed";
export const SWARM_CLAIM_RELEASED_ACTION = "issue.swarm_claim.released";
/** The supervisor's early release carries its own action, so the two are tellable apart. */
export const SWARM_CLAIM_SUPERVISOR_RELEASED_ACTION = "issue.swarm_claim.supervisor_released";

/** Release reasons. The column is free text; these are the values the code writes. */
export const SWARM_CLAIM_RELEASE_REASON_RUN_FINISHED = "run_finished";
export const SWARM_CLAIM_RELEASE_REASON_LEASE_EXPIRED = "lease_expired";
export const SWARM_CLAIM_RELEASE_REASON_SUPERVISOR_REBALANCE = "supervisor_rebalance";
export const SWARM_CLAIM_RELEASE_REASON_ISSUE_CLOSED = "issue_closed";

/** Issue statuses whose tasks may appear in a role queue. */
export const SWARM_CLAIM_QUEUE_ISSUE_STATUSES = ["todo"] as const;

/**
 * Priority rank, highest first. `critical` is the P0 that preempts the queue:
 * the candidate order puts it at the top, so an agent that just released a task
 * takes the critical one before it takes the next ordinary one. Exported so the
 * queue (core) and the supervisor view (Part B) cannot drift apart.
 */
export function swarmPriorityRank(priority: string | null | undefined): number {
  switch (priority) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    case "low":
      return 3;
    default:
      return 4;
  }
}

/** The comparable shape both the queue and the supervisor view order. */
export interface SwarmQueueCandidate {
  issueId: string;
  identifier?: string | null;
  priority: string | null;
  /** Tie-break: the older the task entered the queue, the earlier it ranks. */
  queuedAt: Date | number | string | null;
}

function queuedAtMs(value: SwarmQueueCandidate["queuedAt"]): number {
  if (value === null || value === undefined) return 0;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * The queue order: highest priority first (a `critical` task is the top of the
 * queue), oldest entry into the queue breaks ties. This is the single order the
 * core picks in and the supervisor view renders, so "the top of the queue" means
 * the same thing in both.
 *
 * 1.6.1 (SWARM-SETTINGS-UI): `p0Preemption` off demotes the priority rank to a
 * tie-break-only signal — the queue becomes strictly oldest-first, so a critical
 * task no longer jumps it. Passing the setting is optional so every existing
 * call site (the supervisor view included) keeps the 1.6 order by default.
 */
export function orderSwarmQueueCandidates<T extends SwarmQueueCandidate>(
  candidates: readonly T[],
  options?: { p0Preemption?: boolean },
): T[] {
  const p0Preemption = options?.p0Preemption ?? true;
  return [...candidates].sort((left, right) => {
    if (p0Preemption) {
      const leftRank = swarmPriorityRank(left.priority);
      const rightRank = swarmPriorityRank(right.priority);
      if (leftRank !== rightRank) return leftRank - rightRank;
    }
    return queuedAtMs(left.queuedAt) - queuedAtMs(right.queuedAt);
  });
}

/** A lease as the queue and the supervisor view read it. */
export interface SwarmClaimLease {
  id: string;
  issueId: string;
  agentId: string;
  heartbeatAt: Date | number | string | null;
  expiresAt: Date | number | string | null;
  releasedAt: Date | number | string | null;
}

function toMs(value: Date | number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** True when the lease still covers its task: not released, and not past `now`. */
export function isSwarmLeaseLive(lease: SwarmClaimLease, now: Date = new Date()): boolean {
  if (lease.releasedAt !== null && lease.releasedAt !== undefined) return false;
  const expires = toMs(lease.expiresAt);
  if (expires === null) return false;
  return expires > now.getTime();
}

/**
 * True when a lease that was never released has run out. An expired lease is
 * not a live one — the TTL sweep releases it and the task returns to the queue —
 * but the supervisor view shows it as its own state, so it needs its own name.
 */
export function isSwarmLeaseExpired(lease: SwarmClaimLease, now: Date = new Date()): boolean {
  if (lease.releasedAt !== null && lease.releasedAt !== undefined) return false;
  const expires = toMs(lease.expiresAt);
  if (expires === null) return false;
  return expires <= now.getTime();
}

// --- settings schema ------------------------------------------------------

const leaseTtlSchema = z.number().int().min(MIN_SWARM_LEASE_TTL_SEC).max(MAX_SWARM_LEASE_TTL_SEC);
const maxActiveTasksSchema = z
  .number()
  .int()
  .min(MIN_SWARM_MAX_ACTIVE_TASKS)
  .max(MAX_SWARM_MAX_ACTIVE_TASKS)
  .nullable();
const sweepIntervalSchema = z.number().int().min(MIN_SWARM_CLAIM_SWEEP_INTERVAL_SEC);

// 1.6.1 (SWARM-SETTINGS-UI): the pilot-set lists. Non-empty arrays of trimmed
// non-empty strings; an empty array is the honest "no restriction" and is
// stored as such (not omitted), so the settings screen can tell "the operator
// chose everyone" from "nothing was ever saved".
const enabledRolesSchema = z.array(z.string().trim().min(1).max(200)).max(200);
const enabledCompanyIdsSchema = z.array(z.string().trim().min(1).max(64)).max(200);

/** The canonical stored shape of `instance_settings.general.swarmClaim`. */
export const swarmClaimSettingsSchema = z
  .object({
    enabled: z.boolean(),
    enabledRoles: enabledRolesSchema.default(DEFAULT_SWARM_CLAIM_ENABLED_ROLES),
    enabledCompanyIds: enabledCompanyIdsSchema.default(DEFAULT_SWARM_CLAIM_ENABLED_COMPANY_IDS),
    leaseTtlSec: leaseTtlSchema,
    maxActiveTasks: maxActiveTasksSchema,
    sweepIntervalSec: sweepIntervalSchema,
    p0Preemption: z.boolean().default(DEFAULT_SWARM_CLAIM_P0_PREEMPTION),
  })
  .strict();

/** Body of `PATCH /api/myrmidon/swarm-claim`: any subset; absent keys keep their value. */
export const patchSwarmClaimSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    enabledRoles: enabledRolesSchema.optional(),
    enabledCompanyIds: enabledCompanyIdsSchema.optional(),
    leaseTtlSec: leaseTtlSchema.optional(),
    maxActiveTasks: maxActiveTasksSchema.optional(),
    sweepIntervalSec: sweepIntervalSchema.optional(),
    p0Preemption: z.boolean().optional(),
  })
  .strict();

export type SwarmClaimSettings = z.infer<typeof swarmClaimSettingsSchema>;
export type SwarmClaimSettingsPatch = z.infer<typeof patchSwarmClaimSettingsSchema>;

export interface ResolvedSwarmClaimSettings {
  settings: SwarmClaimSettings;
  sources: Record<SwarmClaimSettingKey, SwarmClaimSettingSource>;
}

/** The single truth for "is this string an explicit on?". A typo must not enable the pilot. */
export function parseSwarmClaimEnabled(raw: string | undefined | null): boolean | null {
  const value = raw?.trim().toLowerCase();
  if (!value) return null;
  if (value === "1" || value === "true" || value === "yes" || value === "on") return true;
  if (value === "0" || value === "false" || value === "off" || value === "no") return false;
  return null;
}

/** The settings as the environment declares them, with the built-in defaults. */
export function readSwarmClaimSettingsFromEnv(
  env: Record<string, string | undefined> = {},
): SwarmClaimSettings {
  const ttl = Number(env[SWARM_CLAIM_ENV_KEYS.leaseTtlSec]?.trim());
  const maxActiveRaw = env[SWARM_CLAIM_ENV_KEYS.maxActiveTasks]?.trim();
  const maxActive = maxActiveRaw ? Number(maxActiveRaw) : Number.NaN;
  const sweep = Number(env[SWARM_CLAIM_ENV_KEYS.sweepIntervalSec]?.trim());
  return {
    enabled: parseSwarmClaimEnabled(env[SWARM_CLAIM_ENV_KEYS.enabled]) ?? DEFAULT_SWARM_CLAIM_ENABLED,
    leaseTtlSec:
      Number.isInteger(ttl) && ttl >= MIN_SWARM_LEASE_TTL_SEC && ttl <= MAX_SWARM_LEASE_TTL_SEC
        ? ttl
        : DEFAULT_SWARM_LEASE_TTL_SEC,
    maxActiveTasks:
      // An empty or `0` value means "no ceiling from this setting", the same
      // reading the run admission limits use for their caps.
      maxActiveRaw === ""
        ? null
        : Number.isInteger(maxActive) &&
            maxActive >= MIN_SWARM_MAX_ACTIVE_TASKS &&
            maxActive <= MAX_SWARM_MAX_ACTIVE_TASKS
          ? maxActive
          : maxActiveRaw === undefined
            ? DEFAULT_SWARM_MAX_ACTIVE_TASKS
            : null,
    sweepIntervalSec:
      Number.isInteger(sweep) && sweep >= MIN_SWARM_CLAIM_SWEEP_INTERVAL_SEC
        ? sweep
        : DEFAULT_SWARM_CLAIM_SWEEP_INTERVAL_SEC,
    p0Preemption:
      parseSwarmClaimEnabled(env[SWARM_CLAIM_P0_PREEMPTION_ENV]) ?? DEFAULT_SWARM_CLAIM_P0_PREEMPTION,
    enabledRoles: readSwarmClaimListEnv(env[SWARM_CLAIM_ENABLED_ROLES_ENV]),
    enabledCompanyIds: readSwarmClaimListEnv(env[SWARM_CLAIM_ENABLED_COMPANY_IDS_ENV]),
  };
}

/** A comma-separated list variable: trimmed entries, empty entries dropped. */
export function readSwarmClaimListEnv(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** The stored settings value, or null when the row holds nothing usable. */
export function normalizeSwarmClaimSettings(raw: unknown): SwarmClaimSettings | null {
  const parsed = swarmClaimSettingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Effective settings and where each value came from. `stored` is the raw
 * `general.swarmClaim` value; an unreadable one counts as absent, so the
 * environment (or the default) applies instead — a hand-edited row cannot
 * enable the pilot on its own.
 *
 * 1.6.1 (SWARM-SETTINGS-UI): precedence is per key — the environment variable
 * wins over the stored value only for the keys whose variable is actually set
 * and readable, so the UI stays the source of truth for everything the operator
 * did not force. Each entry of `sources` says which side won for that key.
 */
export function resolveSwarmClaimSettings(options: {
  stored?: unknown;
  env?: Record<string, string | undefined>;
} = {}): ResolvedSwarmClaimSettings {
  const env = options.env ?? {};
  const stored = normalizeSwarmClaimSettings(options.stored);
  const envSettings = readSwarmClaimSettingsFromEnv(env);
  const settings: SwarmClaimSettings = stored
    ? {
        ...envSettings,
        ...stored,
        // A set, readable override beats the stored value key by key.
        enabled:
          parseSwarmClaimEnabled(env[SWARM_CLAIM_ENV_KEYS.enabled]) ?? stored.enabled,
        leaseTtlSec: envNumberOr(env[SWARM_CLAIM_ENV_KEYS.leaseTtlSec], stored.leaseTtlSec, {
          min: MIN_SWARM_LEASE_TTL_SEC,
          max: MAX_SWARM_LEASE_TTL_SEC,
        }),
        maxActiveTasks: envMaxActiveOr(env[SWARM_CLAIM_ENV_KEYS.maxActiveTasks], stored.maxActiveTasks),
        sweepIntervalSec: envNumberOr(env[SWARM_CLAIM_ENV_KEYS.sweepIntervalSec], stored.sweepIntervalSec, {
          min: MIN_SWARM_CLAIM_SWEEP_INTERVAL_SEC,
        }),
        p0Preemption:
          parseSwarmClaimEnabled(env[SWARM_CLAIM_P0_PREEMPTION_ENV]) ?? stored.p0Preemption,
        enabledRoles:
          env[SWARM_CLAIM_ENABLED_ROLES_ENV] !== undefined
            ? envSettings.enabledRoles
            : stored.enabledRoles,
        enabledCompanyIds:
          env[SWARM_CLAIM_ENABLED_COMPANY_IDS_ENV] !== undefined
            ? envSettings.enabledCompanyIds
            : stored.enabledCompanyIds,
      }
    : envSettings;

  // The source of each key: the override won ("env"), the stored row won
  // ("settings"), or nothing was set and the built-in default applied
  // ("default"). The UI and the supervisor view render exactly this.
  const sources = {} as Record<SwarmClaimSettingKey, SwarmClaimSettingSource>;
  const hasOverride = (name: string) => env[name] !== undefined && env[name]!.trim() !== "";
  sources.enabled = hasOverride(SWARM_CLAIM_ENV_KEYS.enabled)
    ? "env"
    : stored
      ? "settings"
      : "default";
  sources.enabledRoles = hasOverride(SWARM_CLAIM_ENABLED_ROLES_ENV)
    ? "env"
    : stored
      ? "settings"
      : "default";
  sources.enabledCompanyIds = hasOverride(SWARM_CLAIM_ENABLED_COMPANY_IDS_ENV)
    ? "env"
    : stored
      ? "settings"
      : "default";
  sources.leaseTtlSec = hasOverride(SWARM_CLAIM_ENV_KEYS.leaseTtlSec)
    ? "env"
    : stored
      ? "settings"
      : "default";
  sources.maxActiveTasks = hasOverride(SWARM_CLAIM_ENV_KEYS.maxActiveTasks)
    ? "env"
    : stored
      ? "settings"
      : "default";
  sources.sweepIntervalSec = hasOverride(SWARM_CLAIM_ENV_KEYS.sweepIntervalSec)
    ? "env"
    : stored
      ? "settings"
      : "default";
  sources.p0Preemption = hasOverride(SWARM_CLAIM_P0_PREEMPTION_ENV)
    ? "env"
    : stored
      ? "settings"
      : "default";
  return { settings, sources };
}

/** A readable integer in range wins; anything else falls back to `stored`. */
function envNumberOr(
  raw: string | undefined,
  stored: number,
  bounds: { min: number; max?: number },
): number {
  if (raw === undefined || raw.trim() === "") return stored;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < bounds.min) return stored;
  if (bounds.max !== undefined && value > bounds.max) return stored;
  return value;
}

/**
 * The maxActiveTasks override reading: an explicit `none`/`0`/empty value is
 * "no ceiling", a readable integer is the ceiling, anything unreadable keeps
 * the stored value.
 */
function envMaxActiveOr(raw: string | undefined, stored: number | null): number | null {
  const value = raw?.trim();
  if (value === undefined || value === "") return stored;
  if (value.toLowerCase() === "none" || value === "0") return null;
  const parsed = Number(value);
  if (
    Number.isInteger(parsed) &&
    parsed >= MIN_SWARM_MAX_ACTIVE_TASKS &&
    parsed <= MAX_SWARM_MAX_ACTIVE_TASKS
  ) {
    return parsed;
  }
  return stored;
}

/**
 * 1.6.1 (SWARM-SETTINGS-UI): is the claim path enabled for one company + role?
 * The pilot gate the server actually enforces: the master switch, the company
 * list (empty = every company) and the role list (empty = every role) must all
 * pass. Exported so the settings screen, the claim service and the supervisor
 * view agree on who is in the pilot.
 */
export function isSwarmClaimEnabledFor(
  settings: Pick<
    SwarmClaimSettings,
    "enabled" | "enabledCompanyIds" | "enabledRoles"
  >,
  input: { companyId: string; role: string },
): boolean {
  if (!settings.enabled) return false;
  if (
    settings.enabledCompanyIds.length > 0 &&
    !settings.enabledCompanyIds.includes(input.companyId)
  ) {
    return false;
  }
  if (settings.enabledRoles.length > 0 && !settings.enabledRoles.includes(input.role)) {
    return false;
  }
  return true;
}

/** A patch over the effective values, the shape that gets stored. */
export function mergeSwarmClaimSettings(
  base: SwarmClaimSettings,
  patch: SwarmClaimSettingsPatch,
): SwarmClaimSettings {
  return {
    enabled: patch.enabled === undefined ? base.enabled : patch.enabled,
    enabledRoles: patch.enabledRoles === undefined ? base.enabledRoles : patch.enabledRoles,
    enabledCompanyIds:
      patch.enabledCompanyIds === undefined ? base.enabledCompanyIds : patch.enabledCompanyIds,
    leaseTtlSec: patch.leaseTtlSec === undefined ? base.leaseTtlSec : patch.leaseTtlSec,
    maxActiveTasks:
      patch.maxActiveTasks === undefined ? base.maxActiveTasks : patch.maxActiveTasks,
    sweepIntervalSec:
      patch.sweepIntervalSec === undefined ? base.sweepIntervalSec : patch.sweepIntervalSec,
    p0Preemption: patch.p0Preemption === undefined ? base.p0Preemption : patch.p0Preemption,
  };
}

/** The lease TTL in milliseconds — the unit the store and the sweep work in. */
export function swarmLeaseTtlMs(settings: Pick<SwarmClaimSettings, "leaseTtlSec">): number {
  return settings.leaseTtlSec * 1000;
}

/**
 * The shortest lease window the write paths may set. Everything that stamps
 * `expiresAt` goes through this, so a claim written by the checkout hook, a
 * heartbeat refresh and a re-claim after an expiry cannot disagree on the TTL.
 */
export function swarmLeaseExpiresAt(now: Date, settings: Pick<SwarmClaimSettings, "leaseTtlSec">): Date {
  return new Date(now.getTime() + swarmLeaseTtlMs(settings));
}

/**
 * Whether an agent may take one more task. `maxActiveTasks === null` is "no
 * ceiling from this setting": the caller does not need a second code path,
 * because every ceiling this returns false for is a ceiling the settings
 * declared.
 */
export function swarmActiveTaskLimitReached(
  activeTasks: number,
  settings: Pick<SwarmClaimSettings, "maxActiveTasks">,
): boolean {
  if (settings.maxActiveTasks === null) return false;
  return activeTasks >= settings.maxActiveTasks;
}
// --- company caste directory (myrmidon 1.6.1 CUSTOM-CASTES B) ---------------

/**
 * The claim outcome reason for an agent whose caste is excluded from the
 * swarm: `swarmEligible=false` in the company caste directory. The claim
 * service returns this instead of a generic "queue empty", so a supervisor
 * can tell "this caste never takes tasks" from "nothing to take".
 */
export const SWARM_CLAIM_REASON_CASTE_EXCLUDED = "caste_excluded";

/**
 * One entry of a company caste directory (`agents.role` keys). Part A owns
 * the storage and the REST surface; this is the read shape every consumer
 * (the claim gate, the agent-create validation) agrees on, so the swarm can
 * compile against it before the directory table lands.
 */
export interface CompanyCaste {
  key: string;
  swarmEligible: boolean;
  /** int >= 1, or null to keep the global swarm ceiling. */
  maxActiveTasks: number | null;
}

/** A castes read port: the directory of one company, seeded on first read. */
export type CompanyCastesReader = (
  companyId: string,
) => Promise<readonly CompanyCaste[]>;
