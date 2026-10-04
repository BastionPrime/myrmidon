// server/src/myrmidon/wip-limit/routes.ts
//
// myrmidon(1.6.1-WIP-LIMIT-A): the settings and status API.
//
// - GET/PUT /api/myrmidon/companies/:companyId/wip-limit/settings — the
//   settings object `{ defaultLimit, perAgent }`. Any company member reads;
//   instance admins write (the same rule the other company-scoped myrmidon
//   surfaces follow).
// - GET /api/myrmidon/companies/:companyId/wip-limit/status — the live
//   per-agent rows `[{ agentId, inProgress, inReview, wip, limit, overLimit,
//   leadRule }]`, computed on the fly from visible issue rows.
//
// The contract is fixed and additive-only: part B (the UI) reads exactly these
// two endpoints, and this file must not change their shape.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { wipLimitSettingsSchema, type WipLimitSettings } from "@paperclipai/shared";
import { validate } from "../../middleware/validate.js";
import { assertCompanyAccess, assertInstanceAdmin } from "../../routes/authz.js";
import { issueService } from "../../services/issues.js";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { readWipLimitSettings, writeWipLimitSettings } from "./settings.js";
import { buildWipLimitStatus } from "./status.js";

export function wipLimitRoutes(db: Db) {
  const router = Router();
  const settings = instanceSettingsService(db);

  router.get("/myrmidon/companies/:companyId/wip-limit/settings", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await readWipLimitSettings(settings));
  });

  router.put(
    "/myrmidon/companies/:companyId/wip-limit/settings",
    validate(wipLimitSettingsSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      assertInstanceAdmin(req);
      res.json(await writeWipLimitSettings(settings, req.body as WipLimitSettings));
    },
  );

  router.get("/myrmidon/companies/:companyId/wip-limit/status", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const current = await readWipLimitSettings(settings);
    res.json(await buildWipLimitStatus(db, companyId, current));
  });

  return router;
}

/** The sweep's comment port, bound to the issue service (index.ts uses this). */
export function wipLimitAddCommentPort(db: Db) {
  const svc = issueService(db);
  return (
    issueId: string,
    body: string,
    options: Parameters<typeof svc.addComment>[3],
  ) =>
    svc.addComment(issueId, body, {}, {
      authorType: "system",
      presentation: options?.presentation,
      metadata: options?.metadata,
    });
}
