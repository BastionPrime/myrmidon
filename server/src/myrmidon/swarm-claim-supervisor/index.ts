// myrmidon(1.6-SWARM-CLAIM-B): entry point of the supervisor surface.
//
// The lead's side of swarm claim: a read-only aggregation of the per-role
// queues and the leased claims (part A owns the claim machinery), one
// rebalance action (release a live lease, wake the next agent of the role)
// and the pilot report measured against the frozen BASELINE snapshot.

import type { Db } from "@paperclipai/db";
import { logActivity } from "../../services/index.js";
import { heartbeatService } from "../../services/index.js";
import { swarmSupervisorRoutes } from "./routes.js";

export { swarmSupervisorView, createSwarmSupervisorDbPort } from "./view.js";
export type { SwarmSupervisorOverview, SwarmSupervisorReadPort } from "./view.js";
export {
  releaseLeaseForRebalance,
  createSwarmSupervisorReleasePort,
  ClaimNotLiveError,
  ClaimNotFoundError,
  SUPERVISOR_RELEASE_REASON,
  SWARM_CLAIM_SUPERVISOR_RELEASE_ACTION,
} from "./rebalance.js";
export type { SwarmReleaseLeaseResult, SwarmRebalanceDeps } from "./rebalance.js";
export {
  swarmPilotReport,
  createSwarmPilotDeps,
  parsePilotWindow,
  defaultPilotWindow,
  parseSnapshot,
  compareMetric,
  SwarmPilotNotEnabledError,
  SwarmPilotWindowError,
} from "./pilot-report.js";
export type { SwarmPilotReport, SwarmPilotDeps, BaselineMetricsReportJson } from "./pilot-report.js";
export { readSwarmSupervisorSettings, DEFAULT_SWARM_PILOT_BASELINE_DOC } from "./settings.js";

/**
 * Router for app.ts: the supervisor surface under
 * /api/myrmidon/companies/:companyId/swarm-claim/supervisor/*. The wake port
 * goes through the heartbeat service's wakeup admission path, so every gate
 * (pause, maintenance, limits, concurrency, budget) applies to the rebalance
 * wake exactly as it applies to any other wake.
 */
export function myrmidonSwarmSupervisorRoutes(db: Db) {
  const heartbeat = heartbeatService(db);
  return swarmSupervisorRoutes(db, {
    db,
    enqueueWakeup: (agentId, opts) => heartbeat.wakeup(agentId, opts),
    logActivity: async (input) => {
      await logActivity(db, {
        companyId: input.companyId,
        actorType: input.actorType,
        actorId: input.actorId,
        agentId: input.agentId,
        runId: input.runId,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        details: input.details,
      });
    },
    now: () => new Date(),
  });
}
