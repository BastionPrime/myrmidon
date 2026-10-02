// Live run admission limits (myrmidon C0, RUNTIME-LIMITS) entry point.
//
// Startup: read the stored limits once and put them in force before the
// scheduler starts runs, so an instance whose ceiling was lowered from the
// settings page does not restart with the environment value again. After that
// every settings write applies itself (see service.ts).

import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { heartbeatService, instanceSettingsService, logActivity } from "../../services/index.js";
import { applyRunAdmissionLimits, scheduleQueuedResweep } from "../run-admission.js";
import { runtimeLimitsRoutes } from "./routes.js";
import { runtimeLimitsService, type RuntimeLimitsServiceDeps } from "./service.js";

export { runtimeLimitsService, RUNTIME_LIMITS_ACTION } from "./service.js";
export type {
  RuntimeLimitsActor,
  RuntimeLimitsService,
  RuntimeLimitsView,
} from "./service.js";

function defaultDeps(db: Db): RuntimeLimitsServiceDeps {
  const heartbeat = heartbeatService(db);
  return {
    settings: instanceSettingsService(db),
    listCompanyIds: () => instanceSettingsService(db).listCompanyIds(),
    logActivity: (entry) => logActivity(db, entry),
    apply: applyRunAdmissionLimits,
    scheduleResweep: () =>
      scheduleQueuedResweep(() =>
        heartbeat.resumeQueuedRuns().catch((err) => {
          logger.error({ err }, "queued run resweep after a runtime limits change failed");
        }),
      ),
  };
}

/** Router for app.ts: GET/PATCH /api/myrmidon/runtime-limits. */
export function myrmidonRuntimeLimitsRoutes(db: Db) {
  return runtimeLimitsRoutes(db, runtimeLimitsService(db, defaultDeps(db)));
}

/**
 * Startup: put the stored run admission limits in force. A failed read must
 * not stop the server: the admission keeps the environment values it was
 * created with, which is exactly the pre-feature behaviour.
 */
export async function startRuntimeLimits(db: Db): Promise<void> {
  try {
    const view = await runtimeLimitsService(db, defaultDeps(db)).read();
    applyRunAdmissionLimits(view.limits);
    logger.info(
      { limits: view.limits, sources: view.sources },
      "run admission limits at startup",
    );
  } catch (err) {
    logger.error(
      { err },
      "failed to read the stored run admission limits; the environment values stay in force",
    );
  }
}