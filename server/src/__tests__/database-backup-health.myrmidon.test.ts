import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import {
  inspectDatabaseBackupHealth,
  type DatabaseBackupHealthWarning,
} from "../services/database-backup-health.js";
import { resolveBackupSlotGapThresholdHours } from "../myrmidon/backup-slot-gap.js";
import { healthRoutes } from "../routes/health.js";

// P11: a missed scheduled backup slot is visible in /api/health.
const CADENCE_6H_MINUTES = 360;
const MAX_AGE_HOURS = 26;
const NOW = new Date("2026-09-01T18:30:00.000Z");

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function makeBackupDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myrmidon-db-backup-health-"));
  dirs.push(dir);
  return dir;
}

function writeBackup(dir: string, name: string, ageHours: number) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, "backup");
  const mtime = new Date(NOW.getTime() - ageHours * 3_600_000);
  fs.utimesSync(file, mtime, mtime);
}

const codes = (warnings: DatabaseBackupHealthWarning[]) => warnings.map((warning) => warning.code);

function inspect(dir: string, intervalMinutes?: number) {
  return inspectDatabaseBackupHealth({
    enabled: true,
    backupDir: dir,
    maxAgeHours: MAX_AGE_HOURS,
    intervalMinutes,
    now: NOW,
  });
}

describe("resolveBackupSlotGapThresholdHours", () => {
  it("uses 1.5x the cadence, with a 2h floor above short cadences", () => {
    expect(resolveBackupSlotGapThresholdHours(360)).toBe(9);
    expect(resolveBackupSlotGapThresholdHours(60)).toBe(3);
    expect(resolveBackupSlotGapThresholdHours(120)).toBe(4);
  });
});

describe("inspectDatabaseBackupHealth missed-slot warning", () => {
  it("stays ok through a healthy cycle", () => {
    const dir = makeBackupDir();
    writeBackup(dir, "paperclip-a.sql.gz", 5.9);
    const status = inspect(dir, CADENCE_6H_MINUTES);
    expect(status.status).toBe("ok");
    expect(status.gapThresholdHours).toBe(9);
  });

  it("warns when a slot was skipped, long before the stale threshold", () => {
    const dir = makeBackupDir();
    writeBackup(dir, "paperclip-a.sql.gz", 14.3);
    const status = inspect(dir, CADENCE_6H_MINUTES);
    expect(status.status).toBe("warning");
    expect(codes(status.warnings)).toEqual(["database_backup_slot_missed"]);
    expect(status.warnings[0]?.message).toContain("14.3h");
  });

  it("stays ok without a declared cadence", () => {
    const dir = makeBackupDir();
    writeBackup(dir, "paperclip-a.sql.gz", 14.3);
    const status = inspect(dir);
    expect(status.status).toBe("ok");
    expect(status.gapThresholdHours).toBeNull();
  });

  it("fires only past the threshold, not on it", () => {
    const dir = makeBackupDir();
    writeBackup(dir, "paperclip-a.sql.gz", 9);
    expect(inspect(dir, CADENCE_6H_MINUTES).status).toBe("ok");
  });

  it("reports a multi-day outage once, as stale", () => {
    const dir = makeBackupDir();
    writeBackup(dir, "paperclip-a.sql.gz", 40);
    expect(codes(inspect(dir, CADENCE_6H_MINUTES).warnings)).toEqual(["database_backup_stale"]);
  });

  it("keeps reporting an empty backup directory as missing", () => {
    const dir = makeBackupDir();
    expect(codes(inspect(dir, CADENCE_6H_MINUTES).warnings)).toEqual(["database_backup_missing"]);
  });
});

describe("GET /api/health shows the missed slot", () => {
  function createApp(dir: string) {
    const db = { execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]) } as unknown as Db;
    const app = express();
    app.use(
      "/health",
      healthRoutes(db, {
        deploymentMode: "local_trusted",
        deploymentExposure: "private",
        authReady: true,
        companyDeletionEnabled: true,
        databaseBackupHealth: {
          enabled: true,
          backupDir: dir,
          maxAgeHours: MAX_AGE_HOURS,
          intervalMinutes: CADENCE_6H_MINUTES,
          now: NOW,
        },
      }),
    );
    return app;
  }

  it("reports the gap in the databaseBackup block and in warnings", async () => {
    const dir = makeBackupDir();
    writeBackup(dir, "paperclip-a.sql.gz", 14.3);

    const res = await request(createApp(dir)).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.databaseBackup).toMatchObject({
      enabled: true,
      status: "warning",
      maxAgeHours: MAX_AGE_HOURS,
      gapThresholdHours: 9,
    });
    expect(res.body.databaseBackup.warnings).toEqual([
      { code: "database_backup_slot_missed", message: expect.stringContaining("14.3h") },
    ]);
    expect(res.body.warnings).toEqual(res.body.databaseBackup.warnings);
  });
});
