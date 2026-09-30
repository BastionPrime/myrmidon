import type { Db } from "@paperclipai/db";
import { resolveWorkspaceHygieneLimits } from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { instanceSettingsService, logActivity } from "../../services/index.js";
import { workspaceHygieneRoutes } from "./routes.js";
import { workspaceHygieneService, type WorkspaceHygieneService } from "./service.js";
import { createWorkspaceHygieneSweep, WORKSPACE_HYGIENE_ACTOR_ID, type WorkspaceHygieneSweep } from "./sweep.js";
import { createDbWorkspaceHygieneStore } from "./store.js";
import { measureWorkspaceSize } from "./measure.js";

/**
 * Entry point of the workspace quota part (myrmidon WORKSPACE-HYGIENE, part C).
 *
 * One runtime per server process, created on demand and shared by the two call
 * sites: the routes mounted in `server/src/app.ts` and the scheduler function
 * called from the tick in `server/src/index.ts` (next to the terminal workspace
 * reaper). They must share it, so the endpoint reports the state of the sweep
 * that actually runs.
 *
 * Startup does nothing: the quotas are read at the top of every sweep, so a
 * server that restarts keeps whatever the settings row holds, and no live
 * object has to be kept in sync.
 */

export { workspaceHygieneService, WORKSPACE_HYGIENE_ACTOR_ID, measureWorkspaceSize };
export type { WorkspaceHygieneService, WorkspaceHygieneSweep };

export interface WorkspaceHygieneRuntime {
  sweep: WorkspaceHygieneSweep;
  service: WorkspaceHygieneService;
  /** Run one sweep and hand the work to the scheduler's tracker. */
  run(track: (work: Promise<unknown>) => void): void;
}

export interface WorkspaceHygieneRuntimeOptions {
  env?: Record<string, string | undefined>;
}

function createRuntime(db: Db, options: WorkspaceHygieneRuntimeOptions = {}): WorkspaceHygieneRuntime {
  const env = options.env ?? process.env;
  const store = createDbWorkspaceHygieneStore(db);
  const settings = instanceSettingsService(db);
  const sweep = createWorkspaceHygieneSweep({
    store,
    resolveLimits: async () =>
      resolveWorkspaceHygieneLimits({ stored: (await settings.getGeneral()).workspaceHygiene, env }),
    logActivity: (entry) => logActivity(db, entry),
    logger,
  });
  const service = workspaceHygieneService({
    settings,
    listCompanyIds: () => settings.listCompanyIds(),
    logActivity: (entry) => logActivity(db, entry),
    store,
    lastSweep: () => sweep.lastResult(),
    env,
  });
  return {
    sweep,
    service,
    run: (track) => {
      track(
        sweep.sweep().catch((err) => {
          logger.error({ err }, "workspace hygiene sweep failed");
        }),
      );
    },
  };
}

const runtimes = new WeakMap<Db, WorkspaceHygieneRuntime>();

/** The runtime of this process for this database handle. */
export function workspaceHygieneRuntime(
  db: Db,
  options: WorkspaceHygieneRuntimeOptions = {},
): WorkspaceHygieneRuntime {
  const existing = runtimes.get(db);
  if (existing) return existing;
  const runtime = createRuntime(db, options);
  runtimes.set(db, runtime);
  return runtime;
}

/** Router for app.ts: GET/PATCH /api/myrmidon/workspace-hygiene. */
export function myrmidonWorkspaceHygieneRoutes(db: Db) {
  return workspaceHygieneRoutes(db, workspaceHygieneRuntime(db).service);
}

/**
 * Scheduler step for the tick in server/src/index.ts: returns the function the
 * tick calls. One call measures one page of workspaces; a rejected sweep is
 * logged, never thrown into the tick.
 */
export function createWorkspaceHygieneScheduler(options: {
  db: Db;
  track: (work: Promise<unknown>) => void;
}): () => void {
  const runtime = workspaceHygieneRuntime(options.db);
  return () => runtime.run(options.track);
}