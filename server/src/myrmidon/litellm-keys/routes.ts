// server/src/myrmidon/litellm-keys/routes.ts
//
// myrmidon(M2-B): the key-management API.
//
//   GET  /api/myrmidon/companies/:companyId/litellm/keys            (company access)
//   GET  /api/myrmidon/companies/:companyId/litellm/keys/:agentId   (company access; an agent only for itself)
//   POST /api/myrmidon/companies/:companyId/litellm/keys/:agentId   (board only)
//   POST /api/myrmidon/companies/:companyId/litellm/keys/:agentId/rotate (board only)
//
// Reads answer the state of a key — its store name and the sha256 of its value,
// never the value. A create or a rotation is board-only: it mints a credential
// and calls the gateway. When the instance has no gateway admin key configured
// the endpoints answer 503 with `enabled: false`, the same shape M2-A's cost
// endpoints use, so the interface can say why instead of showing a bare error.

import { Router, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { readGatewayKeySettings } from "@paperclipai/shared";
import { assertBoard, assertCompanyAccess } from "../../routes/authz.js";
import {
  assertAgentMayReadOwnGatewayKey,
  createAgentGatewayKey,
  defaultAgentGatewayKeyDeps,
  listAgentGatewayKeys,
  readAgentGatewayKey,
  rotateAgentGatewayKey,
  type AgentGatewayKeyDeps,
} from "./agent-keys.js";
import { readGatewayFallbackTopology } from "./fallback-cycles.js";

export interface LitellmKeysRoutesDeps {
  deps: AgentGatewayKeyDeps;
  env?: NodeJS.ProcessEnv;
}

export function litellmKeysRoutes(_db: Db, input: LitellmKeysRoutesDeps) {
  const router = Router();
  const env = input.env ?? process.env;
  const settings = () => readGatewayKeySettings(env);
  const disabled = (res: Response) => {
    res.status(503).json({ error: "LLM gateway key management is not enabled", enabled: false });
  };

  router.get("/myrmidon/companies/:companyId/litellm/keys", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!settings().canManageKeys) {
      disabled(res);
      return;
    }
    res.json(await listAgentGatewayKeys(input.deps, companyId));
  });

  router.get("/myrmidon/companies/:companyId/litellm/keys/:agentId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const agentId = req.params.agentId as string;
    assertCompanyAccess(req, companyId);
    assertAgentMayReadOwnGatewayKey({
      actorType: req.actor.type,
      actorAgentId: req.actor.type === "agent" ? (req.actor.agentId ?? null) : null,
      requestedAgentId: agentId,
    });
    res.json(await readAgentGatewayKey(input.deps, { companyId, agentId }));
  });

  router.post("/myrmidon/companies/:companyId/litellm/keys/:agentId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const agentId = req.params.agentId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    if (!settings().canManageKeys) {
      disabled(res);
      return;
    }
    const created = await createAgentGatewayKey(input.deps, { companyId, agentId });
    // The value is answered exactly once, to the board member who asked for it.
    res.status(201).json({ ...created.view, value: created.value });
  });

  router.post("/myrmidon/companies/:companyId/litellm/keys/:agentId/rotate", async (req, res) => {
    const companyId = req.params.companyId as string;
    const agentId = req.params.agentId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    if (!settings().canManageKeys) {
      disabled(res);
      return;
    }
    res.json(await rotateAgentGatewayKey(input.deps, { companyId, agentId }));
  });

  /**
   * The gateway's fallback topology, with its loops named. Exposed so an
   * operator can see BEFORE a write what a save would reject, and so the
   * deployed topology is checked against the same walk the save path uses —
   * the loops in it were found this way, not by the write path.
   */
  router.get("/myrmidon/companies/:companyId/litellm/fallbacks", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const current = settings();
    if (!current.canManageKeys || !current.baseUrl) {
      disabled(res);
      return;
    }
    res.json(await readGatewayFallbackTopology(input.deps, { companyId, settings: current }));
  });

  return router;
}

/** The real wiring for app.ts. */
export function myrmidonLitellmKeysRoutes(db: Db) {
  return litellmKeysRoutes(db, { deps: defaultAgentGatewayKeyDeps(db) });
}