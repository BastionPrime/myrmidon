import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decideCatchUp,
  decideFirstTickDelayMs,
  findLatestBackupAgeMs,
  isWithinBackupWindow,
  msUntilWindowEnd,
  readBackupCatchUpSettings,
  startBackupCatchUp,
  windowShiftForTick,
  type BackupWindow,
} from "./backup-catch-up.js";

const HOUR = 3_600_000;
const MINUTE = 60_000;
const INTERVAL_6H = 360;
const WINDOW: BackupWindow = { timezone: "UTC", startMinuteOfDay: 60, endMinuteOfDay: 75 }; // 01:00-01:15 UTC
const WRAP_WINDOW: BackupWindow = { timezone: "UTC", startMinuteOfDay: 23 * 60 + 50, endMinuteOfDay: 10 };
const at = (iso: string) => new Date(iso);

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function makeBackupDir(backups: Array<{ name: string; ageMs: number }>, now: Date): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myrmidon-backup-catch-up-"));
  dirs.push(dir);
  for (const backup of backups) {
    const file = path.join(dir, backup.name);
    fs.writeFileSync(file, "backup");
    const mtime = new Date(now.getTime() - backup.ageMs);
    fs.utimesSync(file, mtime, mtime);
  }
  return dir;
}

describe("readBackupCatchUpSettings", () => {
  it("is disabled when the setting is unset or empty", () => {
    expect(readBackupCatchUpSettings({})).toEqual({ enabled: false });
    expect(readBackupCatchUpSettings({ MYRMIDON_DB_BACKUP_CATCHUP_WINDOW: "  " })).toEqual({ enabled: false });
  });

  it("enables catch-up without a window for 'none'", () => {
    expect(readBackupCatchUpSettings({ MYRMIDON_DB_BACKUP_CATCHUP_WINDOW: "none" })).toEqual({
      enabled: true,
      window: null,
    });
  });

  it("parses a zone and a daily window", () => {
    expect(readBackupCatchUpSettings({ MYRMIDON_DB_BACKUP_CATCHUP_WINDOW: "UTC 01:00-01:15" })).toEqual({
      enabled: true,
      window: WINDOW,
    });
    expect(
      readBackupCatchUpSettings({ MYRMIDON_DB_BACKUP_CATCHUP_WINDOW: "America/New_York 23:50 - 0:10" }),
    ).toEqual({
      enabled: true,
      window: { timezone: "America/New_York", startMinuteOfDay: 23 * 60 + 50, endMinuteOfDay: 10 },
    });
  });

  it("disables catch-up and reports an invalid value", () => {
    for (const value of ["01:00-01:15", "UTC 25:00-01:00", "UTC 01:00", "Not/AZone 01:00-01:15"]) {
      expect(readBackupCatchUpSettings({ MYRMIDON_DB_BACKUP_CATCHUP_WINDOW: value })).toEqual({
        enabled: false,
        invalidValue: value,
      });
    }
  });
});

describe("findLatestBackupAgeMs", () => {
  const now = at("2026-09-01T12:00:00Z");

  it("returns null for a missing directory or no dumps", () => {
    expect(findLatestBackupAgeMs(path.join(os.tmpdir(), "myrmidon-missing-dir"), now.getTime())).toBeNull();
    const dir = makeBackupDir([{ name: "notes.txt", ageMs: HOUR }], now);
    expect(findLatestBackupAgeMs(dir, now.getTime())).toBeNull();
  });

  it("returns the age of the newest dump", () => {
    const dir = makeBackupDir(
      [
        { name: "paperclip-a.sql.gz", ageMs: 8 * HOUR },
        { name: "paperclip-b.sql.gz", ageMs: 2 * HOUR },
      ],
      now,
    );
    expect(findLatestBackupAgeMs(dir, now.getTime())).toBe(2 * HOUR);
  });
});

describe("backup window", () => {
  it("includes the start and excludes the end", () => {
    expect(isWithinBackupWindow(at("2026-09-01T00:59:59Z"), WINDOW)).toBe(false);
    expect(isWithinBackupWindow(at("2026-09-01T01:00:00Z"), WINDOW)).toBe(true);
    expect(isWithinBackupWindow(at("2026-09-01T01:14:59Z"), WINDOW)).toBe(true);
    expect(isWithinBackupWindow(at("2026-09-01T01:15:00Z"), WINDOW)).toBe(false);
  });

  it("handles a window across midnight and no window", () => {
    expect(isWithinBackupWindow(at("2026-09-01T23:55:00Z"), WRAP_WINDOW)).toBe(true);
    expect(isWithinBackupWindow(at("2026-09-02T00:05:00Z"), WRAP_WINDOW)).toBe(true);
    expect(isWithinBackupWindow(at("2026-09-02T00:10:00Z"), WRAP_WINDOW)).toBe(false);
    expect(isWithinBackupWindow(at("2026-09-01T01:05:00Z"), null)).toBe(false);
  });

  it("measures the time left in the window", () => {
    expect(msUntilWindowEnd(at("2026-09-01T01:05:00Z"), WINDOW)).toBe(10 * MINUTE);
    expect(msUntilWindowEnd(at("2026-09-01T01:14:30Z"), WINDOW)).toBe(30_000);
    expect(msUntilWindowEnd(at("2026-09-01T23:55:00Z"), WRAP_WINDOW)).toBe(15 * MINUTE);
    expect(msUntilWindowEnd(at("2026-09-01T02:00:00Z"), WINDOW)).toBe(0);
  });

  it("shifts a tick that lands in the window to its end", () => {
    const now = at("2026-09-01T00:00:00Z");
    expect(windowShiftForTick(now, 65 * MINUTE, WINDOW)).toBe(10 * MINUTE);
    expect(windowShiftForTick(now, 75 * MINUTE, WINDOW)).toBe(0);
    expect(windowShiftForTick(now, 30 * MINUTE, WINDOW)).toBe(0);
  });
});

