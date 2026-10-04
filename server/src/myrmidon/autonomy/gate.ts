// myrmidon(1.6-AUTONOMY): the enforcement point for agent callers.
//
// The matrix is consulted at the action point, not in the agent's instructions.
// This module is that action point's reusable half: a route handler asks it
// whether the caller may take an action class, and it answers from the stored
// matrix using the caller's role. The answer does not depend on anything the
// caller said — that is the whole point of the epic.
//
// `forbidden` denies: the route answers 403 with a stable error code. There is
// no path from a forbidden cell to a running action.
//
// `approval_required` creates an approval card and holds the action until approved.
// The held action is stored and will be executed once approved, or discarded if rejected.

import type { Db } from "@paperclipai/db";
import type { Request } from "express";
import {
  resolveAutonomy,
  type AutonomyActionClass,
  type AutonomyVerdict,
} from "@paperclipai/shared";
import { forbidden } from "../../errors.js";
import { dbAutonomyStore, agentRoleFromDb, type AutonomyStore } from "./store.js";
import { and, eq } from "drizzle-orm";
import {
  toolActionRequests,
  toolInvocations,
  type ToolActionRequest,
  type ToolInvocation,
} from "@paperclipai/db";

/** Stable error code the UI and tests match on. */
export const AUTONOMY_FORBIDDEN_CODE = "autonomy_forbidden";
/** Stable error code for actions that require approval. */
export const AUTONOMY_APPROVAL_REQUIRED_CODE = "autonomy_approval_required";

export interface AutonomyGateDeps {
  store: AutonomyStore;
  roleOf: (agentId: string) => Promise<string | null>;
  db: Db; // Added DB for tool action requests
  now?: () => Date;
}

export interface AutonomyDecision {
  verdict: AutonomyVerdict;
  role: string | null;
  actionClass: AutonomyActionClass;
}

/** The automation identity the request was made under, if any. */
function agentIdOf(req: Request): string | null {
  const actor = req.actor as { type?: string; agentId?: string | null } | undefined;
  if (!actor || actor.type !== "agent") return null;
  return actor.agentId ?? null;
}

export function autonomyGate(deps: AutonomyGateDeps) {
  /**
   * The verdict for this request's caller. A non-agent caller (the board, an
   * instance admin, the system) is not subject to the matrix: the matrix
   * constrains agents, and the board is the actor that edits it.
   */
  async function decide(req: Request, actionClass: AutonomyActionClass): Promise<AutonomyDecision> {
    const agentId = agentIdOf(req);
    if (!agentId) return { verdict: "allowed", role: null, actionClass };
    const [role, matrix] = await Promise.all([deps.roleOf(agentId), deps.store.read().then((doc) => doc.matrix)]);
    return { verdict: resolveAutonomy(role, actionClass, matrix, agentId), role, actionClass };
  }

  /**
   * Deny a forbidden action. Returns the decision so a caller that also needs
   * the verdict (to build a card, or to log) does not resolve twice.
   */
  async function assertAllowed(req: Request, actionClass: AutonomyActionClass): Promise<AutonomyDecision> {
    const decision = await decide(req, actionClass);
    if (decision.verdict === "forbidden") {
      throw forbidden("This action is forbidden for this role by the autonomy matrix", {
        code: AUTONOMY_FORBIDDEN_CODE,
        actionClass,
        role: decision.role,
      });
    }
    return decision;
  }

  /**
   * Hold the action if approval is required, or assert it's allowed. For
   * `approval_required`, creates an approval card and returns 202 with the 
   * approval ID. For `forbidden`, throws 403. For `allowed`, allows to proceed.
   */
  async function holdOrAssert(
    req: Request, 
    actionClass: AutonomyActionClass, 
    descriptor: {
      route: string;
      method: string;
      params?: Record<string, unknown>;
      body?: Record<string, unknown>;
    }
  ): Promise<{ verdict: AutonomyVerdict; held?: boolean; approvalId?: string }> {
    const decision = await decide(req, actionClass);
    
    if (decision.verdict === "forbidden") {
      throw forbidden("This action is forbidden for this role by the autonomy matrix", {
        code: AUTONOMY_FORBIDDEN_CODE,
        actionClass,
        role: decision.role,
      });
    }
    
    if (decision.verdict === "approval_required") {
      // Create an approval card using the existing tool action request mechanism
      const agentId = agentIdOf(req);
      
      // For non-agent callers, we still return the approval required status
      // but don't create a card since only agents should have actions held
      if (!agentId) {
        return { verdict: "approval_required" };
      }
      
      // Create a tool invocation to represent the held action
      const now = deps.now?.() || new Date();
      const actionParamsHash = JSON.stringify({
        route: descriptor.route,
        method: descriptor.method,
        params: descriptor.params,
        body: descriptor.body,
        actionClass
      });
      
      // Insert a tool invocation representing the held autonomy action
      const [invocation] = await deps.db.insert(toolInvocations).values({
        companyId: req.actor.companyId,
        actorType: "agent",
        actorId: agentId,
        agentId,
        issueId: null, // No issue context for autonomy actions
        runId: null, // No run context for autonomy actions
        applicationId: null,
        connectionId: null,
        catalogEntryId: null,
        catalogVersionHash: null,
        catalogSchemaHash: null,
        providerType: null,
        applicationKey: null,
        upstreamToolName: null,
        riskLevel: null,
        toolName: `autonomy_action_${actionClass}`, // Unique name for autonomy actions
        argumentsHash: actionParamsHash,
        argumentsSummary: {
          summary: `Autonomy action ${actionClass} for route ${descriptor.route}`,
          sizeBytes: Buffer.byteLength(actionParamsHash),
          sha256: "",
          redactedFields: []
        },
        policyDecision: "require_approval",
        matchedPolicyIds: [],
        approvalState: "pending",
        status: "awaiting_approval",
        errorCode: null,
        errorMessage: null,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
      }).returning();

      // Create a corresponding tool action request to hold the action
      const [actionRequest] = await deps.db.insert(toolActionRequests).values({
        companyId: req.actor.companyId,
        invocationId: invocation.id,
        issueId: null, // No issue context for autonomy actions
        status: "pending",
        canonicalArgumentsHash: actionParamsHash,
        canonicalArgumentsSummary: {
          summary: `Autonomy action ${actionClass} for route ${descriptor.route}`,
          sizeBytes: Buffer.byteLength(actionParamsHash),
          sha256: "",
          redactedFields: []
        },
        requestedByAgentId: agentId,
        requestedByUserId: null,
        createdAt: now,
        updatedAt: now,
      }).returning();
      
      // Return 202 Accepted with the approval ID
      return { 
        verdict: "approval_required", 
        held: true, 
        approvalId: actionRequest.id
      };
    }
    
    // For "allowed", proceed normally
    return { verdict: "allowed" };
  }

  return { decide, assertAllowed, holdOrAssert };
}

export type AutonomyGate = ReturnType<typeof autonomyGate>;

/** The production gate: matrix from instance_settings, role from agents.role. */
export function dbAutonomyGate(db: Db): AutonomyGate {
  return autonomyGate({ store: dbAutonomyStore(db), roleOf: agentRoleFromDb(db), db });
}

export { dbAutonomyStore, agentRoleFromDb };
export type { AutonomyActionClass };