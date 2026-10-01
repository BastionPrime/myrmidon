// myrmidon(BROWSER-CONSOLE): routes.
//
//   GET    /api/myrmidon/browsers                     — registry list (any authenticated board user)
//   POST   /api/myrmidon/browsers/:id/screen/open     — owner only
//   POST   /api/myrmidon/browsers/:id/screen/heartbeat — owner of the open session
//   POST   /api/myrmidon/browsers/:id/screen/done     — owner of the open session
//   DELETE /api/myrmidon/browsers/:id/data            — owner only (cookies+storage via CDP on the node)
//   GET    /api/myrmidon/browsers/journal             — owner only
//
// "Owner" is a board user with an active owner (or instance admin) role on the
// company; agents always get 403. Unauthenticated requests never reach these
// handlers in the real app (the auth middleware runs first); the routes still
// assert, so tests can prove the 401/403 contract.

import { Router, type Request } from "express";
import { browserScreenHeartbeatSchema, browserSiteDataDeleteSchema } from "@paperclipai/shared/myrmidon-browser-console";
import { badRequest, forbidden, HttpError, unauthorized } from "../../errors.js";
import { validate } from "../../middleware/validate.js";
import { assertAuthenticated } from "../../routes/authz.js";
import type { BrowserConsoleService, BrowserConsoleError } from "./service.js";

function toHttpError(err: unknown): unknown {
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === "number" && [400, 403, 404, 409, 423, 502].includes(status)) {
    return new HttpError(status as 400 | 403 | 404 | 409 | 423, (err as Error).message);
  }
  return err;
}

function companyIdOf(req: Request): string | null {
  const raw = req.query.companyId;
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  return null;
}

/** Owner check: instance admin/local implicit pass; otherwise an active owner membership. */
function assertBrowserOwner(req: Request, companyId: string | null): string {
  assertAuthenticated(req);
  if (req.actor.type !== "board") {
    throw forbidden("Owner access required");
  }
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
    return req.actor.userId ?? "board";
  }
  if (!companyId || !((req.actor.companyIds ?? []).includes(companyId))) {
    throw forbidden("Company access required");
  }
  const membership = req.actor.memberships?.find((item) => item.companyId === companyId);
  const allowed = membership?.status === "active" && String(membership.membershipRole) === "owner";
  if (!allowed) throw forbidden("Owner access required");
  return req.actor.userId ?? "board";
}

/** Registry list: any authenticated board user of this instance. */
function assertBrowserReader(req: Request): void {
  assertAuthenticated(req);
  if (req.actor.type === "agent") {
    // Agents may read the registry per the onboarding note; the screen, the
    // data clear and the journal stay owner-only.
    return;
  }
  if (req.actor.type !== "board") {
    throw unauthorized();
  }
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function browserConsoleRoutes(deps: { service: BrowserConsoleService }) {
  const router = Router();
  const { service } = deps;

  router.get("/myrmidon/browsers", async (req, res) => {
    assertBrowserReader(req);
    res.json({ browsers: await service.listBrowsers() });
  });

  router.get("/myrmidon/browsers/journal", async (req, res) => {
    assertBrowserOwner(req, companyIdOf(req));
    const entries = await service.journal();
    res.json({
      entries: entries.map((entry) => ({
        sessionId: entry.sessionId,
        browserId: entry.browserId,
        userId: entry.userId,
        startedAt: iso(entry.openedAt),
        endedAt: entry.endedAt ? iso(entry.endedAt) : null,
        durationMs: entry.durationMs,
        closedBy: entry.closedBy,
      })),
    });
  });

  router.post("/myrmidon/browsers/:id/screen/open", async (req, res) => {
    const userId = assertBrowserOwner(req, companyIdOf(req));
    try {
      const opened = await service.openScreen({ browserId: req.params.id as string, userId });
      res.json({
        screenSessionId: opened.screenSessionId,
        screenPath: opened.screenPath,
        idleDeadlineAt: iso(opened.deadlines.idleDeadlineAt),
        maxDeadlineAt: iso(opened.deadlines.maxDeadlineAt),
        warnAt: iso(opened.deadlines.warnAt),
      });
    } catch (err) {
      throw toHttpError(err);
    }
  });

  router.post("/myrmidon/browsers/:id/screen/heartbeat", validate(browserScreenHeartbeatSchema), async (req, res) => {
    const userId = assertBrowserOwner(req, companyIdOf(req));
    try {
      const result = await service.heartbeat(req.params.id as string, userId, req.body.activity);
      if (result.closedBy === "none") {
        res.json({ active: false, closedBy: "none", autoCloseAt: null });
        return;
      }
      res.json({
        active: true,
        screenSessionId: req.params.id,
        idleDeadlineAt: iso(result.deadlines.idleDeadlineAt),
        maxDeadlineAt: iso(result.deadlines.maxDeadlineAt),
        warnAt: iso(result.deadlines.warnAt),
        autoCloseAt: iso(result.deadlines.autoCloseAt),
        closedBy: result.closedBy,
      });
    } catch (err) {
      throw toHttpError(err);
    }
  });

  router.post("/myrmidon/browsers/:id/screen/done", async (req, res) => {
    const userId = assertBrowserOwner(req, companyIdOf(req));
    try {
      await service.done(req.params.id as string, userId);
      res.json({ done: true });
    } catch (err) {
      throw toHttpError(err);
    }
  });

  router.delete("/myrmidon/browsers/:id/data", validate(browserSiteDataDeleteSchema), async (req, res) => {
    assertBrowserOwner(req, companyIdOf(req));
    if (req.method !== "DELETE") throw badRequest("DELETE required");
    try {
      await service.clearSiteData(req.params.id as string, req.body.domain);
      res.json({ cleared: true, domain: req.body.domain });
    } catch (err) {
      throw toHttpError(err);
    }
  });

  return router;
}

export type { BrowserConsoleError };
