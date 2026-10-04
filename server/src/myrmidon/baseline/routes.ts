// server/src/myrmidon/baseline/routes.ts
//
// myrmidon(1.6-BASELINE): the read API.
//
//   GET /api/myrmidon/companies/:companyId/baseline/metrics?from&to
//   POST /api/myrmidon/companies/:companyId/baseline/snapshots {from, to, label, pinned}
//   GET /api/myrmidon/companies/:companyId/baseline/snapshots
//   GET /api/myrmidon/companies/:companyId/baseline/snapshots/:id
//

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { eq, and } from "drizzle-orm";
import { assertCompanyAccess, assertBoard } from "../../routes/authz.js";
import { 
  computeBaselineMetrics, 
  parseBaselineWindow, 
  type BaselineMetricsResponse 
} from "./service.js";
import type { BaselineWindow } from "./metrics.js";
import { baselineMetricSnapshots } from "@paperclipai/db";

export interface BaselineRoutesDeps {
  now(): Date;
  /** Overridable in tests; the real wiring uses computeBaselineMetrics. */
  compute?(db: Db, companyId: string, window: BaselineWindow, now: Date): Promise<BaselineMetricsResponse>;
}

export function baselineRoutes(db: Db, deps: BaselineRoutesDeps) {
  const router = Router();
  const compute = deps.compute ?? computeBaselineMetrics;

  // Original metrics endpoint
  router.get("/myrmidon/companies/:companyId/baseline/metrics", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const window = parseBaselineWindow(req.query as Record<string, unknown>);
    const metrics = await compute(db, companyId, window, deps.now());
    res.json(metrics);
  });

  // Create a new baseline snapshot
  router.post("/myrmidon/companies/:companyId/baseline/snapshots", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId); // includes the 401 anonymous check
    assertBoard(req); // Only board/admin can create snapshots

    const { from, to, label, pinned } = req.body as {
      from: string;
      to: string;
      label?: string;
      pinned?: boolean;
    };

    // Validate and parse the window with the same rules as the metrics route
    // (required bounds, parseable dates, from <= to).
    const window = parseBaselineWindow({ from, to });

    // Compute the metrics for the given window
    const metrics = await compute(db, companyId, window, deps.now());

    // If pinned is true, unpin any existing pinned snapshot for this company
    if (pinned) {
      await db
        .update(baselineMetricSnapshots)
        .set({ pinned: false })
        .where(and(
          eq(baselineMetricSnapshots.companyId, companyId),
          eq(baselineMetricSnapshots.pinned, true)
        ));
    }

    // Insert the new snapshot
    const [snapshot] = await db
      .insert(baselineMetricSnapshots)
      .values({
        companyId,
        windowFrom: window.from,
        windowTo: window.to,
        generatedAt: deps.now(),
        payload: metrics,
        label,
        pinned: pinned || false
      })
      .returning();

    res.status(201).json(snapshot);
  });

  // Get all snapshots for a company
  router.get("/myrmidon/companies/:companyId/baseline/snapshots", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const snapshots = await db
      .select()
      .from(baselineMetricSnapshots)
      .where(eq(baselineMetricSnapshots.companyId, companyId));

    res.json(snapshots);
  });

  // Get a specific snapshot by ID
  router.get("/myrmidon/companies/:companyId/baseline/snapshots/:snapshotId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const snapshotId = req.params.snapshotId as string;
    assertCompanyAccess(req, companyId);

    const snapshot = await db
      .select()
      .from(baselineMetricSnapshots)
      .where(and(
        eq(baselineMetricSnapshots.id, snapshotId),
        eq(baselineMetricSnapshots.companyId, companyId)
      ))
      .limit(1);

    if (snapshot.length === 0) {
      return res.status(404).json({ error: "Snapshot not found" });
    }

    res.json(snapshot[0]);
  });

  return router;
}

/** The real wiring. */
export function myrmidonBaselineRoutes(db: Db) {
  return baselineRoutes(db, { now: () => new Date() });
}