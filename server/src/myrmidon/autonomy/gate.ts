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
// Deciding what to do with `approval_required` belongs to the calling seam,
// because the two seams hold a held action differently:
//   - the tool gateway already has a held-action primitive (a tool invocation
//     plus `tool_action_requests`), so an approval card is created there;
//   - a plain board-API route has no invocation row, so this module returns the
//     verdict and the caller decides. 1.6 ships the deny half and the resolver;
//     the held-action half for invocation-less routes is a documented follow-up.

import type { Db } from "@paperclipai/db";
import type { Request } from "express";
import {
  resolveAutonomy,
  type AutonomyActionClass,
  type AutonomyVerdict,
} from "@paperclipai/shared";
import { forbidden } from "../../errors.js";
import { dbAutonomyStore, agentRoleFromDb, type AutonomyStore } from "./store.js";

/** Stable error code the UI and tests match on. */
export const AUTONOMY_FORBIDDEN_CODE = "autonomy_forbidden";

export interface AutonomyGateDeps {
  store: AutonomyStore;
  roleOf: (agentId: string) => Promise<string | null>;
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

  return { decide, assertAllowed };
}

export type AutonomyGate = ReturnType<typeof autonomyGate>;

/** The production gate: matrix from instance_settings, role from agents.role. */
export function dbAutonomyGate(db: Db): AutonomyGate {
  return autonomyGate({ store: dbAutonomyStore(db), roleOf: agentRoleFromDb(db) });
}