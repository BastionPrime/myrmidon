// Run stall detection settings (MYRMIDON_RUN_STALL_*). See docs/myrmidon/SETTINGS.md.
//
// The feature is a defect fix (CONVENTIONS.md §8): it ships enabled and only an
// explicit off value disables it. The threshold is a deployment value, so the
// default is the neutral 20 minutes the operator's own watchdog script used.

function readInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) return fallback;
  return value;
}

export const RUN_STALL_ENABLED_ENV = "MYRMIDON_RUN_STALL_ENABLED";
export const RUN_STALL_THRESHOLD_SEC_ENV = "MYRMIDON_RUN_STALL_THRESHOLD_SEC";
export const RUN_STALL_CHECK_INTERVAL_SEC_ENV = "MYRMIDON_RUN_STALL_CHECK_INTERVAL_SEC";
export const RUN_STALL_PAGE_SIZE_ENV = "MYRMIDON_RUN_STALL_PAGE_SIZE";

/** 20 minutes: the default the ticket names. */
export const DEFAULT_RUN_STALL_THRESHOLD_SEC = 20 * 60;
export const MIN_RUN_STALL_THRESHOLD_SEC = 60;
export const MAX_RUN_STALL_THRESHOLD_SEC = 24 * 60 * 60;

/**
 * How often the module re-scan is allowed to run. The scheduler queue ticks
 * every 15 s; the scan itself is rate limited to one pass per minute so the
 * whole sweep stays cheap (the ticket asks for a bounded DB scan per tick).
 */
export const DEFAULT_RUN_STALL_CHECK_INTERVAL_SEC = 60;
export const MIN_RUN_STALL_CHECK_INTERVAL_SEC = 15;

/** The scan inspects at most this many runs per pass. */
export const DEFAULT_RUN_STALL_PAGE_SIZE = 50;
export const MAX_RUN_STALL_PAGE_SIZE = 200;

export interface RunStallSettings {
  enabled: boolean;
  /** Silence window after which a run with no recorded progress counts as stalled. */
  thresholdMs: number;
  /** Minimum spacing between two scan passes. */
  checkIntervalMs: number;
  /** Ceiling on runs inspected in one pass. */
  pageSize: number;
}

/**
 * Master switch. Unset or an unrecognized value keeps the fix on: a typo must
 * not silently extinguish it (`MYRMIDON_IDLE_PICKUP_ENABLED` follows the same
 * rule).
 */
export function readRunStallEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[RUN_STALL_ENABLED_ENV]?.trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

export function readRunStallSettings(env: NodeJS.ProcessEnv = process.env): RunStallSettings {
  return {
    enabled: readRunStallEnabled(env),
    thresholdMs:
      readInt(
        env,
        RUN_STALL_THRESHOLD_SEC_ENV,
        DEFAULT_RUN_STALL_THRESHOLD_SEC,
        MIN_RUN_STALL_THRESHOLD_SEC,
        MAX_RUN_STALL_THRESHOLD_SEC,
      ) * 1000,
    checkIntervalMs:
      readInt(
        env,
        RUN_STALL_CHECK_INTERVAL_SEC_ENV,
        DEFAULT_RUN_STALL_CHECK_INTERVAL_SEC,
        MIN_RUN_STALL_CHECK_INTERVAL_SEC,
        Number.MAX_SAFE_INTEGER,
      ) * 1000,
    pageSize: readInt(
      env,
      RUN_STALL_PAGE_SIZE_ENV,
      DEFAULT_RUN_STALL_PAGE_SIZE,
      1,
      MAX_RUN_STALL_PAGE_SIZE,
    ),
  };
}