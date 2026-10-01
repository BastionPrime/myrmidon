// server/src/myrmidon/client-mail/routes.ts
//
// myrmidon(EXTCASE-M): the panel and the module-facing API of the mail path.
//
// Two routers, two audiences:
//
// - the panel router (`/api/myrmidon/client-mail/…`, board-authenticated) is how
//   an operator configures one client company's mail path — enable it, name the
//   folders and categories the classifier may use, write the client's own rules,
//   name the platform bot and the classifier model — and how the operator reads
//   what happened (the ledger of decided messages). Reads are board, writes are
//   instance-admin, like the rest of the instance settings.
// - the ingestion router (`POST /api/myrmidon/companies/:companyId/client-mail/batch`)
//   is how the pipeline is driven: a client's channel hands a batch of items and
//   gets the per-item outcome back. It is company-scoped and asserted like the
//   OCR MCP endpoint, so a bot of one company cannot feed another company's mail
//   path.
//
// Rule previewing lives here too (`POST …/rules/preview`): it runs the *same*
// shared matcher the pipeline uses over a sample item, so what an operator sees
// in the panel cannot disagree with what the bot later does.
//
// The routers take their ports rather than a database handle, the way the rest of
// our modules do: the whole surface — validation, permissions, what a settings
// change records — is then exercised without a database, and the store is the
// only thing that needs one.

import { Router } from "express";
import {
  CLIENT_MAIL_MAX_ITEMS_PER_BATCH,
  ClientMailError,
  clientMailCompanySettingsPatchSchema,
  clientMailItemSchema,
  mailRuleMatches,
  type ClientMailCompanySettings,
  type ClientMailCompanySettingsPatch,
  type ClientMailErrorCode,
} from "@paperclipai/shared";
import { z } from "zod";
import { validate } from "../../middleware/validate.js";
import { HttpError } from "../../errors.js";
import { assertBoardOrgAccess, assertCompanyAccess, assertInstanceAdmin, getActorInfo } from "../../routes/authz.js";

/** The audit action of a settings change, written for the client's company. */
export const CLIENT_MAIL_SETTINGS_UPDATED_ACTION = "instance.client_mail.updated";

/** Actor recorded on the pipeline's own journal rows: a module of the board, not a person. */
export const CLIENT_MAIL_ACTOR_ID = "myrmidon-client-mail";

/** One ledger row, as the panel reads it. */
export interface ClientMailLedgerRow {
  entityId: string;
  action: string;
  details: Record<string, unknown>;
  createdAt: Date;
}

/** Everything the routes need, so the store and the pipeline stay outside. */
export interface ClientMailRoutesDeps {
  /** The stored mail settings of one company. */
  readSettings(companyId: string): Promise<ClientMailCompanySettings>;
  /** Writes a patch for one company, keeping every other company's entry. */
  patchSettings(companyId: string, patch: ClientMailCompanySettingsPatch): Promise<ClientMailCompanySettings>;
  /** The ledger rows of the named messages, for the panel. */
  readLedger(companyId: string, messageIds: string[]): Promise<ClientMailLedgerRow[]>;
  /** Processes a batch through the pipeline. */
  processBatch(input: { companyId: string; items: unknown[] }): Promise<unknown>;
  /** Writes the settings change to the company's journal. */
  recordChange(input: {
    companyId: string;
    actorType: string;
    actorId: string;
    details: Record<string, unknown>;
  }): Promise<unknown>;
}

export const clientMailBatchBodySchema = z
  .object({
    watermark: z.string().max(512).nullable().optional(),
    items: z.array(z.unknown()).max(CLIENT_MAIL_MAX_ITEMS_PER_BATCH),
  })
  .strict();

export const clientMailPreviewBodySchema = z.object({ item: clientMailItemSchema }).strict();

export const clientMailSettingsBodySchema = z
  .object({ settings: clientMailCompanySettingsPatchSchema })
  .strict();

/** The panel router: `/api/myrmidon/client-mail/…`. */
export function clientMailPanelRoutes(deps: ClientMailRoutesDeps) {
  const router = Router();

  router.get("/myrmidon/client-mail/settings/:companyId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoardOrgAccess(req);
    assertCompanyAccess(req, companyId);
    res.json({ companyId, settings: await deps.readSettings(companyId) });
  });

  router.patch(
    "/myrmidon/client-mail/settings/:companyId",
    validate(clientMailSettingsBodySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertInstanceAdmin(req);
      const patch = (req.body as z.infer<typeof clientMailSettingsBodySchema>).settings;
      const settings = await deps.patchSettings(companyId, patch);
      const actor = getActorInfo(req);
      await deps.recordChange({
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        // The keys that changed, never their values: a rule names the client's
        // own folders, and the journal is read by people.
        details: { keys: Object.keys(patch) },
      });
      res.json({ companyId, settings });
    },
  );

  router.get("/myrmidon/client-mail/ledger/:companyId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoardOrgAccess(req);
    assertCompanyAccess(req, companyId);
    const raw = req.query.messageIds;
    const messageIds =
      typeof raw === "string" && raw.trim()
        ? raw
            .split(",")
            .map((value) => value.trim())
            .filter((value) => value.length > 0)
            .slice(0, 200)
        : [];
    res.json({ companyId, rows: await deps.readLedger(companyId, messageIds) });
  });

  router.post(
    "/myrmidon/client-mail/rules/preview/:companyId",
    validate(clientMailPreviewBodySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoardOrgAccess(req);
      assertCompanyAccess(req, companyId);
      const item = (req.body as z.infer<typeof clientMailPreviewBodySchema>).item;
      const settings = await deps.readSettings(companyId);
      // The same matcher the pipeline runs: enabled rules, in priority order.
      // The answer names the rules and their targets, never the message.
      const matched = settings.rules
        .filter((rule) => rule.enabled)
        .sort((left, right) => left.priority - right.priority)
        .filter((rule) => mailRuleMatches(rule, item))
        .map((rule) => ({ id: rule.id, name: rule.name, decision: rule.decision }));
      res.json({ companyId, matched });
    },
  );

  return router;
}

/**
 * A pipeline failure as the HTTP answer the operator sees.
 *
 * A batch for a company whose mail path is not enabled is a *refused request*
 * (`ClientMailError`, a 409 with the setting named), not a board fault: the
 * reason has to reach the operator, and the generic 500 handler would replace it
 * with "Internal server error". Anything else stays a 500 — an unexpected
 * failure is not something to narrate to a caller.
 */
export function clientMailBatchFailure(error: unknown): never {
  if (error instanceof ClientMailError) {
    throw new HttpError(409, error.message, { code: error.code satisfies ClientMailErrorCode });
  }
  throw error;
}

/** The module-facing router: the batch a client's channel delivers, company-scoped. */
export function clientMailBatchRoutes(deps: ClientMailRoutesDeps) {
  const router = Router();

  router.post(
    "/myrmidon/companies/:companyId/client-mail/batch",
    validate(clientMailBatchBodySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const body = req.body as z.infer<typeof clientMailBatchBodySchema>;
      try {
        res.json(await deps.processBatch({ companyId, items: body.items }));
      } catch (error) {
        clientMailBatchFailure(error);
      }
    },
  );

  return router;
}