// myrmidon(BROWSER-CONSOLE): settings and the pure timer rules.
//
// Timers live in pure functions over `now` so tests drive them with fake
// clocks instead of real waits. The idle timer closes the session after N
// minutes without activity (POST /screen/heartbeat with activity=true resets
// it); the hard ceiling closes it after M minutes regardless of activity.
// The warning window is the last 60 seconds before whichever deadline wins.

export const BROWSER_IDLE_TIMEOUT_MIN_ENV = "MYRMIDON_BROWSER_IDLE_TIMEOUT_MIN";
export const BROWSER_MAX_DURATION_MIN_ENV = "MYRMIDON_BROWSER_MAX_DURATION_MIN";

export const DEFAULT_IDLE_TIMEOUT_MIN = 30;
export const DEFAULT_MAX_DURATION_MIN = 120;
/** The auto-close warning shows during the last this-many ms. */
export const AUTO_CLOSE_WARN_MS = 60_000;

export const MIN_IDLE_TIMEOUT_MIN = 1;
export const MAX_IDLE_TIMEOUT_MIN = 24 * 60;
export const MIN_MAX_DURATION_MIN = 5;
export const MAX_MAX_DURATION_MIN = 24 * 60;

export interface BrowserConsoleTimers {
  idleTimeoutMs: number;
  maxDurationMs: number;
}

function readMinutes(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) return fallback;
  return value;
}

export function readBrowserConsoleTimers(env: NodeJS.ProcessEnv = process.env): BrowserConsoleTimers {
  return {
    idleTimeoutMs: readMinutes(env, BROWSER_IDLE_TIMEOUT_MIN_ENV, DEFAULT_IDLE_TIMEOUT_MIN, MIN_IDLE_TIMEOUT_MIN, MAX_IDLE_TIMEOUT_MIN) * 60_000,
    maxDurationMs: readMinutes(env, BROWSER_MAX_DURATION_MIN_ENV, DEFAULT_MAX_DURATION_MIN, MIN_MAX_DURATION_MIN, MAX_MAX_DURATION_MIN) * 60_000,
  };
}

/** The pure deadline computation. Both inputs are epoch ms. */
export interface SessionDeadlines {
  /** Idle deadline: last activity + idleTimeoutMs. */
  idleDeadlineAt: number;
  /** Hard ceiling: open time + maxDurationMs. */
  maxDeadlineAt: number;
  /** The nearer of the two: when the session actually auto-closes. */
  autoCloseAt: number;
  /** When the auto-close warning starts: autoCloseAt - 60s. */
  warnAt: number;
}

export function sessionDeadlines(input: { openedAt: number; lastActivityAt: number; timers: BrowserConsoleTimers }): SessionDeadlines {
  const idleDeadlineAt = input.lastActivityAt + input.timers.idleTimeoutMs;
  const maxDeadlineAt = input.openedAt + input.timers.maxDurationMs;
  const autoCloseAt = Math.min(idleDeadlineAt, maxDeadlineAt);
  return { idleDeadlineAt, maxDeadlineAt, autoCloseAt, warnAt: autoCloseAt - AUTO_CLOSE_WARN_MS };
}

/** Why a session auto-closes at `now`: idle ran out, or the ceiling hit. */
export function autoCloseReason(input: { deadlines: SessionDeadlines; now: number }): "idle_timeout" | "max_duration" | null {
  if (input.now < input.deadlines.autoCloseAt) return null;
  return input.deadlines.maxDeadlineAt <= input.deadlines.idleDeadlineAt ? "max_duration" : "idle_timeout";
}
