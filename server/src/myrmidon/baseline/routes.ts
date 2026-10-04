// server/src/myrmidon/baseline/routes.ts
//
// myrmidon(1.6-BASELINE): the read API.
//
//   GET /api/myrmidon/companies/:companyId/baseline/metrics?from&to
//   POST /api/myrmidon/companies/:companyId/baseline/snapshots {from, to, label, pinned}
//   GET /api/myrmidon/companies/:companyId/baseline/snapshots
//   GET /api/myrmidon/companies/:companyId/baseline/snapshots/:id

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { and, eq, isNull, isNotNull, sql } from "drizzle-orm";
import { assertCompanyAccess } from "../../routes/authz.js";
import { 
  computeBaselineMetrics, 
  parseBaselineWindow, 
  type BaselineMetricsResponse 
} from "./service.js";
import type { BaselineWindow } from "./metrics.js";
import { baselineMetricSnapshots } from "@paperclipai/db";
import { badRequest, forbidden, internalServerError } from "../../errors.js";

export interface BaselineRoutesDeps {
  now(): Date;
  /** Overridable in tests; the real wiring uses computeBaselineMetrics. */
  compute?(db: Db, companyId: string, window: BaselineWindow, now: Date): Promise<BaselineMetricsResponse>;
}

export function baselineRoutes(db: Db, deps: BaselineRoutesDeps) {
  const router = Router();
  const compute = deps.compute ?? computeBaselineMetrics;

  // Original endpoint for computing metrics on-the-fly
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
    assertCompanyAccess(req, companyId);

    // Only board access is allowed for creating snapshots (not agent keys)
    if (req.actor.type !== "board") {
      throw forbidden("Only board users can create baseline snapshots");
    }

    const { from, to, label, pinned } = req.body as {
      from: string;
      to: string;
      label?: string;
      pinned?: boolean;
    };

    if (!from || !to) {
      throw badRequest("Both 'from' and 'to' are required");
    }

    const window: BaselineWindow = {
      from: new Date(from),
      to: new Date(to)
    };

    if (window.from.getTime() > window.to.getTime()) {
      throw badRequest("'from' must not be after 'to'");
    }

    // Compute the metrics for the specified window
    const metrics = await compute(db, companyId, window, deps.now());

    // If pinned is true, unpin any currently pinned snapshots for this company
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
    const result = await db
      .insert(baselineMetricSnapshots)
      .values({
        companyId,
        windowFrom: window.from,
        windowTo: window.to,
        generatedAt: deps.now(),
        label: label || null,
        pinned: pinned || false,
        payload: metrics as unknown as Record<string, unknown>,
      })
      .returning();

    res.status(201).json({
      id: result[0]?.id,
      companyId,
      windowFrom: window.from.toISOString(),
      windowTo: window.to.toISOString(),
      generatedAt: result[0]?.generatedAt,
      label: result[0]?.label,
      pinned: result[0]?.pinned,
    });
  });

  // Get all snapshots for a company
  router.get("/myrmidon/companies/:companyId/baseline/snapshots", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const snapshots = await db
      .select({
        id: baselineMetricSnapshots.id,
        companyId: baselineMetricSnapshots.companyId,
        windowFrom: baselineMetricSnapshots.windowFrom,
        windowTo: baselineMetricSnapshots.windowTo,
        generatedAt: baselineMetricSnapshots.generatedAt,
        label: baselineMetricSnapshots.label,
        pinned: baselineMetricSnapshots.pinned,
      })
      .from(baselineMetricSnapshots)
      .where(eq(baselineMetricSnapshots.companyId, companyId))
      .orderBy(baselineMetricSnapshots.generatedAt);

    res.json(snapshots);
  });

  // Get a specific snapshot by ID
  router.get("/myrmidon/companies/:companyId/baseline/snapshots/:snapshotId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const snapshotId = req.params.snapshotId as string;
    assertCompanyAccess(req, companyId);

    const snapshot = await db
      .select({
        id: baselineMetricSnapshots.id,
        companyId: baselineMetricSnapshots.companyId,
        windowFrom: baselineMetricSnapshots.windowFrom,
        windowTo: baselineMetricSnapshots.windowTo,
        generatedAt: baselineMetricSnapshots.generatedAt,
        label: baselineMetricSnapshots.label,
        pinned: baselineMetricSnapshots.pinned,
        payload: baselineMetricSnapshots.payload,
      })
      .from(baselineMetricSnapshots)
      .where(and(
        eq(baselineMetricSnapshots.id, snapshotId),
        eq(baselineMetricSnapshots.companyId, companyId)
      ))
      .limit(1);

    if (snapshot.length === 0) {
      res.status(404).json({ error: "Snapshot not found" });
      return;
    }

    res.json(snapshot[0]);
  });

  return router;
}

/** The real wiring. */
export function myrmidonBaselineRoutes(db: Db) {
  return baselineRoutes(db, { now: () => new Date() });
}