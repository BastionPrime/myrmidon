// myrmidon(1.6-AUTONOMY): the autonomy API — /api/myrmidon/autonomy/*.
//
//   GET    /api/myrmidon/autonomy                          -> { matrix, regulations, changeLog }
//   PATCH  /api/myrmidon/autonomy/matrix                   -> { matrix }   (board)
//   POST   /api/myrmidon/autonomy/regulations              -> { regulation } (board)
//   PATCH  /api/myrmidon/autonomy/regulations/:id          -> { regulation } (board)
//   POST   /api/myrmidon/autonomy/regulations/:id/approve  -> { regulation } (board)
//   POST   /api/myrmidon/autonomy/regulations/:id/revisions/:rev/restore -> { regulation } (board)
//   DELETE /api/myrmidon/autonomy/regulations/:id          -> { id }       (board)
//
// The company is resolved from the caller's context: the `companyId` query
// parameter first (the way the fleet console and access-hub do it), then the
// caller's single active company membership. Zero or several ambiguous
// memberships without the parameter answer 422. The paths carry no
// `:companyId`, so the UI can use the company it already has client-side.
//
// Reads need company access; every mutation needs a board actor — the matrix
// is the operator's control, so an agent never edits its own permissions.
// Regulations are board-only too, which is why approval here is a direct board
// action rather than an approval card: the card pipeline (tool action requests
// + the owner card) exists for actions an agent attempts at an enforcement
// point, and there is deliberately no second approval queue.

import { Router, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import {
  autonomyMatrixPatchSchema,
  type AutonomyActorRef,
  type AutonomyMatrix,
} from "@paperclipai/shared";
import { badRequest, unprocessable } from "../../errors.js";
import { validate } from "../../middleware/validate.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "../../routes/authz.js";
import { logActivity } from "../../services/activity-log.js";
import {
  autonomyService,
  dbAutonomyChangeLog,
  type AutonomyFailure,
  type AutonomyResult,
  type AutonomyServiceDeps,
} from "./service.js";
import { dbAutonomyStore } from "./store.js";

const regulationCreateSchema = z.object({
  role: z.string().min(1).max(120),
  title: z.string().min(1).max(300),
  bodyMarkdown: z.string().max(200000),
});

const regulationUpdateSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  bodyMarkdown: z.string().max(200000).optional(),
});

/** Turn a typed service refusal into the right HTTP status. */
function respondFailure(res: Response, failure: AutonomyFailure) {
  switch (failure.kind) {
    case "version_conflict":
      res.status(409).json({
        error: "Autonomy matrix version conflict",
        code: "autonomy_version_conflict",
        expectedVersion: failure.expectedVersion,
        actualVersion: failure.actualVersion,
      });
      return;
    case "regulation_not_found":
      res.status(404).json({ error: "Regulation not found", code: "autonomy_regulation_not_found" });
      return;
    case "revision_not_found":
      res.status(404).json({ error: "Regulation revision not found", code: "autonomy_revision_not_found" });
      return;
    case "already_approved":
      res.status(409).json({ error: "Regulation is already approved", code: "autonomy_already_approved" });
      return;
    case "not_approved":
      res.status(409).json({ error: "Regulation is not approved", code: "autonomy_not_approved" });
      return;
  }
}

/** The actor the change log records. */
function actorFromRequest(req: Request): AutonomyActorRef {
  const info = getActorInfo(req);
  if (info.actorType === "agent" && info.agentId) return { type: "agent", id: info.agentId };
  if (info.actorType === "user") return { type: "board", id: info.actorId };
  return { type: "system", id: "system" };
}

const ACTIVITY_ACTOR_TYPE = { board: "user", agent: "agent", system: "system" } as const;

/**
 * Resolve the company for a pathless route: the `companyId` query parameter
 * first, then the caller's single active company membership. The same rule as
 * the access-hub routes, so one UI client can call both.
 */
function resolveCompanyId(req: Request): string {
  const fromQuery = typeof req.query.companyId === "string" ? req.query.companyId : "";
  if (fromQuery) return fromQuery;
  const actor = req.actor as { companyIds?: string[]; isInstanceAdmin?: boolean; source?: string };
  const ids = actor.companyIds ?? [];
  if (ids.length === 1) return ids[0]!;
  throw unprocessable(
    ids.length === 0
      ? "companyId query parameter is required (no company membership)"
      : "companyId query parameter is required (multiple company memberships)",
  );
}

