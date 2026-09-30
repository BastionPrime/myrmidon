// Board self-deploy (myrmidon R5-A): routes.
//
//   GET    /api/myrmidon/deploy-jobs          — the live (or last) job + history
//   POST   /api/myrmidon/deploy-jobs/preview  — verify a digest, change nothing
//   POST   /api/myrmidon/deploy-jobs          — start a deploy job
//   POST   /api/myrmidon/deploy-jobs/:id/abort — abort before the image switch
//
// Reads are board-wide (any board member sees the deploy state — it pauses
// their agents); writes are instance-admin only, the same rule as maintenance.

import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { HttpError, badRequest, conflict, notFound } from "../../errors.js";
import { validate } from "../../middleware/validate.js";
import { assertBoardOrgAccess, assertInstanceAdmin, getActorInfo } from "../../routes/authz.js";
import { digestProblem } from "./domain.js";
import { DeployJobError, type DeployJobsService } from "./service.js";

const UUID = z.string().uuid();

export const deployJobCreateSchema = z
  .object({
    reference: z.string().trim().min(1).max(200),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

export const deployJobPreviewSchema = z
  .object({
    reference: z.string().trim().min(1).max(200),
  })
  .strict();

function toHttpError(err: unknown): unknown {
  if (!(err instanceof DeployJobError)) return err;
  if (err.status === 404) return notFound(err.message);
  if (err.status === 409) return conflict(err.message);
  if (err.status === 503) return new HttpError(503, err.message);
  return badRequest(err.message);
}

export function deployJobsRoutes(_db: Db, service: DeployJobsService) {
  const router = Router();

  router.get("/myrmidon/deploy-jobs", async (req, res) => {
    assertBoardOrgAccess(req);
    res.json(await service.current());
  });

  router.post("/myrmidon/deploy-jobs/preview", validate(deployJobPreviewSchema), async (req, res) => {
    assertBoardOrgAccess(req);
    const reference = (req.body as z.infer<typeof deployJobPreviewSchema>).reference;
    const problem = digestProblem(reference);
    if (problem) throw badRequest(problem);
    res.json(await service.preview(reference));
  });

  router.post("/myrmidon/deploy-jobs", validate(deployJobCreateSchema), async (req, res) => {
    assertInstanceAdmin(req);
    const actor = getActorInfo(req);
    const body = req.body as z.infer<typeof deployJobCreateSchema>;
    try {
      res.status(201).json(await service.create(body, { actorType: actor.actorType, actorId: actor.actorId }));
    } catch (err) {
      throw toHttpError(err);
    }
  });

  router.post("/myrmidon/deploy-jobs/:id/abort", validate(z.object({ id: UUID }).strict()), async (req, res) => {
    assertInstanceAdmin(req);
    const actor = getActorInfo(req);
    try {
      res.json(await service.abort((req.body as { id: string }).id, { actorType: actor.actorType, actorId: actor.actorId }));
    } catch (err) {
      throw toHttpError(err);
    }
  });

  return router;
}

