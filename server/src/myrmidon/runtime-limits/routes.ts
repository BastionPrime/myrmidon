// GET/PATCH /api/myrmidon/runtime-limits (myrmidon C0, RUNTIME-LIMITS).
//
// GET reports the effective limits and where each value came from (the stored
// settings, the environment, or the built-in default); any authenticated board
// member may read it. PATCH writes `instance_settings.general.runLimits`,
// applies the new limits to the running admission and asks for a queued-run
// sweep; it is instance-admin only, the same rule the rest of the instance
// settings follow.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { patchRunLimitsSchema, type RunLimitsPatch } from "@paperclipai/shared";
import { validate } from "../../middleware/validate.js";
import { assertBoardOrgAccess, assertInstanceAdmin, getActorInfo } from "../../routes/authz.js";
import type { RuntimeLimitsService } from "./service.js";

export function runtimeLimitsRoutes(_db: Db, service: RuntimeLimitsService) {
  const router = Router();

  router.get("/myrmidon/runtime-limits", async (req, res) => {
    assertBoardOrgAccess(req);
    res.json(await service.read());
  });

  router.patch("/myrmidon/runtime-limits", validate(patchRunLimitsSchema), async (req, res) => {
    assertInstanceAdmin(req);
    res.json(await service.update(req.body as RunLimitsPatch, getActorInfo(req)));
  });

  return router;
}