// Board self-deploy (myrmidon R5-A) entry point.
// Design: docs/myrmidon/design/deploy-from-ui.md
//
// Off by default: until MYRMIDON_DEPLOY_ENABLED=1 the routes answer 503 on
// writes, so an instance that never opted in behaves exactly as before.

import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { maintenanceService } from "../maintenance/service.js";
import { maintenanceHeartbeatPort } from "../maintenance/index.js";
import { readZabbixSettings, zabbixMaintenanceHooks } from "../maintenance/zabbix.js";
import { heartbeatService } from "../../services/index.js";
import { hostReportReader } from "./host-report.js";
import { readDeployJobsSettings } from "./settings.js";
import { deployJobsRoutes } from "./routes.js";
import { deployJobsService, type DeployJobServiceDeps } from "./service.js";

export { digestProblem, parseDigest, verifyCiImage } from "./domain.js";
export { deployJobsService } from "./service.js";
export type { DeployJobsService } from "./service.js";

const SYSTEM_ACTOR = { actorType: "system", actorId: "myrmidon-deploy-jobs" } as const;

function defaultDeps(db: Db): DeployJobServiceDeps {
  const settings = readDeployJobsSettings();
  // The maintenance port talks to the same service the R3 routes use; the
  // deploy job is just another client of the maintenance API.
  const maintenance = maintenanceService(db, {
    heartbeat: maintenanceHeartbeatPort(heartbeatService(db)),
    hooks: zabbixMaintenanceHooks(readZabbixSettings()),
  });
  return {
    maintenance: {
      enter: async (input) => {
        const result = await maintenance.enter({ scope: { type: "instance" }, ...input }, SYSTEM_ACTOR);
        return { id: result.id, state: result.state };
      },
      exit: async (reason?: string) => {
        const result = await maintenance.exit({ type: "instance" }, SYSTEM_ACTOR, reason);
        return { state: result.state };
      },
      status: async () => {
        const result = await maintenance.status();
        return { instance: result.instance ? { id: result.instance.id, state: result.instance.state } : null };
      },
    },
    readHostReport: hostReportReader(process.env.MYRMIDON_DEPLOY_REPORTS_DIR?.trim() || null),
    readHealth: async () => {
      // The board's own health, read the way verify-health.sh does: through
      // the HTTP endpoint, not the process state.
      const url = process.env.MYRMIDON_DEPLOY_HEALTH_URL?.trim();
      if (!url) return null;
      try {
        const response = await fetch(url, { headers: { Accept: "application/json" } });
        if (!response.ok) return null;
        const body = (await response.json()) as { version?: string; commit?: string };
        return { version: body.version ?? null, commit: body.commit ?? null };
      } catch {
        return null;
      }
    },
    settings,
  };
}

/** Router for app.ts: GET/POST /api/myrmidon/deploy-jobs. */
export function myrmidonDeployJobsRoutes(db: Db) {
  return deployJobsRoutes(db, deployJobsService(db, defaultDeps(db)));
}

/**
 * Startup: resume the open job (if any) and run the reconciliation tick on an
 * interval. A failed restore must not stop the server — the tick retries and
 * an instance without the feature enabled has nothing to resume anyway.
 */
export async function startDeployJobs(db: Db): Promise<() => void> {
  const service = deployJobsService(db, defaultDeps(db));
  const settings = readDeployJobsSettings();
  try {
    await service.tick();
  } catch (err) {
    logger.error({ err }, "deploy jobs startup tick failed");
  }
  if (!settings.enabled) {
    return () => undefined;
  }
  const timer = setInterval(() => {
    void service.tick().catch((err) => logger.error({ err }, "deploy jobs tick failed"));
  }, settings.tickMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
