// myrmidon(UI2-I18N): routes for the per-user UI language preference.
//
// GET/PUT /api/myrmidon/ui2/language/me — board users only (the language is a
// person's interface choice, agents never read or write it). The route carries
// no :companyId: the preference is instance-wide per user. PUT writes the row
// and one activity log entry per company membership, the same way the sidebar
// preferences route handles its project-order write.
//
// Responses:
//   200 { language: "en" | "ru", updatedAt: Date | null }
//   403 non-board actor, or board actor without a user id
//   400 body fails upsertUi2LanguageSchema (repo convention: Zod parse failures answer 400)

import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { upsertUi2LanguageSchema, type Ui2Language } from "@paperclipai/shared";
import { validate } from "../../middleware/validate.js";
import { getActorInfo } from "../../routes/authz.js";
import {
  createUi2LanguageService,
  ui2LanguageAuditEntries,
  type Ui2LanguageServiceDeps,
} from "./service.js";

function requireBoardUserId(req: Request, res: Response): string | null {
  if (req.actor.type !== "board") {
    res.status(403).json({ error: "Board access required" });
    return null;
  }
  if (!req.actor.userId) {
    res.status(403).json({ error: "Board user context required" });
    return null;
  }
  return req.actor.userId;
}

export function ui2LanguageRoutes(db: Db, deps?: Ui2LanguageServiceDeps) {
  const router = Router();
  const service = deps ?? createUi2LanguageService(db);

  router.get("/myrmidon/ui2/language/me", async (req, res) => {
    const userId = requireBoardUserId(req, res);
    if (!userId) return;
    const language = await service.getLanguage(userId);
    res.json({ language: language ?? "en", updatedAt: null });
  });

  router.put("/myrmidon/ui2/language/me", validate(upsertUi2LanguageSchema), async (req, res) => {
    const userId = requireBoardUserId(req, res);
    if (!userId) return;
    const language = req.body.language as Ui2Language;
    const previous = await service.getLanguage(userId);
    const result = await service.upsertLanguage(userId, language);
    const companyIds = await service.listCompanyIdsForUser(userId);
    const actor = getActorInfo(req);
    for (const entry of ui2LanguageAuditEntries(userId, language, previous, companyIds, {
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
    })) {
      await service.logActivity(entry);
    }
    res.json(result);
  });

  return router;
}
