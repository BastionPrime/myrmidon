// server/src/myrmidon/castes/routes.ts
//
// myrmidon(1.6.1 CUSTOM-CASTES A): the REST API of the company caste
// directory.
//
//   GET     /api/myrmidon/companies/:companyId/castes           (company access)
//   POST    /api/myrmidon/companies/:companyId/castes           (board only)
//   PATCH   /api/myrmidon/companies/:companyId/castes/:key      (board only)
//   DELETE  /api/myrmidon/companies/:companyId/castes/:key      (board only)
//
// Reads are open to any actor with company access (the agent editor and the
// swarm need the live directory). Mutations are board-only: the owner owns the
// directory. Authorization mirrors the model-providers routes:
// assertCompanyAccess first, assertBoard on mutations.
//
// DELETE accepts an optional body { "reassignTo": "<key>" } (annex 03.10):
// required when agents are on the caste, ignored otherwise.
//
// No database or service imports here: everything arrives through
// CasteRoutesDeps, so the suite runs the real routes with fakes (the real
// wiring is wiring.ts).

import { Router, type Request } from "express";
import {
  createCasteSchema,
  deleteCasteSchema,
  patchCasteSchema,
} from "@paperclipai/shared";
import type { ZodType } from "zod";
import { badRequest } from "../../errors.js";
import { assertBoard, assertCompanyAccess } from "../../routes/authz.js";
import type { CasteActivityEntry, CasteService } from "./service.js";

export interface CasteRoutesDeps {
  service: CasteService;
  /** Writes the mutation into the company activity log. Optional: tests pass none. */
  recordActivity?: (entry: CasteActivityEntry) => Promise<void>;
}

function bodyOf(req: Request): Record<string, unknown> {
  const body = req.body;
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

export function casteRoutes(deps: CasteRoutesDeps): Router {
  const router = Router();
  const activity = (entry: CasteActivityEntry) =>
    deps.recordActivity ? deps.recordActivity(entry) : Promise.resolve();

  const parse = <T>(schema: ZodType<T>, body: unknown): T => {
    const result = schema.safeParse(body);
    if (!result.success) {
      const issues = result.error?.issues ?? [];
      const first = issues[0];
      const path = first?.path?.length ? `${first.path.join(".")}: ` : "";
      throw badRequest(`${path}${first?.message ?? "invalid request body"}`);
    }
    return result.data;
  };

  // express.json() skips DELETE by default; the annex DELETE body
  // ({"reassignTo": ...}) needs explicit parsing.
  router.use("/myrmidon/companies/:companyId/castes/:key", (req, _res, next) => {
    if (req.method !== "DELETE" || req.body !== undefined) {
      next();
      return;
    }
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      raw += chunk;
    });
    req.on("end", () => {
      (req as { body?: unknown }).body = raw.trim() ? safeJsonParse(raw) : {};
      next();
    });
    req.on("error", () => next());
  });

  router.get("/myrmidon/companies/:companyId/castes", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json({ castes: await deps.service.listCastes(companyId) });
  });

  router.post("/myrmidon/companies/:companyId/castes", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const body = parse(createCasteSchema, bodyOf(req));
    const caste = await deps.service.createCaste({
      companyId,
      body,
      activity: (entry) => activity(entry),
    });
    res.status(201).json(caste);
  });

  router.patch("/myrmidon/companies/:companyId/castes/:key", async (req, res) => {
    const companyId = req.params.companyId as string;
    const key = req.params.key as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    // `key` and `builtIn` are immutable: the zod schema would silently strip
    // them, so reject them while the raw body still carries them.
    const rawBody = bodyOf(req);
    if ("key" in rawBody && rawBody.key !== undefined && rawBody.key !== key) {
      throw badRequest("caste key is immutable", { code: "caste_key_immutable" });
    }
    if ("key" in rawBody && rawBody.key !== undefined && rawBody.key === key) {
      // Sending the same key back is a no-op, not a change; treat as allowed
      // only when nothing else is wrong, by dropping it here.
      delete rawBody.key;
    }
    if ("builtIn" in rawBody && rawBody.builtIn !== undefined) {
      throw badRequest("builtIn cannot be changed", { code: "caste_builtin_immutable" });
    }
    const body = parse(patchCasteSchema, rawBody);
    const caste = await deps.service.updateCaste({
      companyId,
      key,
      body,
      activity: (entry) => activity(entry),
    });
    res.json(caste);
  });

  router.delete("/myrmidon/companies/:companyId/castes/:key", async (req, res) => {
    const companyId = req.params.companyId as string;
    const key = req.params.key as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const body = parse(deleteCasteSchema, bodyOf(req));
    await deps.service.removeCaste({
      companyId,
      key,
      reassignTo: body.reassignTo,
      activity: (entry) => activity(entry),
    });
    res.status(204).send();
  });

  return router;
}

function safeJsonParse(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    // A malformed body is treated as empty: DELETE without reassignTo is the
    // legal "no body" form, and the service answers 409 when agents are on
    // the caste and the caller really needed reassignTo.
    return {};
  }
}
