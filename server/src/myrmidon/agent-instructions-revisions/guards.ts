// server/src/myrmidon/agent-instructions-revisions/guards.ts
//
// myrmidon(H2): shared authorization for the instructions revision routes.
// The rules are the vendored ones, restated for this module: reading the
// revision history needs the same read access the instructions bundle routes
// demand; the rollback is a bundle write, so it needs the same
// protected-change gate as the vendored PUT /instructions-bundle/file
// (agent-initiated changes to instructions require explicit consent), plus
// the instance-admin rule when the bundle is external.

import type { Request, Response } from "express";
import { HttpError } from "../../errors.js";
import { forbidden } from "../../errors.js";
import { assertCompanyAccess, assertInstanceAdmin, hasCompanyAccess } from "../../routes/authz.js";
import { agentInstructionsBundleMode } from "../../services/agent-instructions.js";
import { authorizationDeniedDetails } from "../../services/authorization.js";
import {
  agentInstructionsChangeTargetKey,
  changeConsentGateService,
} from "../../services/change-consent-gate.js";
import { accessService, agentService } from "../../services/index.js";
import type { Db } from "@paperclipai/db";

type AgentRow = {
  id: string;
  companyId: string;
  name: string;
  adapterConfig: unknown;
};

/**
 * Loads the agent and applies the read rules (company scope). Responds 404 and
 * returns null when the agent is not visible to the caller.
 */
export async function loadAgentForInstructionsRead(
  req: Request,
  res: Response,
  db: Db,
  agentId: string,
): Promise<AgentRow | null> {
  const agent = await agentService(db).getById(agentId);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return null;
  }
  if (!hasCompanyAccess(req, agent.companyId)) {
    res.status(404).json({ error: "Agent not found" });
    return null;
  }
  assertCompanyAccess(req, agent.companyId);
  return agent;
}

/**
 * Loads the agent and applies the write rules: company scope, the
 * external-bundle instance-admin rule, then the same protected-change decision
 * (with consent fallback for agent actors) as the vendored instructions file
 * write. Throws on denial; the route's error handler turns it into 403.
 */
export async function loadAgentForInstructionsWrite(
  req: Request,
  res: Response,
  db: Db,
  agentId: string,
): Promise<AgentRow | null> {
  const agent = await loadAgentForInstructionsRead(req, res, db, agentId);
  if (!agent) return null;

  if (agentInstructionsBundleMode(agent) === "external") {
    assertInstanceAdmin(req);
  }

  const targetKeys = [agentInstructionsChangeTargetKey(agent.id)];
  const changeScope = { requiresChangeGrant: true };
  const decision = await accessService(db).decide({
    actor: req.actor,
    action: "agent_config:update",
    resource: { type: "agent", companyId: agent.companyId, agentId: agent.id },
    scope: changeScope,
  });
  if (decision.allowed) return agent;

  if (decision.reason === "deny_missing_consent" && req.actor.type === "agent") {
    try {
      await changeConsentGateService(db).assertConsented({
        companyId: agent.companyId,
        actorAgentId: req.actor.agentId,
        actorRunId: req.actor.runId ?? null,
        targetKeys,
      });
    } catch (err) {
      if (err instanceof HttpError && err.status === 403) {
        throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
      }
      throw err;
    }
    const consentedDecision = await accessService(db).decide({
      actor: req.actor,
      action: "agent_config:update",
      resource: { type: "agent", companyId: agent.companyId, agentId: agent.id },
      scope: { ...changeScope, consentedChange: true },
    });
    if (consentedDecision.allowed) return agent;
    throw forbidden(consentedDecision.explanation, authorizationDeniedDetails(consentedDecision));
  }

  throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
}
