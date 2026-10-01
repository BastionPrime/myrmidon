// myrmidon(SEC1): access-hub routes tests — supertest against the real
// router with fakes for the service and the host registry (no database: the
// vendor contract is HTTP shape, authorization, flag gating and the
// no-secret-values rule; the domain rules live in service.myrmidon.test.ts).
//
// Neutral data only: agent-a ids, example.com, 192.0.2.0/24.

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import { accessHubRoutes, isAccessHubEnabled, ACCESS_HUB_ENABLED_ENV } from "./routes.js";
import type { AccessHubSecretView, AccessHubHost } from "./types.js";
import type { accessHubService } from "./service.js";
import { createFakeDeployPort } from "./ssh-deploy.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const SECRET_ID = "33333333-3333-4333-8333-333333333333";

const member = { type: "board", source: "session", userId: "user-a", isInstanceAdmin: false, companyIds: [COMPANY_ID] };
/** Several memberships and no query parameter: ambiguous, 422. */
const multiMember = { type: "board", source: "session", userId: "user-c", isInstanceAdmin: false, companyIds: [COMPANY_ID, "55555555-5555-4555-8555-555555555555"] };
const outsider = { type: "board", source: "session", userId: "user-b", isInstanceAdmin: false, companyIds: ["99999999-9999-4999-8999-999999999999"] };
const agentActor = { type: "agent", source: "agent_key", agentId: AGENT_ID, companyId: COMPANY_ID, keyId: "key-a" };

function secretView(overrides: Partial<AccessHubSecretView> = {}): AccessHubSecretView {
  return {
    id: SECRET_ID,
    companyId: COMPANY_ID,
    key: "agent-a-key",
    name: "agent-a-key",
    provider: "local_encrypted",
    status: "active",
    kind: "ssh_key",
    ssh: { fingerprint: "SHA256:abc", targetUser: "agent-a", hostRefs: ["h1"] },
    description: null,
    latestVersion: 1,
    referenceCount: 1,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    lastRotatedAt: null,
    ...overrides,
  };
}

function fakeService() {
  const generated: Array<Record<string, unknown>> = [];
  const svc = {
    listSecrets: vi.fn(async (): Promise<AccessHubSecretView[]> => [secretView()]),
    getSecret: vi.fn(async (): Promise<AccessHubSecretView> => secretView()),
    setSecretKind: vi.fn(async (): Promise<AccessHubSecretView> => secretView()),
    setSecretHostRefs: vi.fn(async (_companyId: string, _secretId: string, hostRefs: string[]) => ({
      ...secretView(),
      ssh: { fingerprint: "SHA256:abc", targetUser: "agent-a", hostRefs },
    })),
    generateSshKey: vi.fn(async (_companyId: string, input: Record<string, unknown>) => {
      generated.push(input);
      return {
        secret: secretView(),
        publicKey: "ssh-ed25519 AAAAfakekey myrmidon-access-hub",
        fingerprint: "SHA256:abc",
      };
    }),
    rotateSshKey: vi.fn(async () => ({
      secret: secretView({ latestVersion: 2 }),
      publicKey: "ssh-ed25519 AAAArotated myrmidon-access-hub",
      fingerprint: "SHA256:def",
    })),
    grantAccess: vi.fn(async () => ({ bindingId: "binding-1" })),
    revokeAccess: vi.fn(async () => ({ revoked: 1 })),
    listBindings: vi.fn(async () => [{ id: "binding-1", targetType: "agent", targetId: AGENT_ID }]),
    listJournal: vi.fn(async () => [
      {
        id: "activity-1",
        action: "access_hub.secret.generated",
        entityType: "secret",
        entityId: SECRET_ID,
        actorType: "user",
        actorId: "user-a",
        details: { name: "agent-a-key", kind: "ssh_key", fingerprint: "SHA256:abc" },
        createdAt: "2026-10-01T00:00:00.000Z",
      },
    ]),
    usageHosts: vi.fn((secret: AccessHubSecretView, hosts: AccessHubHost[]) =>
      secret.ssh ? hosts.filter((host) => secret.ssh!.hostRefs.includes(host.id)) : [],
    ),
  };
  return { svc, generated };
}

function fakeHosts() {
  let hosts: AccessHubHost[] = [];
  const writes: Array<{ next: AccessHubHost[] | null }> = [];
  return {
    hosts: () => hosts,
    writes,
    readHosts: async () => hosts,
    writeHosts: async (change: (current: AccessHubHost[]) => { next: AccessHubHost[] | null; result: never }) => {
      const { next, result } = change(hosts);
      writes.push({ next });
      if (next) hosts = next;
      return { hosts, result, changed: next !== null };
    },
  };
}

