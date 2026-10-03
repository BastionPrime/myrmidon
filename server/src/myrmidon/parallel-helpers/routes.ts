// GET/PATCH /api/myrmidon/parallel-helpers (myrmidon PARALLEL-HELPERS).
//
// GET reports the stored company ceiling/default and the capacity hint — the
// sum of the per-agent helper limits against the host's build slots and
// memory — as a warning, never a block. PATCH writes
// `instance_settings.general.parallelHelpers`; it is instance-admin only, the
// same rule the rest of the instance settings follow. No live apply step: the
// profile compiler re-reads the row on every reconcile tick, so a change
// reaches every bot's config.yaml within one tick without a restart.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { patchParallelHelpersSettingsSchema, type ParallelHelpersSettings } from "@paperclipai/shared";
import { validate } from "../../middleware/validate.js";
import { assertBoardOrgAccess, assertInstanceAdmin, getActorInfo } from "../../routes/authz.js";
import type { ParallelHelpersService } from "./service.js";

export function parallelHelpersRoutes(_db: Db, service: ParallelHelpersService) {
  const router = Router();

  router.get("/myrmidon/parallel-helpers", async (req, res) => {
    assertBoardOrgAccess(req);
    res.json(await service.read());
  });

  router.patch("/myrmidon/parallel-helpers", validate(patchParallelHelpersSettingsSchema), async (req, res) => {
    assertInstanceAdmin(req);
    res.json(await service.update(req.body as Partial<ParallelHelpersSettings>, getActorInfo(req)));
  });

  return router;
}
