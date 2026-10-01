// myrmidon(SEC1): access-hub API routes — /api/myrmidon/access-hub/*.
//
// All board-only: the access hub is an operator surface (the same rule as the
// vendor secrets routes). Everything sits under /api/myrmidon (the fork rule
// for new API paths). While MYRMIDON_ACCESS_HUB_ENABLED is off (the deploy
// default), the read endpoints answer with `enabled: false` and never touch
// the storage, and the mutating endpoints refuse with 409 — the same shape
// the bot-containers routes use for their flag.
//
// Responses never carry secret values: the list/get views are built by the
// service without value fields, the journal is the activity log, and the
// public part of an ssh key appears exactly once, in the generation and
// rotation responses.
//
// Wire contract (matches the merged UI client, part B PR #190): paths carry
// NO :companyId — the UI has the selected company client-side only. The
// company is resolved from the caller's context: the `companyId` query
// parameter first (the way the fleet console does it), then the caller's
// single active company membership. Zero or several ambiguous memberships
// without the parameter answer 422. The host registry is instance-wide (it
// lives in instance_settings), so its routes do not need the company at all.
//
// PUT /accesses/:id/hosts is the agreed extension for the UI's "deploy to
// hosts" / "withdraw from hosts" pair (one set-shaped write); part C turns
// the host set into a real authorized_keys layout.

import { Router, type Request } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { companySecrets } from "@paperclipai/db";
import { conflict, notFound, unprocessable } from "../../errors.js";
import { validate } from "../../middleware/validate.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "../../routes/authz.js";
import { logActivity } from "../../services/activity-log.js";
import { accessHubService } from "./service.js";
import {
  MAX_HOSTS,
  mutateAccessHubHosts,
  newAccessHubHostId,
  readAccessHubHosts,
  validateAccessHubHost,
  type AccessHubHostsChange,
} from "./host-registry.js";
import type { AccessHubHost } from "./types.js";
import { createFakeDeployPort, type DeployPort } from "./ssh-deploy.js";

export const ACCESS_HUB_ENABLED_ENV = "MYRMIDON_ACCESS_HUB_ENABLED";

export function isAccessHubEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[ACCESS_HUB_ENABLED_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

const UUID = z.string().uuid();

const hostInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    address: z.string().trim().min(1).max(253),
    targetUser: z.string().trim().min(1).max(64),
    enabled: z.boolean().optional(),
  })
  .strict();

const hostPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    address: z.string().trim().min(1).max(253).optional(),
    targetUser: z.string().trim().min(1).max(64).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

const generateSshKeySchema = z
  .object({
    name: z.string().trim().min(1),
    targetUser: z.string().trim().max(64).nullable().optional(),
    hostRefs: z.array(z.string().min(1)).max(MAX_HOSTS).optional(),
  })
  .strict();

const setKindSchema = z
  .object({
    kind: z.enum(["ssh_key", "password", "token", "oauth"]),
    targetUser: z.string().trim().max(64).nullable().optional(),
    hostRefs: z.array(z.string().min(1)).max(MAX_HOSTS).optional(),
  })
  .strict();

const grantSchema = z
  .object({
    secretId: UUID,
    agentId: UUID,
  })
  .strict();

const setHostRefsSchema = z
  .object({
    hostRefs: z.array(z.string().min(1)).max(MAX_HOSTS),
  })
  .strict();

const JOURNAL_DEFAULT_LIMIT = 100;
const JOURNAL_MAX_LIMIT = 500;

type HostMutationResult =
  | { kind: "created"; host: import("./types.js").AccessHubHost }
  | { kind: "updated"; host: import("./types.js").AccessHubHost }
  | { kind: "removed"; host?: import("./types.js").AccessHubHost }
  | { kind: "conflict" }
  | { kind: "not_found" }
  | { kind: "invalid"; field: string }
  | { kind: "full" };

