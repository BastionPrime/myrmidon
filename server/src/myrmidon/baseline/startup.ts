// server/src/myrmidon/baseline/startup.ts
//
// myrmidon(1.6-BASELINE): the periodic snapshot job. server/src/index.ts gets
// one marked start call next to startLitellmCostSweep and one at shutdown;
// everything else lives here.
//
// Off by default: with MYRMIDON_BASELINE_INTERVAL_SEC unset there is no timer
// and no query. When it is set, every tick recomputes the last 14 days for
// each company and appends one frozen row to baseline_metric_snapshots. A
// failure of one company is logged and does not stop the others; a tick whose
// previous run is still going is skipped instead of stacking.

import type { Db } from "@paperclipai/db";
import { baselineMetricSnapshots, companies } from "@paperclipai/db";
import { isNotNull } from "drizzle-orm";
import { logger } from "../../middleware/logger.js";
import { computeBaselineMetrics, type BaselineMetricsResponse } from "./service.js";
import type { BaselineWindow } from "./metrics.js";

export const BASELINE_INTERVAL_ENV = "MYRMIDON_BASELINE_INTERVAL_SEC";
export const BASELINE_WINDOW_DAYS = 14;

const DEFAULT_INTERVAL_SEC = 86_400;
const MIN_INTERVAL_SEC = 60;
const MAX_INTERVAL_SEC = 604_800;

export interface BaselineSettings {
  enabled: boolean;
  intervalSec: number;
  intervalMs: number;
}

/**
 * The setting is the switch: unset (or empty) is off. A set-but-unreadable or
 * out-of-range value keeps the job on with the daily default — a typo should
 * not silently turn a deliberate opt-in back off.
 */
export function readBaselineSettings(env: NodeJS.ProcessEnv): BaselineSettings {
  const raw = env[BASELINE_INTERVAL_ENV];
  if (raw === undefined || raw.trim() === "") {
    return { enabled: false, intervalSec: DEFAULT_INTERVAL_SEC, intervalMs: DEFAULT_INTERVAL_SEC * 1000 };
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < MIN_INTERVAL_SEC || parsed > MAX_INTERVAL_SEC) {
    return { enabled: true, intervalSec: DEFAULT_INTERVAL_SEC, intervalMs: DEFAULT_INTERVAL_SEC * 1000 };
  }
  return { enabled: true, intervalSec: parsed, intervalMs: parsed * 1000 };
}

/** The window a tick freezes: the last BASELINE_WINDOW_DAYS days up to `now`. */
export function snapshotWindow(now: Date): BaselineWindow {
  return { from: new Date(now.getTime() - BASELINE_WINDOW_DAYS * 86_400_000), to: now };
}

export interface BaselineSnapshotRow {
  companyId: string;
  windowFrom: Date;
  windowTo: Date;
  generatedAt: Date;
  payload: Record<string, unknown>;
}

/** Appends one frozen row. */
export async function writeBaselineSnapshot(db: Db, row: BaselineSnapshotRow): Promise<void> {
  await db.insert(baselineMetricSnapshots).values({
    companyId: row.companyId,
    windowFrom: row.windowFrom,
    windowTo: row.windowTo,
    generatedAt: row.generatedAt,
    payload: row.payload,
  });
}

export interface BaselineJobPorts {
  listCompanyIds(db: Db): Promise<string[]>;
  compute(db: Db, companyId: string, window: BaselineWindow, now: Date): Promise<BaselineMetricsResponse>;
  writeSnapshot(db: Db, row: BaselineSnapshotRow): Promise<void>;
  now(): Date;
  log: {
    info(fields: object, message: string): void;
    warn(fields: object, message: string): void;
    error(fields: object, message: string): void;
  };
}

export const defaultBaselinePorts: BaselineJobPorts = {
  async listCompanyIds(db) {
    const rows = await db.select({ id: companies.id }).from(companies).where(isNotNull(companies.id));
    return rows.map((row) => row.id);
  },
  compute: (db, companyId, window, now) => computeBaselineMetrics(db, companyId, window, now),
  writeSnapshot: writeBaselineSnapshot,
  now: () => new Date(),
  log: logger,
};

/** One pass: compute and freeze the window for every company. */
export async function runBaselineSnapshot(
  db: Db,
  opts: { env?: NodeJS.ProcessEnv; ports?: Partial<BaselineJobPorts> } = {},
): Promise<{ companies: number; written: number }> {
  const env = opts.env ?? process.env;
  const settings = readBaselineSettings(env);
  if (!settings.enabled) return { companies: 0, written: 0 };

  const ports: BaselineJobPorts = { ...defaultBaselinePorts, ...opts.ports };
  const now = ports.now();
  const window = snapshotWindow(now);

  const companyIds = await ports.listCompanyIds(db);
  let written = 0;
  for (const companyId of companyIds) {
    try {
      const payload = await ports.compute(db, companyId, window, now);
      await ports.writeSnapshot(db, {
        companyId,
        windowFrom: window.from,
        windowTo: window.to,
        generatedAt: now,
        payload: payload as unknown as Record<string, unknown>,
      });
      written += 1;
    } catch (err) {
      ports.log.warn({ err, companyId }, "baseline snapshot failed for one company");
    }
  }
  return { companies: companyIds.length, written };
}

let stopRunning: (() => void) | null = null;

/** Starts the snapshot job; returns the stop function. A no-op when disabled. */
export function startBaselineSnapshots(
  db: Db,
  opts: { env?: NodeJS.ProcessEnv; ports?: Partial<BaselineJobPorts> } = {},
): () => void {
  const env = opts.env ?? process.env;
  const settings = readBaselineSettings(env);
  if (!settings.enabled) return () => {};
  stopBaselineSnapshots();

  let running = false;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await runBaselineSnapshot(db, { env, ports: opts.ports });
    } catch (err) {
      (opts.ports?.log ?? logger).error({ err }, "baseline snapshot tick failed");
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, settings.intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  void tick();

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    if (stopRunning === stop) stopRunning = null;
  };
  stopRunning = stop;
  return stop;
}

/** Stops the job started by `startBaselineSnapshots`; a no-op when none runs. */
export function stopBaselineSnapshots(): void {
  stopRunning?.();
}