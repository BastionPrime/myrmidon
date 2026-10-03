// Stale-block watchdog settings (MYRMIDON_STALE_BLOCK_*). See docs/myrmidon/SETTINGS.md.
//
// myrmidon(STALE-BLOCK): the sweep is a NEW behavior that changes how blocked
// tasks leave `blocked` without a human: unlike the defect-fix sweeps it does
// not ship enabled. The operator opts in per instance with
// MYRMIDON_STALE_BLOCK_ENABLED=1, because un-blocking work automatically is a
// routing decision, not a defect repair. The interval is a deployment value
// with the neutral default of 300 s (5 minutes) the ticket names.

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

export const STALE_BLOCK_ENABLED_ENV = "MYRMIDON_STALE_BLOCK_ENABLED";
export const STALE_BLOCK_INTERVAL_SEC_ENV = "MYRMIDON_STALE_BLOCK_INTERVAL_SEC";

/** 5 minutes: the default the ticket names. */
export const DEFAULT_STALE_BLOCK_INTERVAL_SEC = 300;
export const MIN_STALE_BLOCK_INTERVAL_SEC = 15;
export const MAX_STALE_BLOCK_INTERVAL_SEC = 24 * 60 * 60;

/** The sweep inspects at most this many blocked tasks per pass. */
export const DEFAULT_STALE_BLOCK_PAGE_SIZE = 50;

export interface StaleBlockSettings {
  enabled: boolean;
  /** Minimum spacing between two sweep passes. */
  intervalMs: number;
  /** Ceiling on blocked tasks inspected in one pass. */
  pageSize: number;
}

/**
 * Master switch. Unset or any unrecognized value keeps the sweep OFF: this is
 * an opt-in feature (default 0), so a typo must not silently enable it. Only
 * the explicit on spellings (`1`, `true`, `yes`, `on`) turn it on.
 */
export function readStaleBlockEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[STALE_BLOCK_ENABLED_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export function readStaleBlockSettings(env: NodeJS.ProcessEnv = process.env): StaleBlockSettings {
  return {
    enabled: readStaleBlockEnabled(env),
    intervalMs:
      readInt(
        env,
        STALE_BLOCK_INTERVAL_SEC_ENV,
        DEFAULT_STALE_BLOCK_INTERVAL_SEC,
        MIN_STALE_BLOCK_INTERVAL_SEC,
        MAX_STALE_BLOCK_INTERVAL_SEC,
      ) * 1000,
    pageSize: DEFAULT_STALE_BLOCK_PAGE_SIZE,
  };
}
