// Maintenance mode (R3) entry point. Design: docs/myrmidon/design/maintenance-mode.md

import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { heartbeatService } from "../../services/heartbeat.js";
import type { MaintenanceDocument } from "./domain.js";
import { getCachedMaintenanceDocument } from "./gate.js";
import { maintenanceRoutes } from "./routes.js";
import { maintenanceService, type MaintenanceHooks } from "./service.js";
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

let integrationHooks: MaintenanceHooks = {};

/** Zabbix (step 4) registers here; the default is no integration. */
export function setMaintenanceHooks(hooks: MaintenanceHooks) {
  integrationHooks = hooks;
}

function defaultService(db: Db) {
  const heartbeat = heartbeatService(db);
  return maintenanceService(db, { heartbeat, hooks: integrationHooks });
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
  const doc = await service.restore();
  if (doc.windows.length > 0) {
    logger.warn({ windows: doc.windows.map((w) => ({ scope: w.scope, state: w.state })) }, "maintenance mode is active");
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