export interface AutonomyRoutesDeps {
  store: AutonomyServiceDeps["store"];
  listChangeLog: AutonomyServiceDeps["listChangeLog"];
  /** The audit sink. Production wires the activity log over the database; tests record. */
  logActivity: AutonomyServiceDeps["logActivity"];
  now?: () => Date;
  newId?: () => string;
}

/** Wire the routes with the default (database-backed) dependencies. */
export function myrmidonAutonomyRoutes(db: Db) {
  return autonomyRoutes({
    store: dbAutonomyStore(db),
    listChangeLog: dbAutonomyChangeLog(db),
    logActivity: async (input) => {
      await logActivity({
        companyId: input.companyId,
        actorType: ACTIVITY_ACTOR_TYPE[input.actorType] ?? "system",
        actorId: input.actorId,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        details: input.details,
      } as Parameters<typeof logActivity>[1]);
    },
  });
}

/**
 * The injected form: production passes the db-backed store, change log and
 * activity sink, tests pass in-memory ones. The express router itself is real
 * in both.
 */
export function autonomyRoutes(deps: AutonomyRoutesDeps) {
  const router = Router();
  const service = autonomyService({
    store: deps.store,
    listChangeLog: deps.listChangeLog,
    now: deps.now ?? (() => new Date()),
    newId: deps.newId ?? (() => randomUUID()),
    logActivity: deps.logActivity,
  });

  function companyOf(req: Request): string {
    const companyId = resolveCompanyId(req);
    assertCompanyAccess(req, companyId);
    return companyId;
  }

  router.get("/myrmidon/autonomy", async (req, res) => {
    const companyId = companyOf(req);
    res.json(await service.snapshot(companyId));
  });

  router.patch("/myrmidon/autonomy/matrix", validate(autonomyMatrixPatchSchema), async (req, res) => {
    const companyId = companyOf(req);
    assertBoard(req);
    const result: AutonomyResult<AutonomyMatrix> = await service.updateMatrix(
      companyId,
      actorFromRequest(req),
      req.body as z.infer<typeof autonomyMatrixPatchSchema>,
    );
    if (!result.ok) {
      respondFailure(res, result.failure);
      return;
    }
    res.json({ matrix: result.value });
  });

  router.post("/myrmidon/autonomy/regulations", validate(regulationCreateSchema), async (req, res) => {
    const companyId = companyOf(req);
    assertBoard(req);
    const result = await service.createRegulation(
      companyId,
      actorFromRequest(req),
      req.body as z.infer<typeof regulationCreateSchema>,
    );
    if (!result.ok) {
      respondFailure(res, result.failure);
      return;
    }
    res.status(201).json({ regulation: result.value });
  });

  router.patch("/myrmidon/autonomy/regulations/:id", validate(regulationUpdateSchema), async (req, res) => {
    const companyId = companyOf(req);
    assertBoard(req);
    const id = String(req.params.id ?? "");
    if (!id) throw badRequest("Regulation id is required");
    const result = await service.updateRegulation(companyId, actorFromRequest(req), {
      id,
      ...(req.body as z.infer<typeof regulationUpdateSchema>),
    });
    if (!result.ok) {
      respondFailure(res, result.failure);
      return;
    }
    res.json({ regulation: result.value });
  });

  router.post("/myrmidon/autonomy/regulations/:id/approve", async (req, res) => {
    const companyId = companyOf(req);
    assertBoard(req);
    const result = await service.approveRegulation(companyId, actorFromRequest(req), String(req.params.id ?? ""));
    if (!result.ok) {
      respondFailure(res, result.failure);
      return;
    }
    res.json({ regulation: result.value });
  });

  router.post("/myrmidon/autonomy/regulations/:id/revisions/:rev/restore", async (req, res) => {
    const companyId = companyOf(req);
    assertBoard(req);
    const revision = Number(req.params.rev);
    if (!Number.isInteger(revision) || revision <= 0) throw badRequest("Revision must be a positive integer");
    const result = await service.restoreRegulationRevision(companyId, actorFromRequest(req), {
      id: String(req.params.id ?? ""),
      toRevision: revision,
    });
    if (!result.ok) {
      respondFailure(res, result.failure);
      return;
    }
    res.json({ regulation: result.value });
  });

  router.delete("/myrmidon/autonomy/regulations/:id", async (req, res) => {
    const companyId = companyOf(req);
    assertBoard(req);
    const result = await service.deleteRegulation(companyId, actorFromRequest(req), String(req.params.id ?? ""));
    if (!result.ok) {
      respondFailure(res, result.failure);
      return;
    }
    res.json({ id: result.value.id });
  });

  return router;
}