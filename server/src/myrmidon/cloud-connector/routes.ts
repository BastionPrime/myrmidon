// myrmidon(CLOUD-CONNECTOR): routes.
//
//   GET    /api/myrmidon/cloud-connector/accounts        — owner
//   POST   /api/myrmidon/cloud-connector/oauth/:provider/start — owner
//   GET    /api/myrmidon/cloud-connector/oauth/callback  — board (single-use state)
//   DELETE /api/myrmidon/cloud-connector/accounts/:id    — owner
//   GET    /api/myrmidon/cloud-connector/roots           — owner (also agents, read-only)
//   POST   /api/myrmidon/cloud-connector/roots           — owner
//   DELETE /api/myrmidon/cloud-connector/roots/:id       — owner
//   GET    /api/myrmidon/cloud-connector/grants          — owner
//   PUT    /api/myrmidon/cloud-connector/grants          — owner
//   DELETE /api/myrmidon/cloud-connector/grants/:id      — owner
//   GET    /api/myrmidon/cloud-connector/tree            — owner
//   GET    /api/myrmidon/cloud-connector/journal         — owner
//   POST   /api/myrmidon/cloud-connector/call            — agent (access-scoped tool call)
//
// "Owner" is a board user with an active owner (or instance admin) role on the
// company. Agents never reach the configuration routes; they only call tools,
// and the service confines every call to the folders granted to them.

import { Router, type Request } from "express";
import {
  cloudConnectStartSchema,
  cloudGrantPutSchema,
  cloudRootCreateSchema,
  cloudToolCallSchema,
  type CloudProviderId,
} from "@paperclipai/shared/myrmidon-cloud-connector";
import { forbidden, HttpError, unauthorized } from "../../errors.js";
import { validate } from "../../middleware/validate.js";
import { assertAuthenticated } from "../../routes/authz.js";
import { cloudAgentIdentity } from "./identity.js";
import type { CloudConnectorService } from "./service.js";

function toHttpError(error: unknown): unknown {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === "number" && [400, 403, 404, 409, 423, 502].includes(status)) {
    return new HttpError(status as 400 | 403 | 404 | 409 | 423 | 502, (error as Error).message);
  }
  return error;
}

function companyIdOf(req: Request): string | null {
  const raw = req.query.companyId;
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  return null;
}

function assertCloudOwner(req: Request, companyId: string | null): string {
  assertAuthenticated(req);
  if (req.actor.type !== "board") throw forbidden("Owner access required");
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return req.actor.userId ?? "board";
  if (!companyId || !((req.actor.companyIds ?? []).includes(companyId))) throw forbidden("Company access required");
  const membership = req.actor.memberships?.find((item) => item.companyId === companyId);
  if (!(membership?.status === "active" && String(membership.membershipRole) === "owner")) {
    throw forbidden("Owner access required");
  }
  return req.actor.userId ?? "board";
}

