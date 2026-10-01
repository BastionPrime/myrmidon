// myrmidon(EXTCASE-B): HTTP surface of the browser bridge.
//
// Two routers, because they have two very different callers:
//
// - `browserBridgePanelRoutes` is the board panel: it reads and issues pairing
//   codes, lists and revokes devices, and edits the allowlist. Every route takes
//   the acting company explicitly and asserts access to it; the allowlist routes
//   follow the instance-settings rule (board reads, instance admin writes), the
//   same one `GET/PATCH /api/myrmidon/runtime-limits` follows;
// - `browserBridgePublicRoutes` is the extension: `POST /bridge/v1/pair` is the
//   one endpoint on the bridge that is not board-authenticated, because the
//   extension has no board credentials by design. Its credential is the pairing
//   code itself — one-shot, 15 minutes, human-readable — and the code names the
//   company the pairing belongs to.

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import {
  BROWSER_BRIDGE_ERROR_CODES,
  BROWSER_BRIDGE_PAIR_PATH,
  browserBridgeSettingsPatchSchema,
  pairingCodeRequestSchema,
  pairingExchangeRequestSchema,
  type BrowserBridgeSettingsPatch,
  type PairingExchangeRequest,
} from "@paperclipai/shared";
import { validate } from "../../middleware/validate.js";
import { assertBoardOrgAccess, assertCompanyAccess, assertInstanceAdmin, getActorInfo } from "../../routes/authz.js";
import { bridgeJournalService } from "./journal-view.js";
import type { BrowserBridgeActor } from "./journal.js";
import { BrowserBridgeError, type BrowserBridgeService } from "./service.js";

/** The journal actor behind a board request (agent keys included). */
function journalActor(req: Request): BrowserBridgeActor {
  const info = getActorInfo(req);
  if (info.actorType === "agent") {
    return {
      actorType: "agent",
      actorId: info.actorId,
      agentId: info.agentId,
      runId: info.runId,
      agentApiKeyId: info.agentApiKeyId,
    };
  }
  return {
    actorType: "user",
    actorId: info.actorId,
    agentId: null,
    runId: info.runId,
    agentApiKeyId: null,
  };
}

/** The pairing exchange runs without a board actor; the code carries the company. */
const PAIRING_ACTOR: BrowserBridgeActor = {
  actorType: "system",
  actorId: "bridge-pairing",
  agentId: null,
  runId: null,
  agentApiKeyId: null,
};

/** HTTP status of a bridge refusal; the JSON-RPC code travels in the body. */
export function bridgeErrorStatus(code: number): number {
  switch (code) {
    case BROWSER_BRIDGE_ERROR_CODES.invalidParams:
      return 400;
    case BROWSER_BRIDGE_ERROR_CODES.pairingCodeInvalid:
    case BROWSER_BRIDGE_ERROR_CODES.notPaired:
    case BROWSER_BRIDGE_ERROR_CODES.revoked:
    case BROWSER_BRIDGE_ERROR_CODES.domainNotAllowed:
    case BROWSER_BRIDGE_ERROR_CODES.signingDisabled:
      return 403;
    case BROWSER_BRIDGE_ERROR_CODES.pairingCodeExpired:
      return 410;
    case BROWSER_BRIDGE_ERROR_CODES.capabilityUnsupported:
      return 422;
    case BROWSER_BRIDGE_ERROR_CODES.deviceOffline:
      return 503;
    case BROWSER_BRIDGE_ERROR_CODES.timeout:
      return 504;
    default:
      return 500;
  }
}

function sendBridgeError(res: Response, err: unknown): void {
  if (err instanceof BrowserBridgeError) {
    res.status(bridgeErrorStatus(err.reasonCode)).json({
      error: err.message,
      reasonCode: err.reasonCode,
      ...(err.data ? { data: err.data } : {}),
    });
    return;
  }
  throw err;
}

