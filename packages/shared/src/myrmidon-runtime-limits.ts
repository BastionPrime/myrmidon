import { z } from "zod";

/**
 * Run admission limits that can be changed while the server runs
 * (myrmidon C0, RUNTIME-LIMITS).
 *
 * The four values below cap how many agent runs this server process starts:
 * its own concurrency ceiling, the start rate per sliding minute, the free
 * memory it keeps for itself, and how much memory one run is budgeted. In the
 * deployment they come from the environment (`MYRMIDON_*`); this module also
 * stores them in `instance_settings.general.runLimits` so an operator can
 * change them from the API and the settings page without restarting the
 * server — a restart drops every run in flight.
 *
 * Precedence, per value, is decided here once and read from two places:
 *
 * - the stored settings value, when the key is present in `general.runLimits`;
 * - otherwise the environment variable, which stays the default for the first
 *   start on an instance that has never saved these settings;
 * - otherwise the built-in default (300 MB for the per-run budget, "off" for
 *   the three caps).
 *
 * `null` means "this cap is off" — the same meaning an unset, empty, zero,
 * negative or non-numeric environment value has today. A value is a positive
 * integer, so nothing here can turn a cap into "start one run anyway".
 *
 * The stored object is canonical: all four keys, caps null or a positive
 * integer. `resolveRunLimits` accepts anything and falls back to the
 * environment for a value it cannot read, so a hand-edited row cannot make the
 * server read a limit it never validated.
 */

/** Environment variable per limit — the names the admission module reads. */
export const RUN_LIMITS_ENV_KEYS = {
  maxConcurrentRuns: "MYRMIDON_MAX_CONCURRENT_RUNS",
  maxStartsPerMinute: "MYRMIDON_MAX_RUN_STARTS_PER_MINUTE",
  minFreeMemoryMb: "MYRMIDON_MIN_FREE_MEMORY_MB",
  runMemoryEstimateMb: "MYRMIDON_RUN_MEMORY_ESTIMATE_MB",
} as const;

export const RUN_LIMIT_KEYS = [
  "maxConcurrentRuns",
  "maxStartsPerMinute",
  "minFreeMemoryMb",
  "runMemoryEstimateMb",
] as const;

export type RunLimitKey = (typeof RUN_LIMIT_KEYS)[number];

/** Where an effective value came from: stored settings, the environment, or the default. */
export type RunLimitsSource = "settings" | "env" | "default";

/** Memory budgeted for one run when nothing says otherwise. */
export const DEFAULT_RUN_MEMORY_ESTIMATE_MB = 300;

/** A cap: a positive integer, or null for "off". */
const runLimitCapSchema = z.number().int().positive().nullable();

/** The canonical stored shape of `instance_settings.general.runLimits`. */
export const runLimitsSchema = z
  .object({
    maxConcurrentRuns: runLimitCapSchema,
    maxStartsPerMinute: runLimitCapSchema,
    minFreeMemoryMb: runLimitCapSchema,
    runMemoryEstimateMb: z.number().int().positive(),
  })
  .strict();

/**
 * Body of `PATCH /api/myrmidon/runtime-limits`: any subset of the four values.
 * Absent keys keep their effective value; `null` switches a cap off. The
 * per-run budget cannot be switched off — it is what the memory floor is
 * counted with.
 */
export const patchRunLimitsSchema = z
  .object({
    maxConcurrentRuns: runLimitCapSchema.optional(),
    maxStartsPerMinute: runLimitCapSchema.optional(),
    minFreeMemoryMb: runLimitCapSchema.optional(),
    runMemoryEstimateMb: z.number().int().positive().optional(),
  })
  .strict();

export type RunLimits = z.infer<typeof runLimitsSchema>;
export type RunLimitsPatch = z.infer<typeof patchRunLimitsSchema>;

export interface ResolvedRunLimits {
  limits: RunLimits;
  sources: Record<RunLimitKey, RunLimitsSource>;
}

/** An environment value as a limit: a positive integer, or null for "off". */
export function parseRunLimitValue(raw: string | undefined): number | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value <= 0) return null;
  return value;
}

/** The limits as the environment declares them, with the built-in defaults. */
export function readRunLimitsFromEnv(env: Record<string, string | undefined> = {}): RunLimits {
  return {
    maxConcurrentRuns: parseRunLimitValue(env[RUN_LIMITS_ENV_KEYS.maxConcurrentRuns]),
    maxStartsPerMinute: parseRunLimitValue(env[RUN_LIMITS_ENV_KEYS.maxStartsPerMinute]),
    minFreeMemoryMb: parseRunLimitValue(env[RUN_LIMITS_ENV_KEYS.minFreeMemoryMb]),
    runMemoryEstimateMb:
      parseRunLimitValue(env[RUN_LIMITS_ENV_KEYS.runMemoryEstimateMb]) ?? DEFAULT_RUN_MEMORY_ESTIMATE_MB,
  };
}

/** The stored settings value, or null when the row holds nothing usable. */
export function normalizeRunLimits(raw: unknown): RunLimits | null {
  const parsed = runLimitsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Effective limits and where each one came from. `stored` is the raw
 * `general.runLimits` value; an unreadable one counts as absent, so the
 * environment (or the default) applies instead.
 */
export function resolveRunLimits(options: {
  stored?: unknown;
  env?: Record<string, string | undefined>;
} = {}): ResolvedRunLimits {
  const env = options.env ?? {};
  const stored = normalizeRunLimits(options.stored);
  if (stored) {
    return {
      limits: stored,
      sources: {
        maxConcurrentRuns: "settings",
        maxStartsPerMinute: "settings",
        minFreeMemoryMb: "settings",
        runMemoryEstimateMb: "settings",
      },
    };
  }
  const sources = {} as Record<RunLimitKey, RunLimitsSource>;
  for (const key of RUN_LIMIT_KEYS) {
    sources[key] = parseRunLimitValue(env[RUN_LIMITS_ENV_KEYS[key]]) === null ? "default" : "env";
  }
  return { limits: readRunLimitsFromEnv(env), sources };
}

/** A patch over the effective values, the shape that gets stored. */
export function mergeRunLimits(base: RunLimits, patch: RunLimitsPatch): RunLimits {
  return {
    maxConcurrentRuns: patch.maxConcurrentRuns === undefined ? base.maxConcurrentRuns : patch.maxConcurrentRuns,
    maxStartsPerMinute:
      patch.maxStartsPerMinute === undefined ? base.maxStartsPerMinute : patch.maxStartsPerMinute,
    minFreeMemoryMb: patch.minFreeMemoryMb === undefined ? base.minFreeMemoryMb : patch.minFreeMemoryMb,
    runMemoryEstimateMb: patch.runMemoryEstimateMb ?? base.runMemoryEstimateMb,
  };
}