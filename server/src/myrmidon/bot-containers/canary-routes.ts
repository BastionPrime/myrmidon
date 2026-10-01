// myrmidon(R5-B): bot image canary routes.
//
//   GET    /api/myrmidon/bot-canary           — the live (or last) rollout + history
//   POST   /api/myrmidon/bot-canary/preview   — verify a digest, change nothing
//   POST   /api/myrmidon/bot-canary           — start a rollout
//   POST   /api/myrmidon/bot-canary/:id/abort — abort before the canary switch
//
// Reads are board-wide (any board member sees the rollout state — it pauses
// their bots); writes are instance-admin only, the same rule as maintenance
// and the board self-deploy.

import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { HttpError, badRequest, conflict, notFound } from "../../errors.js";
import { validate } from "../../middleware/validate.js";
import { assertBoardOrgAccess, assertInstanceAdmin, getActorInfo } from "../../routes/authz.js";
import { botCanaryReferenceProblem } from "./canary-domain.js";
import { BotCanaryError, type BotCanaryService } from "./canary-service.js";

const UUID = z.string().uuid();

export const botCanaryCreateSchema = z
  .object({
    reference: z.string().trim().min(1).max(200),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

export const botCanaryPreviewSchema = z
  .object({
    reference: z.string().trim().min(1).max(200),
  })
  .strict();

function toHttpError(err: unknown): unknown {
  if (!(err instanceof BotCanaryError)) return err;
  if (err.status === 404) return notFound(err.message);
  if (err.status === 409) return conflict(err.message);
  if (err.status === 503) return new HttpError(503, err.message);
  return badRequest(err.message);
}

export function botCanaryRoutes(_db: Db, service: BotCanaryService) {
  const router = Router();

  router.get("/myrmidon/bot-canary", async (req, res) => {
    assertBoardOrgAccess(req);
    res.json(await service.current());
  });

  router.post("/myrmidon/bot-canary/preview", validate(botCanaryPreviewSchema), async (req, res) => {
    assertBoardOrgAccess(req);
    const reference = (req.body as z.infer<typeof botCanaryPreviewSchema>).reference;
    const problem = botCanaryReferenceProblem(reference);
    if (problem) throw badRequest(problem);
    res.json(await service.preview(reference));
  });

  router.post("/myrmidon/bot-canary", validate(botCanaryCreateSchema), async (req, res) => {
    assertInstanceAdmin(req);
    const actor = getActorInfo(req);
    const body = req.body as z.infer<typeof botCanaryCreateSchema>;
    try {
      res.status(201).json(await service.create(body, { actorType: actor.actorType, actorId: actor.actorId }));
    } catch (err) {
      throw toHttpError(err);
    }
  });

  router.post("/myrmidon/bot-canary/:id/abort", validate(z.object({ id: UUID }).strict()), async (req, res) => {
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
