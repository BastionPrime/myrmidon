// myrmidon(1.6-AUTONOMY): execute held autonomy actions after approval.
//
// When an autonomy action receives approval, this service executes the originally
// requested action. It handles the execution of actions that were held due to 
// approval requirements, ensuring they are processed correctly after approval.

import type { Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import {
  toolActionRequests,
  toolInvocations,
  agents,
  type ToolActionRequest,
  type ToolInvocation,
} from "@paperclipai/db";
import { agentService } from "../../services/agents.js";
import { heartbeatService } from "../../services/heartbeat.js";

export interface ExecuteHeldAutonomyActionInput {
  db: Db;
  actionRequestId: string;
  approvedBy: { userId?: string; agentId?: string };
}

/**
 * Executes a held autonomy action after it has been approved.
 * This function retrieves the held action details and performs the original action.
 */
export async function executeHeldAutonomyAction(input: ExecuteHeldAutonomyActionInput) {
  const { db, actionRequestId, approvedBy } = input;
  
  // Get the action request
  const [actionRequest] = await db
    .select()
    .from(toolActionRequests)
    .where(and(
      eq(toolActionRequests.id, actionRequestId),
      eq(toolActionRequests.status, "approved")
    ))
    .limit(1);
  
  if (!actionRequest) {
    throw new Error(`Action request ${actionRequestId} not found or not approved`);
  }
  
  // Get the associated invocation
  const [invocation] = await db
    .select()
    .from(toolInvocations)
    .where(eq(toolInvocations.id, actionRequest.invocationId))
    .limit(1);
  
  if (!invocation) {
    throw new Error(`Invocation for action request ${actionRequestId} not found`);
  }
  
  // Parse the original action details from the arguments hash
  const actionDetails = JSON.parse(invocation.argumentsHash) as {
    route: string;
    method: string;
    params?: Record<string, unknown>;
    body?: Record<string, unknown>;
    actionClass: string;
  };
  
  // Execute the original action based on its type
  switch (actionDetails.actionClass) {
    case "pause_wake_agents":
      return executePauseWakeAgentsAction(db, actionDetails, approvedBy);
    // Add other action classes as needed
    default:
      throw new Error(`Unsupported action class: ${actionDetails.actionClass}`);
  }
}

/**
 * Executes a pause/wake/resume action for an agent after approval
 */
async function executePauseWakeAgentsAction(
  db: Db,
  actionDetails: {
    route: string;
    method: string;
    params?: Record<string, unknown>;
    body?: Record<string, unknown>;
  },
  approvedBy: { userId?: string; agentId?: string }
) {
  // Extract agent ID from the route
  const routeParts = actionDetails.route.split('/');
  const agentId = routeParts[routeParts.indexOf('agents') + 1];
  
  if (!agentId) {
    throw new Error(`Could not extract agent ID from route: ${actionDetails.route}`);
  }
  
  // Get the agent to ensure it exists
  const agentSvc = agentService(db);
  const agent = await agentSvc.getById(agentId);
  
  if (!agent) {
    throw new Error(`Agent ${agentId} not found`);
  }
  
  // Determine which action to perform based on the route
  if (actionDetails.route.includes('/pause')) {
    return await agentSvc.pause(agentId);
  } else if (actionDetails.route.includes('/resume')) {
    return await agentSvc.resume(agentId);
  } else if (actionDetails.route.includes('/wakeup')) {
    const heartbeat = heartbeatService(db, { agent: agentService(db) });
    return await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "Approved autonomy action",
      requestedByActorType: approvedBy.userId ? "user" : "agent",
      requestedByActorId: approvedBy.userId || approvedBy.agentId || "system",
      contextSnapshot: {
        triggeredBy: approvedBy.userId ? "user" : "agent",
        actorId: approvedBy.userId || approvedBy.agentId || "system",
      },
    });
  } else {
    throw new Error(`Unknown pause/wake/resume action in route: ${actionDetails.route}`);
  }
}

/**
 * Updates the status of an action request after processing
 */
export async function updateActionRequestStatus(
  db: Db,
  actionRequestId: string,
  status: "executed" | "failed",
  errorMessage?: string
) {
  const now = new Date();
  
  await db
    .update(toolActionRequests)
    .set({
      status,
      resolvedByUserId: null, // Would be set to actual approver in real scenario
      decidedByUserId: null, // Would be set to actual approver in real scenario
      decidedAt: now,
      resolvedAt: now,
      updatedAt: now,
    })
    .where(eq(toolActionRequests.id, actionRequestId));
    
  await db
    .update(toolInvocations)
    .set({
      status: status === "executed" ? "completed" : "failed",
      ...(errorMessage && { errorCode: "execution_error", errorMessage }),
      completedAt: now,
      updatedAt: now,
    })
    .where(eq(toolInvocations.id, actionRequestId)); // Note: This assumes invocation ID matches action request ID
}