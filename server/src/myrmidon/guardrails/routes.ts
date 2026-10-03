// server/src/myrmidon/guardrails/routes.ts
//
// myrmidon(1.6-GRD): the guardrail event journal API.
//
//   GET /api/myrmidon/companies/:companyId/guardrails/events?limit
//
// Read-only, company access (board members and the company's own agents),
// shaped after the evals routes. The layer is flag-only in 1.6.1: events
// are recorded by the run-output hook, never mutated through the API.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { assertCompanyAccess } from "../../routes/authz.js";
import { listGuardrailEvents } from "./events.js";

export interface GuardrailRoutesDeps {
  db: Db;
}

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

export function myrmidonGuardrailsRoutes(db: Db, _deps: Partial<GuardrailRoutesDeps> = {}) {
  const router = Router();

  router.get("/myrmidon/companies/:companyId/guardrails/events", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
    const limit =
      rawLimit !== undefined && Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(Math.floor(rawLimit), MAX_LIMIT)
        : DEFAULT_LIMIT;
    const events = await listGuardrailEvents(db, companyId, limit);
    res.json({ events, count: events.length, limit });
  });

  return router;
}
