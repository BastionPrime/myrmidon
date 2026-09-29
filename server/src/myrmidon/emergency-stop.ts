// Emergency stop (myrmidon(EMERGENCY-STOP), plan 1.1.2 item 17): immediately
// cancel the runs a draining operator pause left running.
//
// Since L3 the operator pause (`POST /agents/:id/pause`) drains by default:
// active runs keep running to completion so a pause does not manufacture a
// wall of reconciliation holds. That is the right default for deploys and
// nights, but the owner sometimes needs the runs to stop *now* — a runaway
// spend, an agent doing something wrong — and the only immediate lever was
// `POST /agents/:id/pause` with `{cancelActive: true}`, which also flips the
// agent status and is not discoverable from the board UI.
//
// This module is that lever, separate from pausing:
//
// - it only cancels what the pause deliberately left running. It targets the
//   same run statuses the pause-cancel path targets (`queued`, `running`,
//   `scheduled_retry` — CANCELLABLE_HEARTBEAT_RUN_STATUSES) through the same
//   `heartbeat.cancelActiveForAgent` call the explicit `cancelActive: true`
//   pause request uses, so the errorCode is `agent_paused`: an infrastructure
//   interruption in MYRMIDON_INFRA_INTERRUPT_CODES, which L1 already keeps
//   from creating a `legacy_execution_requires_reconciliation` hold (for a
//   conversation adapter, within the shared retry budget) and from an
//   immediate `stranded_assigned_issue` escalation. Unpausing then resumes
//   the affected work through the normal L3 `resumeAgentAfterPause` path.
// - it does not change the agent's own status: a paused agent stays paused,
//   an active agent stays active. Emergency stop is "stop the runs", not
//   "pause the agent"; combining the two is what the pause route is for.
//
// The route lives under /api/myrmidon (CONVENTIONS.md #8), is board-only and
// checks company access, like the vendor's pause route.

import { Router } from "express";
import { eq } from "drizzle-orm";
import { agents, type Db } from "@paperclipai/db";
import { notFound } from "../errors.js";
import { heartbeatService } from "../services/index.js";
import { logActivity } from "../services/activity-log.js";
import { assertBoard, assertCompanyAccess, hasCompanyAccess } from "../routes/authz.js";

/** Error code the cancelled runs carry. Same code an explicit pause-cancel uses. */
export const EMERGENCY_STOP_ERROR_CODE = "agent_paused";

export interface EmergencyStopResult {
  /** Id of the agent whose runs were cancelled. */
  agentId: string;
  /** Runs cancelled by this call (queued, running and scheduled_retry). */
  runsCancelled: number;
}

export interface EmergencyStopDeps {
  /** Cancels every cancellable run of the agent with the agent_paused code. */
  cancelActiveForAgent: (agentId: string, reason?: string) => Promise<number>;
}

/**
 * Cancel the agent's active runs immediately. Pure orchestration: the caller
 * (the route) has already resolved and authorized the agent.
 */
export async function emergencyStopAgent(
  deps: EmergencyStopDeps,
  db: Db,
  input: { agentId: string; companyId: string },
  actor: { actorType: "user" | "system"; actorId: string },
): Promise<EmergencyStopResult> {
  const runsCancelled = await deps.cancelActiveForAgent(
    input.agentId,
    "Cancelled by emergency stop",
  );
  await logActivity(db, {
    companyId: input.companyId,
    actorType: actor.actorType,
    actorId: actor.actorId,
    action: "myrmidon.agent.emergency_stop",
    entityType: "agent",
    entityId: input.agentId,
    details: { runsCancelled, errorCode: EMERGENCY_STOP_ERROR_CODE },
  });
  return { agentId: input.agentId, runsCancelled };
}

/** Production wiring: the shared heartbeat service, same as the pause route. */
export function emergencyStopDeps(db: Db): EmergencyStopDeps {
  // heartbeat.cancelActiveForAgent cancels with errorCode "agent_paused"
  // unconditionally (its original caller was the pause route); emergency
  // stop wants exactly that code, see EMERGENCY_STOP_ERROR_CODE.
  return { cancelActiveForAgent: heartbeatService(db).cancelActiveForAgent };
}

/** POST /api/myrmidon/agents/:id/emergency-stop — board only. */
export function myrmidonEmergencyStopRoutes(db: Db) {
  const router = Router();
  router.post("/myrmidon/agents/:id/emergency-stop", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    // 404 for both "no such agent" and "someone else's agent" (hasCompanyAccess),
    // so agent ids cannot be probed across companies; same shape as the W2b routes.
    const agent = await db
      .select({ id: agents.id, companyId: agents.companyId })
      .from(agents)
      .where(eq(agents.id, id))
      .then((rows) => rows[0] ?? null);
    if (!agent || !hasCompanyAccess(req, agent.companyId)) throw notFound("Agent not found");
    assertCompanyAccess(req, agent.companyId);
    const result = await emergencyStopAgent(
      emergencyStopDeps(db),
      db,
      { agentId: agent.id, companyId: agent.companyId },
      { actorType: "user", actorId: req.actor.userId ?? "board" },
    );
    res.json(result);
  });
  return router;
}
