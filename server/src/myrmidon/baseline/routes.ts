// server/src/myrmidon/baseline/routes.ts
//
// myrmidon(1.6-BASELINE): the read API.
//
//   GET /api/myrmidon/companies/:companyId/baseline/metrics?from&to
//
// Company access is the same check the vendor costs routes and the gateway
// costs routes use. `from` and `to` are required ISO timestamps.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { assertCompanyAccess } from "../../routes/authz.js";
import { computeBaselineMetrics, parseBaselineWindow, type BaselineMetricsResponse } from "./service.js";
import type { BaselineWindow } from "./metrics.js";

export interface BaselineRoutesDeps {
  now(): Date;
  /** Overridable in tests; the real wiring uses computeBaselineMetrics. */
  compute?(db: Db, companyId: string, window: BaselineWindow, now: Date): Promise<BaselineMetricsResponse>;
}

export function baselineRoutes(db: Db, deps: BaselineRoutesDeps) {
  const router = Router();
  const compute = deps.compute ?? computeBaselineMetrics;

  router.get("/myrmidon/companies/:companyId/baseline/metrics", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const window = parseBaselineWindow(req.query as Record<string, unknown>);
    const metrics = await compute(db, companyId, window, deps.now());
    res.json(metrics);
  });

  return router;
}

/** The real wiring. */
export function myrmidonBaselineRoutes(db: Db) {
  return baselineRoutes(db, { now: () => new Date() });
}