export function cloudConnectorRoutes(deps: { service: CloudConnectorService }) {
  const router = Router();
  const { service } = deps;

  router.get("/myrmidon/cloud-connector/accounts", async (req, res) => {
    const companyId = companyIdOf(req);
    assertCloudOwner(req, companyId);
    res.json({ accounts: await service.listAccounts(companyId ?? undefined) });
  });

  router.post(
    "/myrmidon/cloud-connector/oauth/:providerId/start",
    validate(cloudConnectStartSchema),
    async (req, res) => {
      const companyId = String(req.body.companyId);
      const userId = assertCloudOwner(req, companyId);
      try {
        const started = await service.beginConnect({
          providerId: req.params.providerId as CloudProviderId,
          companyId,
          userId,
          displayName: req.body.displayName,
        });
        res.json(started);
      } catch (error) {
        throw toHttpError(error);
      }
    },
  );

  // The cloud sends the owner's browser here: the single-use state is the proof
  // that this callback belongs to the connect that owner started.
  router.get("/myrmidon/cloud-connector/oauth/callback", async (req, res) => {
    assertAuthenticated(req);
    if (req.actor.type !== "board") throw forbidden("Owner access required");
    const errorCode = typeof req.query.error === "string" ? req.query.error : null;
    if (errorCode) throw new HttpError(400, `the cloud refused the authorization (${errorCode})`);
    const code = typeof req.query.code === "string" ? req.query.code : null;
    const state = typeof req.query.state === "string" ? req.query.state : null;
    if (!code || !state) throw new HttpError(400, "code and state are required");
    try {
      res.json({ account: await service.completeConnect({ state, code }) });
    } catch (error) {
      throw toHttpError(error);
    }
  });

  router.delete("/myrmidon/cloud-connector/accounts/:id", async (req, res) => {
    assertCloudOwner(req, companyIdOf(req));
    res.json({ removed: await service.disconnectAccount(req.params.id as string) });
  });

  router.get("/myrmidon/cloud-connector/roots", async (req, res) => {
    assertAuthenticated(req);
    if (req.actor.type === "none") throw unauthorized();
    const providerId = typeof req.query.providerId === "string" ? (req.query.providerId as CloudProviderId) : undefined;
    const companyId = companyIdOf(req) ?? undefined;
    const roots = await service.listRoots(providerId, companyId);
    if (req.actor.type === "agent") {
      const access = await service.accessFor(await cloudAgentIdentity(service, req));
      const allowed = new Set(access.map((entry) => entry.root.id));
      res.json({ roots: roots.filter((root) => allowed.has(root.id)) });
      return;
    }
    res.json({ roots });
  });

  router.post("/myrmidon/cloud-connector/roots", validate(cloudRootCreateSchema), async (req, res) => {
    const actor = assertCloudOwner(req, String(req.body.companyId));
    try {
      res.status(201).json({ root: await service.createRoot(req.body, actor) });
    } catch (error) {
      throw toHttpError(error);
    }
  });

  router.delete("/myrmidon/cloud-connector/roots/:id", async (req, res) => {
    assertCloudOwner(req, companyIdOf(req));
    res.json({ removed: await service.removeRoot(req.params.id as string) });
  });

  router.get("/myrmidon/cloud-connector/grants", async (req, res) => {
    assertCloudOwner(req, companyIdOf(req));
    res.json({ grants: await service.listGrants() });
  });

  router.put("/myrmidon/cloud-connector/grants", validate(cloudGrantPutSchema), async (req, res) => {
    const actor = assertCloudOwner(req, companyIdOf(req));
    try {
      res.json({ grant: await service.setGrant({ ...req.body, agentId: req.body.agentId, caste: req.body.caste }, actor) });
    } catch (error) {
      throw toHttpError(error);
    }
  });

  router.delete("/myrmidon/cloud-connector/grants/:id", async (req, res) => {
    assertCloudOwner(req, companyIdOf(req));
    res.json({ removed: await service.removeGrant(req.params.id as string) });
  });

  router.get("/myrmidon/cloud-connector/tree", async (req, res) => {
    assertCloudOwner(req, companyIdOf(req));
    const providerId = req.query.providerId;
    const root = req.query.root;
    if (typeof providerId !== "string" || typeof root !== "string") {
      throw new HttpError(400, "providerId and root are required");
    }
    try {
      res.json({
        listing: await service.tree(
          providerId as CloudProviderId,
          root,
          typeof req.query.path === "string" ? req.query.path : "",
          200,
          companyIdOf(req) ?? undefined,
        ),
      });
    } catch (error) {
      throw toHttpError(error);
    }
  });

  router.get("/myrmidon/cloud-connector/journal", async (req, res) => {
    assertCloudOwner(req, companyIdOf(req));
    const limit = Number.parseInt(String(req.query.limit ?? "100"), 10);
    res.json({ entries: await service.journal(Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : 100) });
  });

  router.post("/myrmidon/cloud-connector/call", validate(cloudToolCallSchema), async (req, res) => {
    const identity = await cloudAgentIdentity(service, req);
    res.json({ result: await service.callTool(identity, req.body) });
  });

  return router;
}