function app(actor: unknown, opts: {
  enabled?: boolean;
  svc?: ReturnType<typeof fakeService>["svc"];
  hosts?: ReturnType<typeof fakeHosts>;
  deploy?: ReturnType<typeof createFakeDeployPort>;
} = {}) {
  const { svc } = fakeService();
  const hosts = fakeHosts();
  const enabled = opts.enabled ?? true;
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  server.use(
    "/api",
    accessHubRoutes({} as never, {
      env: { [ACCESS_HUB_ENABLED_ENV]: enabled ? "1" : "0" },
      service: (opts.svc ?? svc) as unknown as ReturnType<typeof accessHubService>,
      readHosts: (opts.hosts ?? hosts).readHosts,
      writeHosts: (opts.hosts ?? hosts).writeHosts as never,
      listHostReferencingCompanies: async () => [COMPANY_ID],
      deploy: opts.deploy ?? createFakeDeployPort(),
    }),
  );
  server.use(errorHandler);
  return server;
}

const BASE = "/api/myrmidon/access-hub";

describe("myrmidon(SEC1) access-hub routes: flag and status", () => {
  it("is off by default and on with the known truthy spellings", () => {
    expect(isAccessHubEnabled({})).toBe(false);
    expect(isAccessHubEnabled({ [ACCESS_HUB_ENABLED_ENV]: "1" })).toBe(true);
    expect(isAccessHubEnabled({ [ACCESS_HUB_ENABLED_ENV]: "true" })).toBe(true);
    expect(isAccessHubEnabled({ [ACCESS_HUB_ENABLED_ENV]: "yes" })).toBe(true);
    expect(isAccessHubEnabled({ [ACCESS_HUB_ENABLED_ENV]: "on" })).toBe(true);
    expect(isAccessHubEnabled({ [ACCESS_HUB_ENABLED_ENV]: "0" })).toBe(false);
    expect(isAccessHubEnabled({ [ACCESS_HUB_ENABLED_ENV]: "" })).toBe(false);
  });

  it("status answers for a board member, with the disabled state readable", async () => {
    await request(app(member, { enabled: false })).get(`${BASE}/status`).expect(200).expect({ enabled: false });
    await request(app(member, { enabled: true })).get(`${BASE}/status`).expect(200).expect({ enabled: true });
  });

  it("mutating routes refuse with 409 while the flag is off, and reads report disabled", async () => {
    const denied = await request(app(member, { enabled: false }))
      .post(`${BASE}/secrets/generate-ssh-key`)
      .send({ name: "agent-a-ssh" })
      .expect(409);
    expect(denied.body.error).toContain("disabled");
    const listing = await request(app(member, { enabled: false }))
      .get(`${BASE}/accesses`)
      .expect(200);
    expect(listing.body).toEqual({ enabled: false, accesses: [], hosts: [] });
    await request(app(member, { enabled: false })).get(`${BASE}/hosts`).expect(200).expect({ enabled: false, hosts: [] });
  });
});

describe("myrmidon(SEC1) access-hub routes: authorization", () => {
  it("refuses agent actors on every route (board-only)", async () => {
    await request(app(agentActor)).get(`${BASE}/status`).expect(403);
    await request(app(agentActor)).get(`${BASE}/accesses`).expect(403);
    await request(app(agentActor))
      .post(`${BASE}/secrets/generate-ssh-key`)
      .send({ name: "agent-a-ssh" })
      .expect(403);
    await request(app(agentActor)).get(`${BASE}/hosts`).expect(403);
  });

  it("serves another company's member their own company, not a 403", async () => {
    // The pathless contract resolves the caller's own company: an outsider
    // with a single membership sees their own (empty) list, never ours.
    const { svc } = fakeService();
    const res = await request(app(outsider, { svc })).get(`${BASE}/accesses`).expect(200);
    expect(svc.listSecrets).toHaveBeenCalledWith(outsider.companyIds[0]);
    // Asking for OUR company explicitly through the query parameter is the 403.
    await request(app(outsider, { svc })).get(`${BASE}/accesses?companyId=${COMPANY_ID}`).expect(403);
  });
});

