// server/src/myrmidon/cto-chat/routes.ts
//
// myrmidon(1.6-CTO-CHAT-B): the HTTP entry of the planner.
//
// POST /api/myrmidon/cto-chat/plan — the owner's free text in, a proposed epic
// with child tasks out. The chat screen (the portal half of this feature) calls
// it over HTTP rather than through the chat socket: the socket carries the
// conversation, this call is one deliberate "build me an epic" action, and a
// proposal is a request/response thing, not a stream.
//
// The route CREATES NOTHING. It answers with a proposal; the caller decides
// whether to show it and, if it wants an approval card, which task to put it on.
// That keeps the planner safe to call from a chat composer while the owner is
// still typing, and it keeps task creation on the card's own acceptance path.
//
// Shapes:
//   200 { proposal: { planId, epic, epicClientKey, tasks[] } }
//   400 body fails ctoChatPlanRequestSchema (repo convention)
//   503 the planner is not configured, or its model key is not available
//
// `hostIssueId` is optional and only selects the task the caller wants the
// proposal to be discussed on; when it is absent the proposal is not attached
// anywhere and nothing about it is stored.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import type { Request, Response } from "express";

import { ctoChatPlanRequestSchema } from "@paperclipai/shared";

import { assertCompanyAccess } from "../../routes/authz.js";
import { badRequest } from "../../errors.js";
import { validate } from "../../middleware/validate.js";
import { generateCtoChatPlan, CtoChatPlanError } from "./plan-generator.js";
import {
  ctoChatSettingsProblem,
  readCtoChatSettings,
  type CtoChatSettings,
} from "./settings.js";
import { CtoChatRuntimeError, type CtoChatRuntime } from "./runtime.js";

export interface CtoChatRouteDeps {
  runtime?: CtoChatRuntime;
}

/**
 * The error body every CTO chat failure uses. The code is the stable part; the
 * message is written for a person and never carries model output or a key.
 */
function sendPlannerError(res: Response, error: unknown) {
  if (error instanceof CtoChatRuntimeError) {
    res.status(503).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof CtoChatPlanError) {
    const status = error.code === "planner_disabled" ? 503 : 400;
    res.status(status).json({ error: error.message, code: error.code });
    return;
  }
  throw error;
}

export function myrmidonCtoChatRoutes(
  db: Db,
  settings: CtoChatSettings = readCtoChatSettings(),
  deps: CtoChatRouteDeps = {},
) {
  const router = Router();
  // Built lazily so a planner that is not configured never touches the secrets
  // service at route-construction time (the module is mounted for every start).
  let runtime: CtoChatRuntime | null = deps.runtime ?? null;
  const resolveRuntime = async (): Promise<CtoChatRuntime> => {
    if (runtime) return runtime;
    const { createCtoChatRuntime } = await import("./runtime.js");
    runtime = createCtoChatRuntime(db, settings);
    return runtime;
  };

  router.post(
    "/myrmidon/cto-chat/plan",
    validate(ctoChatPlanRequestSchema),
    async (req: Request, res: Response) => {
      const companyId = planRouteCompanyId(req);
      assertCompanyAccess(req, companyId);
      const problem = ctoChatSettingsProblem(settings);
      if (problem) {
        res.status(503).json({ error: problem, code: "planner_disabled" });
        return;
      }
      const body = req.body as { text: string };
      try {
        const active = await resolveRuntime();
        const result = await active.plan({
          companyId,
          text: body.text,
          planId: active.mintPlanId(),
        });
        res.json({ proposal: result.plan, payload: result.payload });
      } catch (error) {
        sendPlannerError(res, error);
      }
    },
  );

  return router;
}

/**
 * The planner is company-scoped through the caller's own company context: a
 * proposal must not be planned against a company the caller cannot see, and the
 * planner has no company picker of its own to trust. The chat screen knows which
 * company it is showing and passes the id; a caller that omits it is served from
 * its own actor context when that carries exactly one company.
 */
export function planRouteCompanyId(req: Request): string {
  const raw = req.query.companyId;
  const fromQuery = typeof raw === "string" ? raw.trim() : "";
  if (fromQuery.length > 0) return fromQuery;
  const actorCompanyId =
    req.actor && (req.actor.type === "board" || req.actor.type === "agent")
      ? req.actor.companyId
      : null;
  if (actorCompanyId) return actorCompanyId;
  throw badRequest("companyId is required");
}

/** Re-exported so the index (and a test) can reach them from one place. */
export { CtoChatRuntimeError } from "./runtime.js";
export { readCtoChatSettings, ctoChatSettingsProblem } from "./settings.js";
export type { CtoChatSettings } from "./settings.js";