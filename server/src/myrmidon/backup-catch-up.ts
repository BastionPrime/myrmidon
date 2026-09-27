import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Database backup catch-up (P11).
 *
 * The vendor schedules the automatic database backup with a plain setInterval
 * counted from process start, so every restart can swallow up to one full
 * interval of coverage. With catch-up enabled:
 *
 * - after startup the server reads the backup directory once; when the newest
 *   dump is missing or older than the interval, it runs a backup right away;
 * - the first scheduled tick is anchored to the newest dump
 *   (interval - age) instead of process start;
 * - neither the catch-up nor the first tick runs inside an optional external
 *   backup window, so they do not overlap an external dump job; they wait for
 *   the end of the window instead.
 *
 * Setting: MYRMIDON_DB_BACKUP_CATCHUP_WINDOW
 *   unset or empty       -> catch-up disabled (vendor behaviour)
 *   "none"               -> catch-up enabled, no window to avoid
 *   "<IANA zone> HH:MM-HH:MM", e.g. "UTC 01:00-01:15"
 *                        -> catch-up enabled, avoiding that daily window
 * An invalid value disables catch-up and is reported by the caller.
 */

export const BACKUP_CATCHUP_WINDOW_ENV = "MYRMIDON_DB_BACKUP_CATCHUP_WINDOW";

/** Upper bound for shifting the first tick out of the window. */
const MAX_WINDOW_SHIFT_MS = 60 * 60 * 1000;
const MINUTES_PER_DAY = 24 * 60;

export type BackupWindow = {
  timezone: string;
  startMinuteOfDay: number;
  endMinuteOfDay: number;
};

export type BackupCatchUpSettings =
  | { enabled: false; invalidValue?: string }
  | { enabled: true; window: BackupWindow | null };

const WINDOW_PATTERN = /^(\S+)\s+(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/;

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

function minuteOfDay(hours: string, minutes: string): number | null {
  const h = Number(hours);
  const m = Number(minutes);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h > 23 || m > 59) return null;
  return h * 60 + m;
}

export function readBackupCatchUpSettings(env: NodeJS.ProcessEnv = process.env): BackupCatchUpSettings {
  const raw = env[BACKUP_CATCHUP_WINDOW_ENV]?.trim();
  if (!raw) return { enabled: false };
  if (raw.toLowerCase() === "none") return { enabled: true, window: null };
  const match = WINDOW_PATTERN.exec(raw);
  if (!match) return { enabled: false, invalidValue: raw };
  const [, timezone, startH, startM, endH, endM] = match;
  const startMinuteOfDay = minuteOfDay(startH!, startM!);
  const endMinuteOfDay = minuteOfDay(endH!, endM!);
  if (startMinuteOfDay === null || endMinuteOfDay === null || !isValidTimezone(timezone!)) {
    return { enabled: false, invalidValue: raw };
  }
  return { enabled: true, window: { timezone: timezone!, startMinuteOfDay, endMinuteOfDay } };
}