describe("myrmidon(SEC1) access-hub routes: secrets", () => {
  it("lists accesses with kind, bindings count, usage hosts and dates, without any value field", async () => {
    const hosts = fakeHosts();
    // one host so usageHosts has something to resolve
    const { writeHosts } = hosts;
    await writeHosts((current) => ({
      next: [
        ...current,
        { id: "h1", name: "build-1", address: "example.com", targetUser: "agent-a", enabled: true },
      ],
      result: null as never,
    }));
    const res = await request(app(member, { hosts })).get(`${BASE}/accesses`).expect(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.accesses).toHaveLength(1);
    const access = res.body.accesses[0];
    expect(access.kind).toBe("ssh_key");
    expect(access.ssh.fingerprint).toBe("SHA256:abc");
    expect(access.ssh.targetUser).toBe("agent-a");
    expect(access.usageHosts).toEqual([
      { id: "h1", name: "build-1", address: "example.com", targetUser: "agent-a", enabled: true },
    ]);
    expect(access.referenceCount).toBe(1);
    expect(access.createdAt).toBeTypeOf("string");
    expect(access.lastRotatedAt).toBeNull();
    // The no-values rule: the response must not carry value-like fields.
    const payload = JSON.stringify(res.body);
    expect(payload).not.toMatch(/"(value|sshPublicKey|privateKey|secretValue)"/);
    expect(payload).not.toContain("-----BEGIN");
  });

  it("generate-ssh-key returns the public part exactly once and validates the body", async () => {
    const { svc, generated } = fakeService();
    const res = await request(app(member, { svc }))
      .post(`${BASE}/secrets/generate-ssh-key`)
      .send({ name: "agent-a-ssh", targetUser: "agent-a", hostRefs: ["h1"] })
      .expect(201);
    expect(res.body.publicKey).toMatch(/^ssh-ed25519 /);
    expect(res.body.fingerprint).toMatch(/^SHA256:/);
    expect(res.body.secret.kind).toBe("ssh_key");
    expect(generated[0]).toMatchObject({ name: "agent-a-ssh", targetUser: "agent-a", hostRefs: ["h1"] });

    // unknown fields are rejected (strict schema)
    await request(app(member, { svc }))
      .post(`${BASE}/secrets/generate-ssh-key`)
      .send({ name: "x", nope: 1 })
      .expect(400);
  });

  it("rotate-ssh-key delegates and returns the new public part once", async () => {
    const { svc } = fakeService();
    const res = await request(app(member, { svc }))
      .post(`${BASE}/secrets/${SECRET_ID}/rotate-ssh-key`)
      .expect(200);
    expect(res.body.fingerprint).toBe("SHA256:def");
    expect(res.body.secret.latestVersion).toBe(2);
    expect(svc.rotateSshKey).toHaveBeenCalledWith(COMPANY_ID, SECRET_ID, { userId: "user-a", agentId: null });
  });

  it("kind setting accepts only the four kinds", async () => {
    const { svc } = fakeService();
    for (const kind of ["ssh_key", "password", "token", "oauth"]) {
      await request(app(member, { svc }))
        .post(`${BASE}/secrets/${SECRET_ID}/kind`)
        .send({ kind })
        .expect(200);
    }
    await request(app(member, { svc }))
      .post(`${BASE}/secrets/${SECRET_ID}/kind`)
      .send({ kind: "nope" })
      .expect(400);
  });

  it("grant/revoke validate the pair of uuids", async () => {
    const { svc } = fakeService();
    await request(app(member, { svc }))
      .post(`${BASE}/accesses/grant`)
      .send({ secretId: SECRET_ID, agentId: AGENT_ID })
      .expect(201)
      .expect({ bindingId: "binding-1" });
    await request(app(member, { svc }))
      .post(`${BASE}/accesses/grant`)
      .send({ secretId: "not-a-uuid", agentId: AGENT_ID })
      .expect(400);
    await request(app(member, { svc }))
      .post(`${BASE}/accesses/revoke`)
      .send({ secretId: SECRET_ID, agentId: AGENT_ID })
      .expect(200)
      .expect({ revoked: 1 });
  });

  it("journal returns our action rows only", async () => {
    const { svc } = fakeService();
    const res = await request(app(member, { svc }))
      .get(`${BASE}/journal?limit=5`)
      .expect(200);
    expect(res.body.journal).toHaveLength(1);
    expect(res.body.journal[0].action).toBe("access_hub.secret.generated");
    expect(svc.listJournal).toHaveBeenCalledWith(COMPANY_ID, 5);
    // limit falls back to the default on garbage
    await request(app(member, { svc })).get(`${BASE}/journal?limit=abc`).expect(200);
    expect(svc.listJournal).toHaveBeenLastCalledWith(COMPANY_ID, 100);
  });
});

