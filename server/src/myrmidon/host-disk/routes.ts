import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { patchHostDiskSettingsSchema, type HostDiskSettingsPatch } from "@paperclipai/shared";
import { validate } from "../../middleware/validate.js";
import { assertBoardOrgAccess, assertInstanceAdmin, getActorInfo } from "../../routes/authz.js";
import type { HostDiskService } from "./service.js";

/**
 * GET/PATCH /api/myrmidon/host-disk (myrmidon BOT-DISK, part E).
 *
 * GET reports the threshold in force, where it came from (stored settings,
 * the environment, or the default) and the state of the last sweep: usage,
 * growth rate and the biggest consumers. Any authenticated board member may
 * read it; the sweep keeps the numbers, so the route never walks a disk.
 * PATCH writes `instance_settings.general.hostDisk` and is instance-admin
 * only, the same rule the rest of the instance settings follow.
 */

export function hostDiskRoutes(_db: Db, service: HostDiskService) {
  const router = Router();

  router.get("/myrmidon/host-disk", async (req, res) => {
    assertBoardOrgAccess(req);
    res.json(await service.read());
  });

  router.patch(
    "/myrmidon/host-disk",
    validate(patchHostDiskSettingsSchema),
    async (req, res) => {
      assertInstanceAdmin(req);
      res.json(await service.update(req.body as HostDiskSettingsPatch, getActorInfo(req)));
    },
  );

  return router;
}
