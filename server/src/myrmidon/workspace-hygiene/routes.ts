import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  patchWorkspaceHygieneLimitsSchema,
  type WorkspaceHygieneLimitsPatch,
} from "@paperclipai/shared";
import { validate } from "../../middleware/validate.js";
import { assertBoardOrgAccess, assertInstanceAdmin, getActorInfo } from "../../routes/authz.js";
import type { WorkspaceHygieneService } from "./service.js";

/**
 * GET/PATCH /api/myrmidon/workspace-hygiene (myrmidon WORKSPACE-HYGIENE, part C).
 *
 * GET reports the quotas in force, where each value came from (stored settings,
 * the environment, or the default) and the sizes of the last sweep; any
 * authenticated board member may read it, and the sweep keeps the sizes, so the
 * route never walks a disk. PATCH writes `instance_settings.general.workspaceHygiene`
 * and is instance-admin only, the same rule the rest of the instance settings
 * follow. No UI panel ships with this part; the endpoint is the minimum a panel
 * or a script needs.
 */

export function workspaceHygieneRoutes(_db: Db, service: WorkspaceHygieneService) {
  const router = Router();

  router.get("/myrmidon/workspace-hygiene", async (req, res) => {
    assertBoardOrgAccess(req);
    res.json(await service.read());
  });

  router.patch(
    "/myrmidon/workspace-hygiene",
    validate(patchWorkspaceHygieneLimitsSchema),
    async (req, res) => {
      assertInstanceAdmin(req);
      res.json(await service.update(req.body as WorkspaceHygieneLimitsPatch, getActorInfo(req)));
    },
  );

  return router;
}