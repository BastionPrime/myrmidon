// server/src/myrmidon/swarm-claim/index.ts
//
// myrmidon(1.6-SWARM): the wiring point of the per-role task queues.
//
// app.ts mounts `swarmClaimRoutes` from here; the startup in index.ts drives
// the sweeper on its scheduler tick (the same place leases-stale-sweep and
// idle-pickup live). Everything the two parts of 1.6 share — the queue order,
// the lease states, the settings — comes from `@paperclipai/shared`, so Part B
// (the supervisor view, OPE-3609) reads the same decisions Part A enforces.

import type { Db } from "@paperclipai/db";
import { DEFAULT_SWARM_CLAIM_SWEEP_INTERVAL_SEC } from "@paperclipai/shared";
import { logActivity as logActivityService } from "../../services/activity-log.js";
import type { instanceSettingsService } from "../../services/instance-settings.js";
import { createSwarmClaimSweeper, type SwarmClaimSweeper } from "./sweep.js";
import {
  claimNextTaskForAgent,
  refreshLeaseForRun,
  releaseTaskAndWakeNext,
  type SwarmClaimEnqueueWakeup,
  type SwarmClaimServicePorts,
} from "./service.js";
import { swarmClaimSettingsService } from "./settings.js";
import { swarmClaimRoutes } from "./routes.js";

export * from "./domain.js";
export * from "./store.js";
export * from "./queue.js";
export * from "./service.js";
export * from "./sweep.js";
export * from "./settings.js";
export * from "./hooks.js";
export { swarmClaimRoutes };

export interface SwarmClaimPorts {
  db: Db;
  settings: Pick<ReturnType<typeof instanceSettingsService>, "getGeneral" | "updateGeneral">;
  enqueueWakeup?: SwarmClaimEnqueueWakeup;
  env?: Record<string, string | undefined>;
}

/** Build the ports object once (app.ts / the startup both call this). */
export function swarmClaimPorts(ports: SwarmClaimPorts): SwarmClaimServicePorts {
  return {
    db: ports.db,
    settings: ports.settings,
    enqueueWakeup: ports.enqueueWakeup,
    logActivity: async (input) => {
      await logActivityService(ports.db, {
        companyId: input.companyId,
        actorType: input.actorType as "user" | "agent" | "system",
        actorId: input.actorId,
        agentId: input.agentId,
        runId: input.runId,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        details: input.details,
      });
    },
    env: ports.env,
  };
}

/** The sweeper runtime; index.ts ticks it on the scheduler. */
export function buildSwarmClaimSweeper(ports: SwarmClaimPorts): SwarmClaimSweeper {
  return createSwarmClaimSweeper({
    ...swarmClaimPorts(ports),
    intervalMs: DEFAULT_SWARM_CLAIM_SWEEP_INTERVAL_SEC * 1000,
  });
}

/** The routes with the real ports (app.ts mounts this). */
export function swarmClaimApp(ports: SwarmClaimPorts) {
  const servicePorts = swarmClaimPorts(ports);
  return swarmClaimRoutes(
    ports.db,
    servicePorts,
    swarmClaimSettingsService(ports.db, { settings: ports.settings, env: ports.env }),
  );
}

export { claimNextTaskForAgent, refreshLeaseForRun, releaseTaskAndWakeNext };