// Maintenance mode (R3) entry point. Design: docs/myrmidon/design/maintenance-mode.md

import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
// Same entry point as the vendor server/src/index.ts, so startup tests that mock it keep working.
import { heartbeatService } from "../../services/index.js";
import {
  MAINTENANCE_INTERRUPT_ERROR_CODE,
  MAINTENANCE_RETRY_REASON,
  MAINTENANCE_RETRY_WAKE_REASON,
  type MaintenanceDocument,
} from "./domain.js";
import { getCachedMaintenanceDocument } from "./gate.js";
import { maintenanceRoutes } from "./routes.js";
import { maintenanceService, type MaintenanceHeartbeatPort } from "./service.js";
import { readZabbixSettings, zabbixMaintenanceHooks } from "./zabbix.js";
import { readMaintenanceSettings } from "./settings.js";

export {
  isAgentUnderMaintenance,
  isRunUnderMaintenance,
  isInstanceUnderMaintenance,
  filterAgentsOutsideMaintenance,
  resetMaintenanceGateCaches,
} from "./gate.js";
export { preserveMaintenanceGeneralKey } from "./store.js";
export { MAINTENANCE_INTERRUPT_ERROR_CODE } from "./domain.js";
export { maintenanceService } from "./service.js";

/** Heartbeat operations for the mode, on top of the vendor cancel and bounded-retry paths. */
export function maintenanceHeartbeatPort(heartbeat: ReturnType<typeof heartbeatService>): MaintenanceHeartbeatPort {
  return {
    async resumeQueuedRuns() {
      // Retries scheduled during the window are due already; promote them now
      // instead of waiting for the vendor's periodic tick.
      await heartbeat.promoteDueScheduledRetries();
      await heartbeat.resumeQueuedRuns();
    },
    async interruptRunForMaintenance(runId, windowId) {
      await heartbeat.cancelRun(runId, "Interrupted by maintenance mode; retried after maintenance ends", {
        errorCode: MAINTENANCE_INTERRUPT_ERROR_CODE,
        resultJson: { myrmidonMaintenance: { windowId } },
        eventMessage: "run interrupted by maintenance mode",
        // The retry below is the successor path; the admission gate holds it until exit.
        suppressImmediateRecovery: true,
      });
      const retry = await heartbeat.scheduleBoundedRetry(runId, {
        retryReason: MAINTENANCE_RETRY_REASON,
        wakeReason: MAINTENANCE_RETRY_WAKE_REASON,
        delayMs: 0,
      });
      return { retryScheduled: retry.outcome === "scheduled" };
    },
  };
}

function defaultService(db: Db) {
  return maintenanceService(db, { heartbeat: maintenanceHeartbeatPort(heartbeatService(db)), hooks: zabbixMaintenanceHooks(readZabbixSettings()) });
}

/** Router for app.ts: GET/POST /api/myrmidon/maintenance. */
export function myrmidonMaintenanceRoutes(db: Db) {
  return maintenanceRoutes(db, defaultService(db));
}

/**
 * Startup: load open windows into the admission gate before the scheduler's first
 * pass, then run the transition tick on an interval. Returns a stop function.
 */
export async function startMaintenanceMode(db: Db): Promise<() => void> {
  const service = defaultService(db);
  try {
    const doc = await service.restore();
    if (doc.windows.length > 0) {
      logger.warn({ windows: doc.windows.map((w) => ({ scope: w.scope, state: w.state })) }, "maintenance mode is active");
    }
  } catch (err) {
    // The admission gate reads the state itself on its first check and the tick
    // below retries; a failed read here must not stop the server from starting.
    logger.error({ err }, "failed to restore maintenance mode state at startup");
  }
  const timer = setInterval(() => {
    void service.tick().catch((err) => logger.error({ err }, "maintenance tick failed"));
  }, readMaintenanceSettings().tickMs);
  timer.unref?.();
  void service.tick().catch((err) => logger.error({ err }, "maintenance tick failed"));
  return () => clearInterval(timer);
}

/**
 * `maintenance` field of /api/health, or null when no window is open, so that
 * responses stay identical to the vendor's outside maintenance.
 */
export async function maintenanceHealth(db: Db) {
  let doc: MaintenanceDocument;
  try {
    doc = await getCachedMaintenanceDocument(db);
  } catch (err) {
    // The database probe of /api/health reports the outage; keep the vendor shape.
    logger.warn({ err }, "maintenance health read failed");
    return null;
  }
  if (doc.windows.length === 0) return null;
  const instance = doc.windows.find((w) => w.scope.type === "instance");
  return {
    active: true,
    instanceState: instance?.state ?? "off",
    windows: doc.windows.length,
  };
}
