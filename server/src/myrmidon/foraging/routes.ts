// server/src/myrmidon/foraging/routes.ts
//
// myrmidon(1.6-FORAGE): the FORAGING API.
//
//   GET    /api/myrmidon/companies/:companyId/foraging/sources        (company access)
//   PUT    /api/myrmidon/companies/:companyId/foraging/sources        (board)
//   DELETE /api/myrmidon/companies/:companyId/foraging/sources/:id    (board)
//   GET    /api/myrmidon/companies/:companyId/foraging/findings       (company access)
//   GET    /api/myrmidon/companies/:companyId/foraging/budget         (company access)
//   POST   /api/myrmidon/companies/:companyId/foraging/sweep          (board; spends a read)
//
// Reads need company access; mutations need a board actor. The manual sweep
// additionally spends real external reads and is therefore board-only.
//
// While the sweep is switched off the reads still answer: the registry and the
// findings list are useful on their own, and the sweep trigger answers 503 with
// `enabled: false` so the screen can say why nothing runs.

import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../../middleware/validate.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "../../routes/authz.js";
import { logActivity } from "../../services/activity-log.js";
import { FORAGING_SOURCE_KINDS, type ForagingSourceKind } from "./domain.js";
import { readForagingSettings } from "./settings.js";
import type { ForagingService } from "./service.js";
import type { ForagingSourceRow, ForagingStore } from "./store.js";

const upsertSourceSchema = z.object({
  role: z.string().min(1).max(64),
  url: z.string().url().max(2048),
  kind: z.enum(FORAGING_SOURCE_KINDS).default("url"),
  enabled: z.boolean().optional(),
});

export interface ForagingRoutesDeps {
  /** Only for the audit rows; reads and writes go through the store. */
  db: Db;
  store: ForagingStore;
  service: ForagingService;
  env?: NodeJS.ProcessEnv;
}

function sourceView(row: ForagingSourceRow) {
  return {
    id: row.id,
    role: row.role,
    url: row.url,
    kind: row.kind,
    enabled: row.enabled,
    lastSnapshotAt: row.lastSnapshotAt,
    lastCheckedAt: row.lastCheckedAt,
    lastError: row.lastError,
    snapshotLines: row.lastSnapshot?.length ?? null,
  };
}

export function foragingRoutes(deps: ForagingRoutesDeps) {
  const router = Router();
  const base = "/myrmidon/companies/:companyId/foraging";
  const settings = () => readForagingSettings(deps.env ?? process.env);

  router.get(`${base}/sources`, async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rows = await deps.store.listSources(companyId);
    res.json({ sources: rows.map(sourceView), enabled: settings().enabled });
  });

  router.put(`${base}/sources`, validate(upsertSourceSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const body = req.body as z.infer<typeof upsertSourceSchema>;
    const row = await deps.store.upsertSource(companyId, {
      role: body.role,
      url: body.url,
      kind: body.kind as ForagingSourceKind,
      enabled: body.enabled,
    });
    const actor = getActorInfo(req);
    await logActivity(deps.db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "myrmidon.foraging.source_saved",
      entityType: "foraging_source",
      entityId: row.id,
      details: { role: row.role, kind: row.kind, enabled: row.enabled },
    });
    res.json(sourceView(row));
  });

  router.delete(`${base}/sources/:sourceId`, async (req, res) => {
    const companyId = req.params.companyId as string;
    const sourceId = req.params.sourceId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const removed = await deps.store.deleteSource(companyId, sourceId);
    if (!removed) {
      res.status(404).json({ error: "Source not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(deps.db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "myrmidon.foraging.source_removed",
      entityType: "foraging_source",
      entityId: sourceId,
      details: {},
    });
    res.json({ removed: true });
  });

  router.get(`${base}/findings`, async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : NaN;
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 200) : 50;
    const rows = await deps.store.listFindings(companyId, limit);
    res.json({ findings: rows, enabled: settings().enabled });
  });

  router.get(`${base}/budget`, async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const current = settings();
    const state = await deps.service.budgetState(companyId);
    res.json({
      enabled: current.enabled,
      budget: current.budget,
      spentCents: state.spentCents,
      minHostIntervalMs: current.minHostIntervalMs,
      intervalMs: current.intervalMs,
    });
  });

  router.post(`${base}/sweep`, async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    if (!settings().enabled) {
      res.status(503).json({ error: "Foraging is not enabled on this instance", enabled: false });
      return;
    }
    const result = await deps.service.runPass(companyId);
    const actor = getActorInfo(req);
    await logActivity(deps.db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "myrmidon.foraging.sweep_run",
      entityType: "company",
      entityId: companyId,
      details: { ...result },
    });
    res.json(result);
  });

  return router;
}