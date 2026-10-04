import type { Db } from "@paperclipai/db";
import { resolveHostDiskSettings, type HostDiskSettings } from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { instanceSettingsService, logActivity } from "../../services/index.js";
import { hostDiskRoutes } from "./routes.js";
import { hostDiskService, type HostDiskService } from "./service.js";
import { createHostDiskSweep, type HostDiskSweep } from "./sweep.js";
import { type HostDiskSweepResult } from "./state.js";

/**
 * Entry point of the host disk signal (myrmidon BOT-DISK, part E).
 *
 * One runtime per server process, created on demand and shared by the routes
 * mounted in `server/src/app.ts`, the scheduler step called from the tick in
 * `server/src/index.ts` and the attention feed: they must see the same sweep
 * state. Startup does nothing; the threshold is read at the top of every
 * sweep, so a restart keeps whatever the settings row holds.
 *
 * The activity log anchors the signal interval: the newest
 * `host.disk_threshold_exceeded` line decides when the next one is due, the
 * same anchor rule the workspace quota totals use.
 */

export { hostDiskService, type HostDiskGeneralSettings } from "./service.js";
export type { HostDiskService } from "./service.js";
export { createHostDiskSweep } from "./sweep.js";
export type { HostDiskSweep } from "./sweep.js";
export { readHostDiskUsage, measureHostDiskConsumer } from "./measure.js";
export type { HostDiskSweepResult } from "./state.js";

export interface HostDiskRuntime {
  sweep: HostDiskSweep;
  service: HostDiskService;
  /** Run one sweep and hand the work to the scheduler's tracker. */
  run(track: (work: Promise<unknown>) => void): void;
}

export interface HostDiskRuntimeOptions {
  env?: Record<string, string | undefined>;
}

/**
 * The threshold the sweep will use, from the stored settings row with the
 * environment as the first-start default. Unwraps the resolver's wrapper, so
 * a caller cannot hand the sweep `{ settings }` where it expects
 * `HostDiskSettings` (the wrapper bug `resolveSweepLimits` in
 * workspace-hygiene documents).
 */
export async function resolveSweepSettings(
  settings: { getGeneral(): Promise<{ hostDisk?: unknown }> },
  env: Record<string, string | undefined>,
): Promise<HostDiskSettings> {
  const general = await settings.getGeneral();
  return resolveHostDiskSettings({ stored: general.hostDisk, env }).settings;
}

function createRuntime(db: Db, options: HostDiskRuntimeOptions = {}): HostDiskRuntime {
  const env = options.env ?? process.env;
  const settings = instanceSettingsService(db);

  // The activity log lookup goes through the store module below; this shim
  // keeps the sweep testable without drizzle.
  const store = createHostDiskActivityStore(db);

  const settingsPort = settings as unknown as {
    getGeneral(): Promise<{ hostDisk?: unknown }>;
  };
  const sweep = createHostDiskSweep({
    dataRootPath: hostDiskDataRoot(env),
    consumerPaths: hostDiskConsumerPaths(env),
    resolveSettings: () => resolveSweepSettings(settingsPort, env),
    logActivity: (entry) => logActivity(db, entry),
    lastSignalAt: store.lastSignalAt,
    logger,
  });
  const service = hostDiskService({
    settings: settings as unknown as {
      getGeneral(): Promise<{ hostDisk?: unknown }>;
      updateGeneral(patch: { hostDisk: HostDiskSettings }): Promise<unknown>;
    },
    listCompanyIds: () => settings.listCompanyIds(),
    logActivity: (entry) => logActivity(db, entry),
    lastSignalAt: store.lastSignalAt,
    lastSweep: () => sweep.lastResult(),
    env,
  });
  return {
    sweep,
    service,
    run: (track) => {
      track(
        sweep.sweep().catch((err) => {
          logger.error({ err }, "host disk sweep failed");
        }),
      );
    },
  };
}

const runtimes = new WeakMap<Db, HostDiskRuntime>();

/** The runtime of this process for this database handle. */
export function hostDiskRuntime(db: Db, options: HostDiskRuntimeOptions = {}): HostDiskRuntime {
  const existing = runtimes.get(db);
  if (existing) return existing;
  const runtime = createRuntime(db, options);
  runtimes.set(db, runtime);
  return runtime;
}

/** Router for app.ts: GET/PATCH /api/myrmidon/host-disk. */
export function myrmidonHostDiskRoutes(db: Db) {
  return hostDiskRoutes(db, hostDiskRuntime(db).service);
}

/**
 * Scheduler step for the tick in server/src/index.ts: returns the function the
 * tick calls. One call measures the disk once; a rejected sweep is logged,
 * never thrown into the tick.
 */
export function createHostDiskScheduler(options: {
  db: Db;
  track: (work: Promise<unknown>) => void;
}): () => void {
  const runtime = hostDiskRuntime(options.db);
  return () => runtime.run(options.track);
}

/** Data root whose filesystem usage is measured: the server's data directory. */
export function hostDiskDataRoot(env: Record<string, string | undefined> = process.env): string {
  return env.MYRMIDON_HOST_DISK_DATA_ROOT?.trim() || "/data";
}

/** Directories ranked as the biggest consumers when a signal is due. */
export function hostDiskConsumerPaths(env: Record<string, string | undefined> = process.env): string[] {
  const raw = env.MYRMIDON_HOST_DISK_CONSUMER_PATHS?.trim();
  if (!raw) return [hostDiskDataRoot(env)];
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

/** The activity-log port of the sweep: the newest signal line decides the interval. */
export interface HostDiskActivityStore {
  lastSignalAt(): Promise<Date | null>;
}

export function createHostDiskActivityStore(db: Db): HostDiskActivityStore {
  return {
    lastSignalAt: async () => {
      try {
        const { activityLog } = await import("@paperclipai/db");
        const { desc, eq } = await import("drizzle-orm");
        const rows = await db
          .select({ createdAt: activityLog.createdAt })
          .from(activityLog)
          .where(eq(activityLog.action, "host.disk_threshold_exceeded"))
          .orderBy(desc(activityLog.createdAt))
          .limit(1);
        const createdAt = rows[0]?.createdAt;
        return createdAt instanceof Date ? createdAt : createdAt ? new Date(createdAt) : null;
      } catch {
        return null;
      }
    },
  };
}
