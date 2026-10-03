// myrmidon(OPE-3789): telegram-notify settings routes (part A).
//
//   GET   /api/myrmidon/telegram-notify  -> { settings, changelog }
//   PATCH /api/myrmidon/telegram-notify  -> { settings, changelog }
//
// Both are company-scoped (the `companyId` query parameter first, then the
// caller's single active company membership — the same rule as the autonomy
// and access-hub routes) and need company access. Reads are open to any
// authenticated board member; PATCH is board only, the same rule the other
// myrmidon settings surfaces follow: an agent never edits what the board
// sends to the owner.
//
// The changelog rides with the document, so GET answers the whole contract
// in one call. A no-op PATCH (values equal to the stored ones) answers 200
// with the current document and writes nothing.

import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { telegramNotifySettingsPatchSchema } from "@paperclipai/shared";
import { unprocessable } from "../../errors.js";
import { validate } from "../../middleware/validate.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "../../routes/authz.js";
import { telegramNotifyService } from "./service.js";
import { dbTelegramNotifyStore, type TelegramNotifyStore } from "./store.js";

/** The actor the changelog records: a user id or an agent id. */
function actorFromRequest(req: Request): string {
  const info = getActorInfo(req);
  if (info.actorType === "agent") return info.agentId ?? info.actorId;
  return info.actorId;
}

/**
 * Resolve the company for a pathless route: the `companyId` query parameter
 * first, then the caller's single active company membership. The same rule
 * as the autonomy routes, so one UI client can call both.
 */
function resolveCompanyId(req: Request): string {
  const fromQuery = typeof req.query.companyId === "string" ? req.query.companyId : "";
  if (fromQuery) return fromQuery;
  const actor = req.actor as { companyIds?: string[]; isInstanceAdmin?: boolean; source?: string };
  const ids = actor.companyIds ?? [];
  if (ids.length === 1) return ids[0]!;
  throw unprocessable(
    ids.length === 0
      ? "companyId query parameter is required (no company membership)"
      : "companyId query parameter is required (multiple company memberships)",
  );
}

export interface TelegramNotifyRoutesDeps {
  store: TelegramNotifyStore;
  now?: () => Date;
}

/** Wire the routes with the default (database-backed) dependencies. */
export function myrmidonTelegramNotifyRoutes(db: Db) {
  return telegramNotifyRoutes({ store: dbTelegramNotifyStore(db) });
}

export function telegramNotifyRoutes(deps: TelegramNotifyRoutesDeps) {
  const router = Router();
  const service = telegramNotifyService({ store: deps.store, now: deps.now });

  function companyOf(req: Request): string {
    const companyId = resolveCompanyId(req);
    assertCompanyAccess(req, companyId);
    return companyId;
  }

  router.get("/myrmidon/telegram-notify", async (req: Request, res: Response) => {
    const companyId = companyOf(req);
    res.json(await service.snapshot(companyId));
  });

  router.patch(
    "/myrmidon/telegram-notify",
    validate(telegramNotifySettingsPatchSchema),
    async (req: Request, res: Response) => {
      const companyId = companyOf(req);
      assertBoard(req);
      const result = await service.update(
        companyId,
        actorFromRequest(req),
        req.body as ReturnType<typeof telegramNotifySettingsPatchSchema.parse>,
      );
      if (!result.ok) {
        res.status(422).json({ error: "Invalid telegram-notify settings", code: "telegram_notify_invalid" });
        return;
      }
      res.json(result.value);
    },
  );

  return router;
}