export function formatBackupWindow(window: BackupWindow | null): string {
  if (!window) return "none";
  const hhmm = (value: number) =>
    `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
  return `${window.timezone} ${hhmm(window.startMinuteOfDay)}-${hhmm(window.endMinuteOfDay)}`;
}

/**
 * Age in milliseconds of the newest `*.sql.gz` in the backup directory, or null
 * when there is none. Read errors return null: catch-up must never break startup.
 */
export function findLatestBackupAgeMs(backupDir: string, nowMs: number = Date.now()): number | null {
  try {
    if (!existsSync(backupDir)) return null;
    let newestMtimeMs: number | null = null;
    for (const name of readdirSync(backupDir)) {
      if (!name.endsWith(".sql.gz")) continue;
      const { mtimeMs } = statSync(join(backupDir, name));
      if (newestMtimeMs === null || mtimeMs > newestMtimeMs) newestMtimeMs = mtimeMs;
    }
    return newestMtimeMs === null ? null : nowMs - newestMtimeMs;
  } catch {
    return null;
  }
}

function minuteOfDayInZone(now: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value) % 24;
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  return hour * 60 + minute;
}

/** True when `now` falls inside the daily window; the end minute is exclusive. */
export function isWithinBackupWindow(now: Date, window: BackupWindow | null): boolean {
  if (!window || window.startMinuteOfDay === window.endMinuteOfDay) return false;
  let minute: number;
  try {
    minute = minuteOfDayInZone(now, window.timezone);
  } catch {
    return false;
  }
  if (window.startMinuteOfDay < window.endMinuteOfDay) {
    return minute >= window.startMinuteOfDay && minute < window.endMinuteOfDay;
  }
  // The window wraps around midnight.
  return minute >= window.startMinuteOfDay || minute < window.endMinuteOfDay;
}

/** Milliseconds from `now` until the end of the current window; 0 outside it. */
export function msUntilWindowEnd(now: Date, window: BackupWindow | null): number {
  if (!window || !isWithinBackupWindow(now, window)) return 0;
  const minute = minuteOfDayInZone(now, window.timezone);
  const remainingMinutes =
    (window.endMinuteOfDay - minute + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const secondsIntoMinute = now.getUTCSeconds() * 1000 + now.getUTCMilliseconds();
  return Math.max(0, remainingMinutes * 60 * 1000 - secondsIntoMinute);
}

/** Extra delay that moves a tick planned `rawDelayMs` from now out of the window. */
export function windowShiftForTick(now: Date, rawDelayMs: number, window: BackupWindow | null): number {
  const tickAt = new Date(now.getTime() + Math.max(0, rawDelayMs));
  if (!isWithinBackupWindow(tickAt, window)) return 0;
  return Math.min(msUntilWindowEnd(tickAt, window), MAX_WINDOW_SHIFT_MS);
}

export type CatchUpDecision = {
  runBackupNow: boolean;
  reason: "in_flight" | "fresh_backup" | "no_backup" | "stale" | "window_deferred";
  delayMs: number;
};

export function decideCatchUp(input: {
  ageMs: number | null;
  intervalMinutes: number;
  inFlight: boolean;
  now: Date;
  window: BackupWindow | null;
}): CatchUpDecision {
  const intervalMs = Math.max(1, Math.trunc(input.intervalMinutes)) * 60 * 1000;
  if (input.inFlight) return { runBackupNow: false, reason: "in_flight", delayMs: 0 };
  if (input.ageMs !== null && input.ageMs < intervalMs) {
    return { runBackupNow: false, reason: "fresh_backup", delayMs: 0 };
  }
  if (isWithinBackupWindow(input.now, input.window)) {
    return { runBackupNow: true, reason: "window_deferred", delayMs: msUntilWindowEnd(input.now, input.window) };
  }
  return { runBackupNow: true, reason: input.ageMs === null ? "no_backup" : "stale", delayMs: 0 };
}

export type FirstTickDecision = {
  delayMs: number;
  reason: "anchored" | "catchup_anchor" | "no_backup_anchor" | "window_deferred";
};

/**
 * Delay of the first scheduled tick: interval - age of the newest dump. When
 * there is no dump or it is overdue, the catch-up refreshes it now, so the tick
 * comes one full interval later.
 */
export function decideFirstTickDelayMs(input: {
  ageMs: number | null;
  intervalMinutes: number;
  now: Date;
  window: BackupWindow | null;
}): FirstTickDecision {
  const intervalMs = Math.max(1, Math.trunc(input.intervalMinutes)) * 60 * 1000;
  let rawDelayMs = intervalMs;
  let reason: FirstTickDecision["reason"] = "no_backup_anchor";
  if (input.ageMs !== null && input.ageMs >= intervalMs) {
    reason = "catchup_anchor";
  } else if (input.ageMs !== null) {
    rawDelayMs = Math.max(0, intervalMs - input.ageMs);
    reason = "anchored";
  }
  const shiftMs = windowShiftForTick(input.now, rawDelayMs, input.window);
  return shiftMs > 0 ? { delayMs: rawDelayMs + shiftMs, reason: "window_deferred" } : { delayMs: rawDelayMs, reason };
}

type BackupCatchUpLogger = {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
};

export type BackupCatchUpTimers = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  setInterval: (fn: () => void, ms: number) => unknown;
};

/**
 * Runs once after startup when catch-up is enabled: anchors the scheduled
 * cadence to the newest dump and catches up a missed slot. Any failure falls
 * back to the vendor cadence (first tick one interval from now).
 */
export function startBackupCatchUp(input: {
  settings: Extract<BackupCatchUpSettings, { enabled: true }>;
  backupDir: string;
  intervalMinutes: number;
  isInFlight: () => boolean;
  runBackup: () => Promise<unknown>;
  logger: BackupCatchUpLogger;
  now?: Date;
  timers?: BackupCatchUpTimers;
}): { firstTick: FirstTickDecision; catchUp: CatchUpDecision | null } {
  const timers = input.timers ?? { setTimeout, setInterval };
  const intervalMs = Math.max(1, Math.trunc(input.intervalMinutes)) * 60 * 1000;
  const runBackup = () => {
    void input.runBackup().catch(() => {
      // The backup runner logs its own failures.
    });
  };
  const startCadence = (delayMs: number) => {
    timers.setTimeout(() => {
      timers.setInterval(runBackup, intervalMs);
      runBackup();
    }, delayMs);
  };

  try {
    const now = input.now ?? new Date();
    const window = input.settings.window;
    const ageMs = findLatestBackupAgeMs(input.backupDir, now.getTime());
    const firstTick = decideFirstTickDelayMs({ ageMs, intervalMinutes: input.intervalMinutes, now, window });
    startCadence(firstTick.delayMs);
    const catchUp = decideCatchUp({
      ageMs,
      intervalMinutes: input.intervalMinutes,
      inFlight: input.isInFlight(),
      now,
      window,
    });
    input.logger.info(
      {
        latestBackupAgeMs: ageMs,
        intervalMinutes: input.intervalMinutes,
        firstTickDelayMs: firstTick.delayMs,
        firstTickReason: firstTick.reason,
        catchUpReason: catchUp.reason,
        catchUpDelayMs: catchUp.delayMs,
        window: formatBackupWindow(window),
      },
      "Database backup catch-up check",
    );
    if (catchUp.runBackupNow) {
      if (catchUp.delayMs > 0) {
        input.logger.warn(
          { delayMs: catchUp.delayMs, window: formatBackupWindow(window) },
          "Database backup catch-up deferred until the external backup window ends",
        );
        timers.setTimeout(runBackup, catchUp.delayMs);
      } else {
        runBackup();
      }
    }
    return { firstTick, catchUp };
  } catch {
    startCadence(intervalMs);
    input.logger.warn({ errorKind: "catch_up_check_failed" }, "Database backup catch-up check failed; using the regular cadence");
    return { firstTick: { delayMs: intervalMs, reason: "no_backup_anchor" }, catchUp: null };
  }
}