describe("decideCatchUp", () => {
  const now = at("2026-09-01T12:00:00Z");
  const base = { intervalMinutes: INTERVAL_6H, inFlight: false, now, window: WINDOW };

  it("skips a fresh backup and runs for a stale or missing one", () => {
    expect(decideCatchUp({ ...base, ageMs: 2 * HOUR })).toMatchObject({ runBackupNow: false, reason: "fresh_backup" });
    expect(decideCatchUp({ ...base, ageMs: 6 * HOUR - 1 })).toMatchObject({ runBackupNow: false });
    expect(decideCatchUp({ ...base, ageMs: 6 * HOUR })).toEqual({ runBackupNow: true, reason: "stale", delayMs: 0 });
    expect(decideCatchUp({ ...base, ageMs: null })).toEqual({ runBackupNow: true, reason: "no_backup", delayMs: 0 });
  });

  it("defers to the end of the window and skips while a backup is in flight", () => {
    expect(decideCatchUp({ ...base, ageMs: 8 * HOUR, now: at("2026-09-01T01:05:00Z") })).toEqual({
      runBackupNow: true,
      reason: "window_deferred",
      delayMs: 10 * MINUTE,
    });
    expect(decideCatchUp({ ...base, ageMs: 8 * HOUR, inFlight: true })).toMatchObject({
      runBackupNow: false,
      reason: "in_flight",
    });
  });
});

describe("decideFirstTickDelayMs", () => {
  const now = at("2026-09-01T12:00:00Z");
  const base = { intervalMinutes: INTERVAL_6H, now, window: WINDOW };

  it("anchors the first tick to the newest dump", () => {
    expect(decideFirstTickDelayMs({ ...base, ageMs: 3 * HOUR + 16 * MINUTE })).toEqual({
      delayMs: 2 * HOUR + 44 * MINUTE,
      reason: "anchored",
    });
  });

  it("waits a full interval when the catch-up refreshes the dump", () => {
    expect(decideFirstTickDelayMs({ ...base, ageMs: 7 * HOUR })).toEqual({ delayMs: 6 * HOUR, reason: "catchup_anchor" });
    expect(decideFirstTickDelayMs({ ...base, ageMs: null })).toEqual({ delayMs: 6 * HOUR, reason: "no_backup_anchor" });
  });

  it("moves a tick out of the window", () => {
    // 20:00 + (6h - 55min) = 01:05 next day, inside 01:00-01:15: moved to 01:15.
    const decision = decideFirstTickDelayMs({ ...base, now: at("2026-09-01T20:00:00Z"), ageMs: 55 * MINUTE });
    expect(decision).toEqual({ delayMs: 5 * HOUR + 15 * MINUTE, reason: "window_deferred" });
  });
});

describe("startBackupCatchUp", () => {
  const now = at("2026-09-01T12:00:00Z");
  const logger = { info: vi.fn(), warn: vi.fn() };

  function fakeTimers() {
    const timeouts: Array<{ fn: () => void; ms: number }> = [];
    const intervals: Array<{ fn: () => void; ms: number }> = [];
    return {
      timeouts,
      intervals,
      timers: {
        setTimeout: (fn: () => void, ms: number) => timeouts.push({ fn, ms }),
        setInterval: (fn: () => void, ms: number) => intervals.push({ fn, ms }),
      },
    };
  }

  it("runs a missed backup right away and schedules the cadence", () => {
    const dir = makeBackupDir([{ name: "paperclip-a.sql.gz", ageMs: 14 * HOUR }], now);
    const runBackup = vi.fn().mockResolvedValue(undefined);
    const fake = fakeTimers();

    const result = startBackupCatchUp({
      settings: { enabled: true, window: WINDOW },
      backupDir: dir,
      intervalMinutes: INTERVAL_6H,
      isInFlight: () => false,
      runBackup,
      logger,
      now,
      timers: fake.timers,
    });

    expect(result.catchUp).toMatchObject({ runBackupNow: true, reason: "stale" });
    expect(runBackup).toHaveBeenCalledTimes(1);
    expect(fake.timeouts.map((timeout) => timeout.ms)).toEqual([6 * HOUR]);
    fake.timeouts[0]!.fn();
    expect(fake.intervals.map((interval) => interval.ms)).toEqual([6 * HOUR]);
    expect(runBackup).toHaveBeenCalledTimes(2);
  });

  it("does not run a backup when the newest dump is fresh", () => {
    const dir = makeBackupDir([{ name: "paperclip-a.sql.gz", ageMs: 2 * HOUR }], now);
    const runBackup = vi.fn().mockResolvedValue(undefined);
    const fake = fakeTimers();

    startBackupCatchUp({
      settings: { enabled: true, window: null },
      backupDir: dir,
      intervalMinutes: INTERVAL_6H,
      isInFlight: () => false,
      runBackup,
      logger,
      now,
      timers: fake.timers,
    });

    expect(runBackup).not.toHaveBeenCalled();
    expect(fake.timeouts.map((timeout) => timeout.ms)).toEqual([4 * HOUR]);
  });
});