export interface AccessHubRoutesDeps {
  env?: NodeJS.ProcessEnv;
  /** The ssh deployment port; part C replaces the fake with a real client. */
  deploy?: DeployPort;
  /** Injectable for tests (avoids drizzle and the database in route tests). */
  service?: ReturnType<typeof accessHubService>;
  readHosts?: (db: Db) => Promise<import("./types.js").AccessHubHost[]>;
  writeHosts?: (change: AccessHubHostsChange<HostMutationResult>) => Promise<{
    hosts: AccessHubHost[];
    result: HostMutationResult;
    changed: boolean;
  }>;
  /** Companies that reference access-hub metadata (for host journal rows). */
  listHostReferencingCompanies?: (db: Db) => Promise<string[]>;
}

/**
 * The router factory app.ts registers with one line. `deps` exists so the
 * route tests can inject fakes; app.ts calls `accessHubRoutes(db)`.
 */
export function accessHubRoutes(db: Db, deps: AccessHubRoutesDeps = {}) {
  const router = Router();
  const envNow = () => deps.env ?? process.env;
  const svc = deps.service ?? accessHubService(db);
  const deploy = deps.deploy ?? createFakeDeployPort();
  const readHosts = deps.readHosts ?? readAccessHubHosts;
  // The concrete writer: mutateAccessHubHosts under the row lock. Route tests
  // inject their own; app.ts uses the real drizzle one.
  const writeHosts: (change: AccessHubHostsChange<HostMutationResult>) => Promise<{
    hosts: AccessHubHost[];
    result: HostMutationResult;
    changed: boolean;
  }> =
    deps.writeHosts ??
    ((change: AccessHubHostsChange<HostMutationResult>) => mutateAccessHubHosts(db, change));
  const hostCompanies =
    deps.listHostReferencingCompanies ??
    (async (database: Db) => {
      const rows = await database
        .selectDistinct({ companyId: companySecrets.companyId })
        .from(companySecrets);
      return rows.map((row) => row.companyId);
    });

  /** 409 with a stable error code while the flag is off. Read endpoints still
   * answer, so the UI can render the disabled state instead of an error. */
  function requireEnabled(): void {
    if (!isAccessHubEnabled(envNow())) {
      throw conflict("Access hub is disabled on this instance", { code: "access_hub_disabled" });
    }
  }

  function actorOf(req: Request): { userId: string | null; agentId: string | null } {
    const info = getActorInfo(req);
    return { userId: info.actorType === "user" ? info.actorId : null, agentId: null };
  }

  /**
   * Resolve the company for a pathless route: the `companyId` query parameter
   * first, then the caller's single active company membership. The UI keeps
   * the selected company client-side only, so the query parameter exists for
   * callers that script against the API; the membership fallback covers the
   * common one-company operator.
   */
  function resolveCompanyId(req: Request): string {
    assertBoard(req);
    const fromQuery = typeof req.query.companyId === "string" ? req.query.companyId : "";
    if (fromQuery) {
      assertCompanyAccess(req, fromQuery);
      return fromQuery;
    }
    const actor = req.actor as { companyIds?: string[]; isInstanceAdmin?: boolean; source?: string };
    if (actor.source === "local_implicit" || actor.isInstanceAdmin) {
      // Full-control context: exactly one company id when the list is set,
      // otherwise there is nothing to fall back to.
      const ids = actor.companyIds ?? [];
      if (ids.length === 1) return ids[0];
      throw unprocessable("companyId query parameter is required");
    }
    const ids = actor.companyIds ?? [];
    if (ids.length === 1) return ids[0];
    throw unprocessable(
      ids.length === 0
        ? "companyId query parameter is required (no company membership)"
        : "companyId query parameter is required (multiple company memberships)",
    );
  }

  /** Journal a host mutation once per referencing company. Never values:
   * only the operation, the host name and its id. */
  async function journalHostMutation(
    req: Request,
    operation: "create" | "update" | "delete",
    host: { id: string; name: string } | null,
  ): Promise<void> {
    const companies = await hostCompanies(db);
    const actor = actorOf(req);
    await Promise.all(
      companies.map((companyId) =>
        logActivity(db, {
          companyId,
          actorType: "user",
          actorId: actor.userId ?? "board",
          action: "access_hub.host.updated",
          entityType: "access_hub_host",
          entityId: host?.id ?? "unknown",
          details: host ? { operation, name: host.name, hostId: host.id } : { operation },
        }).catch(() => undefined),
      ),
    );
  }

  // ---- status ----

  router.get("/myrmidon/access-hub/status", (req, res) => {
    assertBoard(req);
    res.json({ enabled: isAccessHubEnabled(envNow()) });
  });

  // ---- secrets: the access list ----

  router.get("/myrmidon/access-hub/accesses", async (req, res) => {
    const companyId = resolveCompanyId(req);
    if (!isAccessHubEnabled(envNow())) {
      res.json({ enabled: false, accesses: [], hosts: [] });
      return;
    }
    const [secrets, hosts] = await Promise.all([svc.listSecrets(companyId), readHosts(db)]);
    const accesses = secrets.map((secret) => ({
      ...secret,
      usageHosts: svc.usageHosts(secret, hosts),
    }));
    res.json({ enabled: true, accesses, hosts });
  });

  router.post(
    "/myrmidon/access-hub/secrets/generate-ssh-key",
    validate(generateSshKeySchema),
    async (req, res) => {
      const companyId = resolveCompanyId(req);
      requireEnabled();
      const result = await svc.generateSshKey(
        companyId,
        {
          name: req.body.name,
          targetUser: req.body.targetUser ?? null,
          hostRefs: req.body.hostRefs,
        },
        actorOf(req),
      );
      res.status(201).json(result);
    },
  );

  router.post("/myrmidon/access-hub/secrets/:secretId/rotate-ssh-key", async (req, res) => {
    const companyId = resolveCompanyId(req);
    requireEnabled();
    const result = await svc.rotateSshKey(companyId, req.params.secretId as string, actorOf(req));
    res.json(result);
  });

  router.post(
    "/myrmidon/access-hub/secrets/:secretId/kind",
    validate(setKindSchema),
    async (req, res) => {
      const companyId = resolveCompanyId(req);
      requireEnabled();
      const secret = await svc.setSecretKind(
        companyId,
        req.params.secretId as string,
        req.body.kind,
        { targetUser: req.body.targetUser, hostRefs: req.body.hostRefs },
        actorOf(req),
      );
      res.json(secret);
    },
  );

  // ---- grant / revoke ----

  router.post("/myrmidon/access-hub/accesses/grant", validate(grantSchema), async (req, res) => {
    const companyId = resolveCompanyId(req);
    requireEnabled();
    const result = await svc.grantAccess(companyId, req.body, actorOf(req));
    res.status(201).json(result);
  });

  router.post("/myrmidon/access-hub/accesses/revoke", validate(grantSchema), async (req, res) => {
    const companyId = resolveCompanyId(req);
    requireEnabled();
    const result = await svc.revokeAccess(companyId, req.body, actorOf(req));
    res.json(result);
  });

  router.get("/myrmidon/access-hub/secrets/:secretId/bindings", async (req, res) => {
    const companyId = resolveCompanyId(req);
    requireEnabled();
    const bindings = await svc.listBindings(companyId, req.params.secretId as string);
    res.json({ bindings });
  });

  // ---- host set of one access (the agreed extension for deploy/withdraw) ----

  router.put(
    "/myrmidon/access-hub/accesses/:secretId/hosts",
    validate(setHostRefsSchema),
    async (req, res) => {
      const companyId = resolveCompanyId(req);
      requireEnabled();
      const secretId = req.params.secretId as string;
      const hostRefs = req.body.hostRefs as string[];
      const secret = await svc.setSecretHostRefs(companyId, secretId, hostRefs, actorOf(req));
      res.json({ hostRefs: secret.ssh?.hostRefs ?? [] });
    },
  );

  // ---- journal ----

  router.get("/myrmidon/access-hub/journal", async (req, res) => {
    const companyId = resolveCompanyId(req);
    requireEnabled();
    const limitRaw = Number(req.query.limit);
    const limit =
      Number.isInteger(limitRaw) && limitRaw > 0
        ? Math.min(limitRaw, JOURNAL_MAX_LIMIT)
        : JOURNAL_DEFAULT_LIMIT;
    const journal = await svc.listJournal(companyId, limit);
    res.json({ journal });
  });

  // ---- host registry (instance-wide) ----

  router.get("/myrmidon/access-hub/hosts", async (req, res) => {
    assertBoard(req);
    if (!isAccessHubEnabled(envNow())) {
      res.json({ enabled: false, hosts: [] });
      return;
    }
    res.json({ enabled: true, hosts: await readHosts(db) });
  });

  router.post("/myrmidon/access-hub/hosts", validate(hostInputSchema), async (req, res) => {
    assertBoard(req);
    requireEnabled();
    const input = {
      name: req.body.name as string,
      address: req.body.address as string,
      targetUser: req.body.targetUser as string,
      enabled: req.body.enabled ?? true,
    };
    const invalid = validateAccessHubHost(input);
    if (invalid) throw unprocessable(`Invalid host field: ${invalid}`);
    const { hosts, result } = await writeHosts((current) => {
      if (current.length >= MAX_HOSTS) return { next: null, result: { kind: "full" } as HostMutationResult };
      const duplicate = current.find(
        (host) => host.address === input.address && host.targetUser === input.targetUser,
      );
      if (duplicate) return { next: null, result: { kind: "conflict" } as HostMutationResult };
      const host = { id: newAccessHubHostId(), ...input };
      return { next: [...current, host], result: { kind: "created", host } as HostMutationResult };
    });
    if (result.kind === "full") throw unprocessable(`Host registry is full (${MAX_HOSTS})`);
    if (result.kind === "conflict") throw conflict("A host with this address and user already exists");
    await journalHostMutation(req, "create", result.kind === "created" ? result.host : null);
    res.status(201).json({ hosts });
  });

  router.patch("/myrmidon/access-hub/hosts/:hostId", validate(hostPatchSchema), async (req, res) => {
    assertBoard(req);
    requireEnabled();
    const hostId = req.params.hostId as string;
    const patch = req.body as z.infer<typeof hostPatchSchema>;
    const { hosts, result } = await writeHosts((current) => {
      const index = current.findIndex((host) => host.id === hostId);
      if (index === -1) return { next: null, result: { kind: "not_found" } as HostMutationResult };
      const merged = {
        ...current[index],
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.address !== undefined ? { address: patch.address } : {}),
        ...(patch.targetUser !== undefined ? { targetUser: patch.targetUser } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      };
      const invalid = validateAccessHubHost(merged);
      if (invalid) return { next: null, result: { kind: "invalid", field: invalid } as HostMutationResult };
      const next = [...current];
      next[index] = merged;
      return { next, result: { kind: "updated", host: merged } as HostMutationResult };
    });
    if (result.kind === "not_found") throw notFound("Host not found");
    if (result.kind === "invalid") throw unprocessable(`Invalid host field: ${result.field}`);
    await journalHostMutation(req, "update", result.kind === "updated" ? result.host : null);
    res.json({ hosts });
  });

  router.delete("/myrmidon/access-hub/hosts/:hostId", async (req, res) => {
    assertBoard(req);
    requireEnabled();
    const hostId = req.params.hostId as string;
    const { hosts, result } = await writeHosts((current) => {
      const next = current.filter((host) => host.id !== hostId);
      if (next.length === current.length) return { next: null, result: { kind: "not_found" } as HostMutationResult };
      const removed = current.find((host) => host.id === hostId) ?? null;
      return { next, result: { kind: "removed", host: removed ?? undefined } as HostMutationResult };
    });
    if (result.kind === "not_found") throw notFound("Host not found");
    await journalHostMutation(req, "delete", "host" in result ? result.host ?? null : null);
    res.json({ hosts });
  });

  // ---- ssh deploy (fake in part A; part C swaps the port) ----

  router.post("/myrmidon/access-hub/hosts/:hostId/deploy/:secretId", async (req, res) => {
    const companyId = resolveCompanyId(req);
    requireEnabled();
    const [hosts, secret] = await Promise.all([
      readHosts(db),
      svc.getSecret(companyId, req.params.secretId as string),
    ]);
    const host = hosts.find((item) => item.id === req.params.hostId);
    if (!host) throw notFound("Host not found");
    if (!secret.ssh) throw unprocessable("Secret is not typed as an ssh key");
    const result = await deploy.deploy({
      hostId: host.id,
      address: host.address,
      targetUser: host.targetUser,
      fingerprint: secret.ssh.fingerprint ?? "",
      publicKey: "",
    });
    res.json(result);
  });

  return router;
}
