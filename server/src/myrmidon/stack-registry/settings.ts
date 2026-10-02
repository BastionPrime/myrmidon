// Stack registry (SUA, part B) settings. See docs/myrmidon/SETTINGS.md.

export const STACK_CHECK_INTERVAL_ENV = "MYRMIDON_STACK_CHECK_INTERVAL_SEC";

/** Never hammer the release sources: an explicit interval below this is lifted to it. */
export const STACK_CHECK_MIN_INTERVAL_SEC = 60;

/**
 * How often the scheduled release check runs, in seconds. Zero (the default) or
 * unset means the sweep is off: the board does not touch the network until an
 * operator enables it. An invalid value falls back to off — a typo must not
 * silently start a daily network call.
 */
export function readStackCheckIntervalSec(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[STACK_CHECK_INTERVAL_ENV]?.trim();
  if (!raw) return 0;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return 0;
  if (value === 0) return 0;
  return Math.max(value, STACK_CHECK_MIN_INTERVAL_SEC);
}