describe("myrmidon(SEC1) access-hub routes: host registry", () => {
  it("creates, patches and deletes hosts with neutral data", async () => {
    const server = app(member);
    const created = await request(server)
      .post(`${BASE}/hosts`)
      .send({ name: "build-1", address: "example.com", targetUser: "agent-a" })
      .expect(201);
    expect(created.body.hosts).toHaveLength(1);
    const hostId = created.body.hosts[0].id as string;

    const listed = await request(server).get(`${BASE}/hosts`).expect(200);
    expect(listed.body.hosts).toHaveLength(1);

    const patched = await request(server)
      .patch(`${BASE}/hosts/${hostId}`)
      .send({ enabled: false })
      .expect(200);
    expect(patched.body.hosts[0].enabled).toBe(false);

    await request(server).delete(`${BASE}/hosts/${hostId}`).expect(200);
    await request(server).delete(`${BASE}/hosts/${hostId}`).expect(404);
    await request(server).patch(`${BASE}/hosts/${hostId}`).send({ name: "x" }).expect(404);
  });

  it("rejects an invalid address and a duplicate host", async () => {
    const server = app(member);
    await request(server)
      .post(`${BASE}/hosts`)
      .send({ name: "build-1", address: "not a host", targetUser: "agent-a" })
      .expect(422);
    await request(server)
      .post(`${BASE}/hosts`)
      .send({ name: "build-1", address: "example.com", targetUser: "agent-a" })
      .expect(201);
    await request(server)
      .post(`${BASE}/hosts`)
      .send({ name: "build-1-again", address: "example.com", targetUser: "agent-a" })
      .expect(409);
  });

  it("PUT /accesses/:id/hosts writes the host set and echoes it back", async () => {
    const { svc } = fakeService();
    const res = await request(app(member, { svc }))
      .put(`${BASE}/accesses/${SECRET_ID}/hosts`)
      .send({ hostRefs: ["h1", "h2"] })
      .expect(200);
    expect(res.body).toEqual({ hostRefs: ["h1", "h2"] });
    expect(svc.setSecretHostRefs).toHaveBeenCalledWith(COMPANY_ID, SECRET_ID, ["h1", "h2"], {
      userId: "user-a",
      agentId: null,
    });

    // strict body
    await request(app(member, { svc }))
      .put(`${BASE}/accesses/${SECRET_ID}/hosts`)
      .send({ hostRefs: ["h1"], extra: 1 })
      .expect(400);
  });

  it("resolves the company from the query parameter and refuses an ambiguous actor", async () => {
    const { svc } = fakeService();
    // explicit query parameter wins even for a multi-company actor
    await request(app(multiMember, { svc }))
      .get(`${BASE}/accesses?companyId=${COMPANY_ID}`)
      .expect(200);
    expect(svc.listSecrets).toHaveBeenCalledWith(COMPANY_ID);

    // no parameter and several memberships: 422, storage untouched
    const ambiguous = await request(app(multiMember, { svc })).get(`${BASE}/accesses`).expect(422);
    expect(ambiguous.body.error).toContain("companyId");
    expect(svc.listSecrets).toHaveBeenCalledTimes(1);

    // another company through the query parameter: 403, not a list
    await request(app(member, { svc })).get(`${BASE}/accesses?companyId=${outsider.companyIds[0]}`).expect(403);
  });

  it("deploy endpoint goes through the injected port (fake in part A)", async () => {
    const deploy = createFakeDeployPort();
    const hosts = fakeHosts();
    await hosts.writeHosts((current) => ({
      next: [
        ...current,
        { id: "h1", name: "build-1", address: "example.com", targetUser: "agent-a", enabled: true },
      ],
      result: null as never,
    }));
    const res = await request(app(member, { deploy, hosts }))
      .post(`${BASE}/hosts/h1/deploy/${SECRET_ID}`)
      .expect(200);
    expect(res.body.outcome).toBe("deployed");
    expect(deploy.calls).toHaveLength(1);
    expect(deploy.calls[0].input.fingerprint).toBe("SHA256:abc");
    await request(app(member, { deploy, hosts }))
      .post(`${BASE}/hosts/nope/deploy/${SECRET_ID}`)
      .expect(404);
  });
});