/** Panel query of the journal view: filters the UI's controls expose. */
const bridgeJournalQuerySchema = z
  .object({
    deviceId: z.string().min(1).max(128).optional(),
    method: z.string().min(1).max(64).optional(),
    outcome: z.string().min(1).max(32).optional(),
    signaturesOnly: z.coerce.boolean().optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

/**
 * Board panel: pairing codes, devices, allowlist. Mounted under `/api`, so the
 * paths below are relative to that base.
 *
 * The service is reached through a getter so that mounting the router has no
 * side effects: `app.ts` mounts it while building the express app, and building
 * the runtime touches the secret service. Lazy resolution keeps app creation
 * cheap and keeps the failure at the first request that needs the bridge.
 */
export function browserBridgePanelRoutes(getService: () => BrowserBridgeService, getDb?: () => Db) {
  const router = Router();

  router.post(
    "/myrmidon/browser-bridge/companies/:companyId/pairing-codes",
    validate(pairingCodeRequestSchema),
    async (req, res) => {
      const companyId = String(req.params.companyId);
      assertCompanyAccess(req, companyId);
      const body = req.body as { label?: string };
      try {
        const service = getService();
        res.status(201).json(
          await service.createPairingCode({ companyId, actor: journalActor(req), label: body.label ?? null }),
        );
      } catch (err) {
        sendBridgeError(res, err);
      }
    },
  );

  router.get(
    "/myrmidon/browser-bridge/companies/:companyId/devices",
    async (req, res) => {
      const companyId = String(req.params.companyId);
      assertCompanyAccess(req, companyId);
      res.json({ devices: await getService().listDevices(companyId) });
    },
  );

  router.delete(
    "/myrmidon/browser-bridge/companies/:companyId/devices/:deviceId",
    async (req, res) => {
      const companyId = String(req.params.companyId);
      assertCompanyAccess(req, companyId);
      const deviceId = String(req.params.deviceId);
      try {
        const result = await getService().revokeDevice({ companyId, deviceId, actor: journalActor(req) });
        res.json({ deviceId, ...result });
      } catch (err) {
        sendBridgeError(res, err);
      }
    },
  );

  router.get("/myrmidon/browser-bridge/settings", async (req, res) => {
    assertBoardOrgAccess(req);
    res.json(await getService().readSettings());
  });

  router.patch("/myrmidon/browser-bridge/settings", validate(browserBridgeSettingsPatchSchema), async (req, res) => {
    assertInstanceAdmin(req);
    try {
      res.json(
        await getService().updateSettings({
          patch: req.body as BrowserBridgeSettingsPatch,
          actor: journalActor(req),
        }),
      );
    } catch (err) {
      sendBridgeError(res, err);
    }
  });

  /**
   * The emergency switch of design note §4.4: one call, no body, and signing is
   * off whatever mode the client was in. It is the same write as PATCH settings
   * with `signing.enabled: false`, kept as its own route so the panel button and
   * an operator's script do not have to remember the current mode.
   */
  router.post("/myrmidon/browser-bridge/signing/disable", async (req, res) => {
    assertInstanceAdmin(req);
    try {
      const settings = await getService().disableSigning({ actor: journalActor(req) });
      res.json({ signing: settings.signing });
    } catch (err) {
      sendBridgeError(res, err);
    }
  });

  /**
   * The journal view (design note §4.4): the bridge rows of one company —
   * actions and signatures, with the document hash a signature leaves behind.
   * A board member of the company reads it; the rows are already shaped by
   * part B (sizes and references, never page content).
   */
  router.get("/myrmidon/browser-bridge/companies/:companyId/journal", async (req, res) => {
    const companyId = String(req.params.companyId);
    assertCompanyAccess(req, companyId);
    const parsed = bridgeJournalQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid bridge journal query", issues: parsed.error.issues });
      return;
    }
    if (!getDb) {
      res.status(503).json({ error: "The bridge journal view is not available" });
      return;
    }
    const journal = bridgeJournalService(getDb());
    const rows = await journal.list({ companyId, ...parsed.data });
    const signing = await getService().readSettings().then((settings) => settings.signing);
    const signedToday =
      parsed.data.signaturesOnly === true || signing.dailyLimit > 0
        ? await journal.countSignaturesToday(companyId, new Date())
        : null;
    res.json({ rows, signedToday, dailyLimit: signing.dailyLimit });
  });

  return router;
}

/**
 * The extension's one unauthenticated endpoint. Nothing about the caller is
 * trusted except the code: the deviceId is bound to the token the response
 * carries, and a wrong or spent code is refused with the matching reason code.
 */
export function browserBridgePublicRoutes(getService: () => BrowserBridgeService) {
  const router = Router();

  router.post(BROWSER_BRIDGE_PAIR_PATH, validate(pairingExchangeRequestSchema), async (req, res) => {
    try {
      const service = getService();
      const paired = await service.exchangePairingCode({
        request: req.body as PairingExchangeRequest,
        actor: PAIRING_ACTOR,
      });
      res.status(201).json(paired);
    } catch (err) {
      sendBridgeError(res, err);
    }
  });

  return router;
}