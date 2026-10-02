// myrmidon(1.6-SKILL-LIFE): the skill lifecycle API.
//
//   GET  /api/myrmidon/companies/:companyId/skill-lifecycle                       (company access)
//   GET  /api/myrmidon/companies/:companyId/skill-lifecycle/:skillId              (company access)
//   GET  /api/myrmidon/companies/:companyId/skill-lifecycle/:skillId/history      (company access)
//   POST /api/myrmidon/companies/:companyId/skill-lifecycle/:skillId/promote-request (board)
//   POST /api/myrmidon/companies/:companyId/skill-lifecycle/:skillId/promote      (board; consumes an approved approval)
//   POST /api/myrmidon/companies/:companyId/skill-lifecycle/:skillId/deprecate    (board)
//   POST /api/myrmidon/companies/:companyId/skill-lifecycle/:skillId/rollback     (board)
//   POST /api/myrmidon/companies/:companyId/skill-lifecycle/:skillId/candidate    (board)
//
// Reads answer the state, the history and who approved. Mutations are
// board-only: promotion additionally needs an approved approval of type
// `skill_promotion` (the existing approvals pipeline), so a candidate cannot
// become verified without a decision.

import { Router } from "express";
import { z } from "zod";
import { conflict, unprocessable } from "../../errors.js";
import { validate } from "../../middleware/validate.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "../../routes/authz.js";
import { SkillLifecycleError } from "./domain.js";
import type { SkillLifecycleActor, SkillLifecycleService } from "./service.js";

const promoteSchema = z.object({ approvalId: z.string().min(1) });
const promoteRequestSchema = z.object({ note: z.string().max(2000).optional().nullable() });
const deprecateSchema = z.object({ reason: z.string().max(2000).optional().nullable() });

export interface SkillLifecycleRoutesDeps {
  service: SkillLifecycleService;
  createPromotionApproval(input: {
    companyId: string;
    skillId: string;
    skillKey: string;
    note: string | null;
    requestedByUserId: string | null;
    requestedByAgentId: string | null;
  }): Promise<{ approvalId: string }>;
}

function actorOf(req: Parameters<typeof getActorInfo>[0]): SkillLifecycleActor {
  const info = getActorInfo(req);
  if (info.actorType === "agent") return { actorType: "agent", actorId: info.agentId ?? info.actorId };
  return { actorType: "user", actorId: info.actorId };
}

/** Map the domain refusals onto HTTP: a bad approval is a 422, the rest a 409. */
function lifecycleError(error: unknown): never {
  if (error instanceof SkillLifecycleError) {
    const details = { code: error.code };
    if (error.code.startsWith("promotion_")) throw unprocessable(error.message, details);
    if (error.code === "skill_not_found") throw conflict("Skill not found", details);
    throw conflict(error.message, details);
  }
  throw error;
}

export function skillLifecycleRoutes(deps: SkillLifecycleRoutesDeps) {
  const router = Router();
  const base = "/myrmidon/companies/:companyId/skill-lifecycle";

  router.get(base, async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json({ skills: await deps.service.list(companyId) });
  });

  router.get(`${base}/:skillId`, async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    try {
      res.json(await deps.service.state(companyId, req.params.skillId as string));
    } catch (error) {
      lifecycleError(error);
    }
  });

  router.get(`${base}/:skillId/history`, async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    try {
      res.json({ events: await deps.service.history(companyId, req.params.skillId as string) });
    } catch (error) {
      lifecycleError(error);
    }
  });

  router.post(`${base}/:skillId/promote-request`, validate(promoteRequestSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const skill = await deps.service.state(companyId, skillId).catch((error: unknown) => lifecycleError(error));
    const info = getActorInfo(req);
    const created = await deps.createPromotionApproval({
      companyId,
      skillId,
      skillKey: skill.key,
      note: (req.body as { note?: string | null }).note ?? null,
      requestedByUserId: info.actorType === "user" ? info.actorId : null,
      requestedByAgentId: info.actorType === "agent" ? info.agentId ?? null : null,
    });
    res.status(201).json(created);
  });

  router.post(`${base}/:skillId/promote`, validate(promoteSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    try {
      res.json(
        await deps.service.promote(companyId, req.params.skillId as string, {
          approvalId: (req.body as { approvalId: string }).approvalId,
          actor: actorOf(req),
        }),
      );
    } catch (error) {
      lifecycleError(error);
    }
  });

  router.post(`${base}/:skillId/deprecate`, validate(deprecateSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    try {
      res.json(
        await deps.service.deprecate(companyId, req.params.skillId as string, {
          reason: (req.body as { reason?: string | null }).reason ?? null,
          actor: actorOf(req),
        }),
      );
    } catch (error) {
      lifecycleError(error);
    }
  });

  router.post(`${base}/:skillId/rollback`, async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    try {
      res.json(await deps.service.rollback(companyId, req.params.skillId as string, actorOf(req)));
    } catch (error) {
      lifecycleError(error);
    }
  });

  router.post(`${base}/:skillId/candidate`, async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    try {
      res.json(await deps.service.setCandidate(companyId, req.params.skillId as string, actorOf(req)));
    } catch (error) {
      lifecycleError(error);
    }
  });

  return router;
}