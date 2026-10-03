// server/src/myrmidon/litellm-costs/routes.ts
//
// myrmidon(M2-A): the read API for gateway-collected costs and the model
// catalog, plus the manual sweep trigger.
//
//   GET  /api/myrmidon/companies/:companyId/litellm/costs?from&to&limit
//   GET  /api/myrmidon/companies/:companyId/litellm/models
//   POST /api/myrmidon/companies/:companyId/litellm/sweep        (board only)
//
// Reads need company access (the same check the vendor costs routes use);
// the sweep trigger additionally needs a board actor — it spends a real
// gateway request. All three answer 503 with `enabled: false` in the body
// while the instance switch is off, so the UI can say why the list is empty
// instead of showing a bare error.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { secretService } from "../../services/index.js";
import { assertBoard, assertCompanyAccess } from "../../routes/authz.js";
import { parseCostDateRange } from "../../routes/costs.js";
import {
  createLitellmGatewayClient,
  listLitellmCostEvents,
  listLitellmModels,
  readLitellmCostSettings,
  sweepLitellmCosts,
} from "./litellm-costs.js";
import { listGatewayBotKeys } from "./bot-keys.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export interface LitellmCostsRoutesDeps {
  /** How the gateway key value is resolved; the real wiring reads the company secret. */
  readGatewayKey(companyId: string, secretName: string): Promise<string | null>;
  /** Bot keys of the company (agentId + key value). */
  listBotKeys(companyId: string): Promise<{ agentId: string; keyValue: string }[]>;
  /** Client factory, overridable in tests. */
  client: (baseUrl: string, keyValue: string) => ReturnType<typeof createLitellmGatewayClient>;
  env?: NodeJS.ProcessEnv;
  now(): Date;
}

export function litellmCostsRoutes(db: Db, deps: LitellmCostsRoutesDeps) {
  const router = Router();
  const settings = () => readLitellmCostSettings(deps.env ?? process.env);

  router.get("/myrmidon/companies/:companyId/litellm/costs", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const current = settings();
    if (!current.enabled) {
      res.status(503).json({ error: "LLM gateway cost collection is not enabled", enabled: false });
      return;
    }
    const range = parseCostDateRange(req.query as Record<string, unknown>);
    const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
    const limit = rawLimit && Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 500;
    const rows = await listLitellmCostEvents(db, companyId, range, limit);
    res.json(rows);
  });

  router.get("/myrmidon/companies/:companyId/litellm/models", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const current = settings();
    if (!current.enabled) {
      res.status(503).json({ error: "LLM gateway cost collection is not enabled", enabled: false });
      return;
    }
    res.json(await listLitellmModels(db));
  });

  router.post("/myrmidon/companies/:companyId/litellm/sweep", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const current = settings();
    if (!current.enabled) {
      res.status(503).json({ error: "LLM gateway cost collection is not enabled", enabled: false });
      return;
    }
    // myrmidon(HERMES-USAGE-COST): { from: "YYYY-MM-DD" | ISO } pins the
    // sweep's window start so the board can backfill a month the sweep never
    // collected (e.g. October's unpriced runs). Invalid or future values are
    // ignored — the sweep then behaves exactly as before.
    const rawFrom = asRecord(req.body)?.from;
    const from = typeof rawFrom === "string" ? new Date(rawFrom) : undefined;
    const opts = from && !Number.isNaN(from.getTime()) ? { from } : {};
    const result = await sweepLitellmCosts(
      {
        db,
        readGatewayKey: deps.readGatewayKey,
        listBotKeys: deps.listBotKeys,
        client: deps.client,
        now: deps.now,
      },
      companyId,
      current,
      opts,
    );
    res.json(result);
  });

  return router;
}

/** The real wiring: gateway key and bot keys from the company secret store. */
export function myrmidonLitellmCostsRoutes(db: Db) {
  const secrets = secretService(db);
  return litellmCostsRoutes(db, {
    readGatewayKey: (companyId, secretName) =>
      secrets.getByName(companyId, secretName).then((row) =>
        row ? secrets.resolveSecretValue(companyId, row.id, "latest") : null,
      ),
    listBotKeys: (companyId) => listGatewayBotKeys(db, companyId),
    client: createLitellmGatewayClient,
    now: () => new Date(),
  });
}
