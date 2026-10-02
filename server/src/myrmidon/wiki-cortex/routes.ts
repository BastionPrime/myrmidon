// server/src/myrmidon/wiki-cortex/routes.ts
//
// myrmidon(1.6-WIKI): the API of company regulations.
//
//   GET  /api/myrmidon/companies/:companyId/wiki-regulations
//   GET  /api/myrmidon/companies/:companyId/wiki-regulations/approved/:role
//   GET  /api/myrmidon/companies/:companyId/wiki-regulations/*slug
//   PUT  /api/myrmidon/companies/:companyId/wiki-regulations/*slug          (draft)
//   POST /api/myrmidon/companies/:companyId/wiki-regulations/*slug/approve
//   POST /api/myrmidon/companies/:companyId/wiki-regulations/*slug/rollback
//
// A slug is a page key with slashes in it (`deploy/oncall`), so the routes use
// the Express 5 named wildcard (`*slug`); `slugOf` joins the segments back
// into the plain string the service normalizes.
//
// Reading and writing drafts is open to any actor with access to the company
// (the wiki maintainer agent writes drafts). Approving and rolling back change
// what the whole fleet reads, so those two are board-only.
//
// No database or service imports here: everything arrives through
// WikiRegulationRoutesDeps, so the suite runs the real routes with fakes (the
// real wiring is wiring.ts).

import { Router, type Request } from "express";
import { badRequest, notFound } from "../../errors.js";
import { assertBoard, assertCompanyAccess, hasCompanyAccess } from "../../routes/authz.js";
import type { RegulationActor } from "./types.js";
import type { WikiRegulationService } from "./service.js";
import type { RegulationPageRecord } from "./types.js";

export interface WikiRegulationActivityEntry {
  companyId: string;
  action: string;
  slug: string;
  details: Record<string, unknown>;
  actor: RegulationActor;
}

export interface WikiRegulationRoutesDeps {
  service: WikiRegulationService;
  /** Writes the mutation into the company activity log. Optional: tests pass none. */
  recordActivity?: (entry: WikiRegulationActivityEntry) => Promise<void>;
}

/** The actor of the request in the shape the wiki records revisions with. */
function actorOf(req: Request): RegulationActor {
  if (req.actor?.type === "agent") return { agentId: req.actor.agentId ?? null, userId: null };
  if (req.actor?.type === "board") return { agentId: null, userId: req.actor.userId ?? null };
  return { agentId: null, userId: null };
}

/**
 * The wildcard parameter of a slug route. Express 5 (path-to-regexp v8) hands
 * a named wildcard back as an array of segments; one segment arrives as a
 * plain string.
 */
function slugOf(req: Request): string {
  const raw = req.params.slug;
  const slug = Array.isArray(raw) ? raw.join("/") : (raw as string | undefined);
  return slug ?? "";
}

function pageView(page: RegulationPageRecord) {
  return {
    id: page.id,
    slug: page.slug,
    title: page.title,
    roles: page.roles,
    status: page.status,
    revisionNumber: page.revisionNumber,
    content: page.content,
    revisions: page.revisions,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
  };
}

function readString(body: Record<string, unknown>, field: string, required: boolean): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) {
    if (required) throw badRequest(`regulation ${field} is required`);
    return undefined;
  }
  if (typeof value !== "string") throw badRequest(`regulation ${field} must be a string`);
  return value;
}

function readRoles(body: Record<string, unknown>): string[] | undefined {
  const value = body.roles;
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((role) => typeof role !== "string")) {
    throw badRequest("regulation roles must be an array of strings");
  }
  return value as string[];
}

function readBody(req: Request): Record<string, unknown> {
  const body = req.body;
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) throw badRequest("request body must be an object");
  return body as Record<string, unknown>;
}

export function wikiRegulationRoutes(deps: WikiRegulationRoutesDeps) {
  const router = Router();
  const { service, recordActivity } = deps;
  const base = "/myrmidon/companies/:companyId/wiki-regulations";

  /**
   * The company of the path, shadowed the way the other myrmidon routes do it:
   * a caller without company access gets the same 404 as a missing company, so
   * the route answers no oracle about which companies exist.
   */
  function companyIdOf(req: Request): string {
    const companyId = req.params.companyId as string;
    if (!hasCompanyAccess(req, companyId)) throw notFound("Company not found");
    assertCompanyAccess(req, companyId);
    return companyId;
  }

  router.get(base, async (req, res) => {
    const companyId = companyIdOf(req);
    const pages = await service.list(companyId);
    res.json({ regulations: pages.map(pageView) });
  });

  // The resolver as an endpoint: what the delivery path reads for one role.
  router.get(`${base}/approved/:role`, async (req, res) => {
    const companyId = companyIdOf(req);
    const regulations = await service.resolved(companyId, req.params.role as string);
    res.json({ role: req.params.role, regulations });
  });

  router.get(`${base}/*slug`, async (req, res) => {
    const companyId = companyIdOf(req);
    const slug = slugOf(req);
    const page = await service.get(companyId, slug);
    if (!page) throw notFound(`Regulation not found: ${slug}`);
    res.json(pageView(page));
  });

  router.put(`${base}/*slug`, async (req, res) => {
    const companyId = companyIdOf(req);
    const body = readBody(req);
    const slug = slugOf(req);
    const changeSummary = readString(body, "changeSummary", false) ?? null;
    const page = await service.save(companyId, {
      slug,
      title: readString(body, "title", true) as string,
      roles: readRoles(body),
      content: readString(body, "content", true) as string,
      changeSummary,
      actor: actorOf(req),
    });
    await recordActivity?.({
      companyId,
      action: "wiki.regulation_draft_saved",
      slug: page.slug,
      details: { revisionNumber: page.revisionNumber, status: page.status, roles: page.roles },
      actor: actorOf(req),
    });
    res.json(pageView(page));
  });

  router.post(`${base}/*slug/approve`, async (req, res) => {
    assertBoard(req);
    const companyId = companyIdOf(req);
    const page = await service.approve(companyId, slugOf(req), actorOf(req));
    await recordActivity?.({
      companyId,
      action: "wiki.regulation_approved",
      slug: page.slug,
      details: { revisionNumber: page.revisionNumber },
      actor: actorOf(req),
    });
    res.json(pageView(page));
  });

  router.post(`${base}/*slug/rollback`, async (req, res) => {
    assertBoard(req);
    const companyId = companyIdOf(req);
    const slug = slugOf(req);
    const body = readBody(req);
    const revisionNumber = body.revisionNumber;
    if (typeof revisionNumber !== "number" || !Number.isInteger(revisionNumber) || revisionNumber < 1) {
      throw badRequest("rollback requires an integer revisionNumber of the revision to restore");
    }
    const before = await service.get(companyId, slug);
    if (!before) throw notFound(`Regulation not found: ${slug}`);
    const page = await service.rollback(companyId, slug, revisionNumber, actorOf(req));
    await recordActivity?.({
      companyId,
      action: "wiki.regulation_rolled_back",
      slug: page.slug,
      details: { restoredRevisionNumber: revisionNumber, revisionNumber: page.revisionNumber, status: page.status },
      actor: actorOf(req),
    });
    res.json(pageView(page));
  });

  return router;
}