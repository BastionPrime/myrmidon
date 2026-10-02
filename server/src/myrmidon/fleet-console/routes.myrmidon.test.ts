// myrmidon(SC1): the console API, driven end to end through express with plain
// fakes for the registry store, the journal and the two secret lookups.
//
// The acceptance points of SERVER-CONSOLE part A live here: only the company
// owner gets a token, the token is a Guacamole-readable blob that expires, and
// both the issue and the close land in the audit journal.

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import type { ConsoleJournal, ConsoleSessionClosedEntry, ConsoleTokenIssuedEntry } from "./journal.js";
import { fleetConsoleRoutes } from "./routes.js";
import type { FleetConsoleSettings } from "./settings.js";
import { consoleService, type ConsoleServiceDeps } from "./service.js";
import { decodeGuacamoleAuthJson, AuthJsonError } from "./token.js";
import type { FleetServerStore } from "./store.js";
import type { FleetServerView } from "./domain.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_COMPANY_ID = "33333333-3333-4333-8333-333333333333";
const SERVER_ID = "44444444-4444-4444-8444-444444444444";
const SESSION_ID = "55555555-5555-4555-8555-555555555555";
const AGENT_ID = "66666666-6666-4666-8666-666666666666";
const SECRET_KEY = "4C0B569E4C96DF157EEE1B65DD0E4D41";
const NOW = Date.parse("2026-09-30T08:00:00.000Z");

const OWNER = {
  type: "board",
  source: "session",
  userId: "user-owner",
  isInstanceAdmin: false,
  companyIds: [COMPANY_ID],
  memberships: [{ companyId: COMPANY_ID, status: "active", membershipRole: "owner" }],
};
const MEMBER = { ...OWNER, userId: "user-member", memberships: [{ companyId: COMPANY_ID, status: "active", membershipRole: "member" }] };
const VIEWER = { ...OWNER, userId: "user-viewer", memberships: [{ companyId: COMPANY_ID, status: "active", membershipRole: "viewer" }] };
const COMPANY_ADMIN = { ...OWNER, userId: "user-admin", memberships: [{ companyId: COMPANY_ID, status: "active", membershipRole: "admin" }] };
const OUTSIDER = {
  type: "board",
  source: "session",
  userId: "user-outsider",
  isInstanceAdmin: false,
  companyIds: [OTHER_COMPANY_ID],
  memberships: [{ companyId: OTHER_COMPANY_ID, status: "active", membershipRole: "owner" }],
};
const AGENT = { type: "agent", source: "agent_key", agentId: AGENT_ID, companyId: COMPANY_ID, keyId: "key-a" };

function serverRow(overrides: Partial<FleetServerView> = {}): FleetServerView {
  return {
    id: SERVER_ID,
    slug: "node-a",
    name: "Node A",
    hostname: "192.0.2.10",
    port: 22,
    protocol: "ssh",
    username: "fleet-console",
    passwordSecretKey: null,
    description: null,
    enabled: true,
    createdAt: "2026-09-30T07:00:00.000Z",
    updatedAt: "2026-09-30T07:00:00.000Z",
    ...overrides,
  };
}

function memoryStore(rows: FleetServerView[]): FleetServerStore {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return {
    async list(companyId) {
      return [...byId.values()].filter(() => companyId === COMPANY_ID);
    },
    async getById(companyId, id) {
      return companyId === COMPANY_ID ? byId.get(id) ?? null : null;
    },
    async getBySlug(companyId, slug) {
      if (companyId !== COMPANY_ID) return null;
      return [...byId.values()].find((row) => row.slug === slug) ?? null;
    },
    async upsert(companyId, input) {
      const existing = [...byId.values()].find((row) => row.slug === input.slug);
      const row = serverRow({
        ...input,
        id: existing?.id ?? SERVER_ID,
        createdAt: existing?.createdAt ?? new Date(NOW).toISOString(),
      });
      byId.set(row.id, row);
      return row;
    },
  };
}

interface JournalFake extends ConsoleJournal {
  issued: ConsoleTokenIssuedEntry[];
  closed: ConsoleSessionClosedEntry[];
}

function memoryJournal(issue: (entry: ConsoleTokenIssuedEntry) => void = () => {}): JournalFake {
  const issued: ConsoleTokenIssuedEntry[] = [];
  const closed: ConsoleSessionClosedEntry[] = [];
  return {
    issued,
    closed,
    async recordTokenIssued(entry) {
      issued.push(entry);
      issue(entry);
    },
    async recordSessionClosed(entry) {
      closed.push(entry);
    },
    async findIssuedSession(companyId, sessionId) {
      const entry = issued.filter((row) => row.sessionId === sessionId).at(-1);
      return entry ? { issuedAt: entry.issuedAt, serverId: entry.serverId, serverSlug: entry.serverSlug } : null;
    },
  };
}

const CONFIGURED: FleetConsoleSettings = {
  guacamoleUrl: "https://guac.example.com",
  secretKeyName: "guacamole-json-secret-key",
  tokenTtlMs: 5 * 60 * 1000,
};

let journal: JournalFake;

function makeApp(
  actor: unknown,
  overrides: Partial<ConsoleServiceDeps> = {},
) {
  journal = memoryJournal();
  const service = consoleService({
    store: memoryStore([serverRow()]),
    journal,
    settings: CONFIGURED,
    readSecretKey: async () => SECRET_KEY,
    readNodePassword: async () => null,
    now: () => NOW,
    newSessionId: () => SESSION_ID,
    ...overrides,
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", fleetConsoleRoutes({ service }));
  app.use(errorHandler);
  return app;
}

function tokenRequest(body: Record<string, unknown> = {}) {
  return { companyId: COMPANY_ID, slug: "node-a", ...body };
}

beforeEach(() => {
  journal = memoryJournal();
});

describe("POST /api/myrmidon/fleet/console-token", () => {
  it("gives the owner a Guacamole-readable token for a registry node", async () => {
    const res = await request(makeApp(OWNER)).post("/api/myrmidon/fleet/console-token").send(tokenRequest());
    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBe(SESSION_ID);
    expect(res.body.consoleUrl).toBe(`https://guac.example.com/#/?data=${encodeURIComponent(res.body.token)}`);
    expect(res.body.expiresAt).toBe(new Date(NOW + CONFIGURED.tokenTtlMs).toISOString());

    const decoded = decodeGuacamoleAuthJson(res.body.token, SECRET_KEY, NOW);
    expect(decoded.expires).toBe(NOW + CONFIGURED.tokenTtlMs);
    expect(decoded.connections["Node A"]).toEqual({
      protocol: "ssh",
      parameters: { hostname: "192.0.2.10", port: "22", username: "fleet-console" },
    });

    expect(journal.issued).toHaveLength(1);
    expect(journal.issued[0]).toMatchObject({
      companyId: COMPANY_ID,
      sessionId: SESSION_ID,
      serverId: SERVER_ID,
      serverSlug: "node-a",
      hostname: "192.0.2.10",
      actorType: "user",
      actorId: "user-owner",
    });
  });

  it("stores no secret in the journal entry", async () => {
    const res = await request(makeApp(OWNER)).post("/api/myrmidon/fleet/console-token").send(tokenRequest());
    const entry = JSON.stringify(journal.issued[0]);
    expect(entry).not.toContain(SECRET_KEY);
    expect(entry).not.toContain(res.body.token);
  });

  it("keeps the token valid until expires and refuses it afterwards", async () => {
    const res = await request(makeApp(OWNER)).post("/api/myrmidon/fleet/console-token").send(tokenRequest());
    const token = res.body.token as string;
    expect(decodeGuacamoleAuthJson(token, SECRET_KEY, NOW + CONFIGURED.tokenTtlMs - 1)).toBeTruthy();
    let code: string | null = null;
    try {
      decodeGuacamoleAuthJson(token, SECRET_KEY, NOW + CONFIGURED.tokenTtlMs);
    } catch (err) {
      code = err instanceof AuthJsonError ? err.code : "not-an-auth-error";
    }
    expect(code).toBe("expired");
  });

  it("carries the node password the registry row names, from the secret store", async () => {
    const app = makeApp(OWNER, {
      store: memoryStore([serverRow({ passwordSecretKey: "node-a-password" })]),
      readNodePassword: async (companyId, key) => (companyId === COMPANY_ID && key === "node-a-password" ? "node-password-a" : null),
    });
    const res = await request(app).post("/api/myrmidon/fleet/console-token").send(tokenRequest());
    expect(res.status).toBe(200);
    expect(res.body.token).not.toContain("node-password-a");
    const decoded = decodeGuacamoleAuthJson(res.body.token, SECRET_KEY, NOW);
    expect(decoded.connections["Node A"]!.parameters.password).toBe("node-password-a");
  });

  it("answers 403 for a company member", async () => {
    const res = await request(makeApp(MEMBER)).post("/api/myrmidon/fleet/console-token").send(tokenRequest());
    expect(res.status).toBe(403);
    expect(journal.issued).toHaveLength(0);
  });

  it("answers 403 for a viewer and for a company admin", async () => {
    for (const actor of [VIEWER, COMPANY_ADMIN]) {
      const res = await request(makeApp(actor)).post("/api/myrmidon/fleet/console-token").send(tokenRequest());
      expect(res.status, `actor ${String((actor as { userId?: string }).userId)}`).toBe(403);
    }
  });

  it("answers 403 for an agent key", async () => {
    const res = await request(makeApp(AGENT)).post("/api/myrmidon/fleet/console-token").send(tokenRequest());
    expect(res.status).toBe(403);
  });

  it("answers 403 for a board user of another company", async () => {
    const res = await request(makeApp(OUTSIDER)).post("/api/myrmidon/fleet/console-token").send(tokenRequest());
    expect(res.status).toBe(403);
  });

  it("answers 409 for a disabled node and 404 for an unknown one", async () => {
    const disabled = makeApp(OWNER, { store: memoryStore([serverRow({ enabled: false })]) });
    expect((await request(disabled).post("/api/myrmidon/fleet/console-token").send(tokenRequest())).status).toBe(409);
    const missing = makeApp(OWNER, { store: memoryStore([]) });
    expect((await request(missing).post("/api/myrmidon/fleet/console-token").send(tokenRequest())).status).toBe(404);
  });

  it("answers 503 while the instance has no console URL or no signing secret", async () => {
    const unconfigured = makeApp(OWNER, { settings: { ...CONFIGURED, guacamoleUrl: null } });
    expect((await request(unconfigured).post("/api/myrmidon/fleet/console-token").send(tokenRequest())).status).toBe(503);

    const noSecret = makeApp(OWNER, { readSecretKey: async () => null });
    expect((await request(noSecret).post("/api/myrmidon/fleet/console-token").send(tokenRequest())).status).toBe(503);

    const badSecret = makeApp(OWNER, { readSecretKey: async () => "not-a-key" });
    expect((await request(badSecret).post("/api/myrmidon/fleet/console-token").send(tokenRequest())).status).toBe(503);

    const noNodeSecret = makeApp(OWNER, {
      store: memoryStore([serverRow({ passwordSecretKey: "node-a-password" })]),
      readNodePassword: async () => null,
    });
    expect((await request(noNodeSecret).post("/api/myrmidon/fleet/console-token").send(tokenRequest())).status).toBe(503);
  });
});

describe("POST /api/myrmidon/fleet/console-sessions/close", () => {
  it("journals the duration of the session the panel opened", async () => {
    const app = makeApp(OWNER);
    await request(app).post("/api/myrmidon/fleet/console-token").send(tokenRequest());
    const res = await request(app)
      .post("/api/myrmidon/fleet/console-sessions/close")
      .send({ companyId: COMPANY_ID, sessionId: SESSION_ID });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ sessionId: SESSION_ID, serverId: SERVER_ID, durationMs: 0 });
    expect(journal.closed).toHaveLength(1);
    expect(journal.closed[0]).toMatchObject({ actorId: "user-owner", durationMs: 0, serverId: SERVER_ID });
  });

  it("measures the elapsed time between the issue and the close", async () => {
    const issuedAt = NOW;
    let clock = NOW;
    const app = makeApp(OWNER, { now: () => clock });
    await request(app).post("/api/myrmidon/fleet/console-token").send(tokenRequest());
    clock = issuedAt + 42_000;
    const res = await request(app)
      .post("/api/myrmidon/fleet/console-sessions/close")
      .send({ companyId: COMPANY_ID, sessionId: SESSION_ID });
    expect(res.status).toBe(200);
    expect(res.body.durationMs).toBe(42_000);
  });

  it("answers 404 for a session the panel never issued, and 403 for a non-owner", async () => {
    const app = makeApp(OWNER);
    const unknown = await request(app)
      .post("/api/myrmidon/fleet/console-sessions/close")
      .send({ companyId: COMPANY_ID, sessionId: SESSION_ID });
    expect(unknown.status).toBe(404);
    const denied = await request(makeApp(MEMBER))
      .post("/api/myrmidon/fleet/console-sessions/close")
      .send({ companyId: COMPANY_ID, sessionId: SESSION_ID });
    expect(denied.status).toBe(403);
  });
});

describe("fleet registry routes", () => {
  it("lists the company registry for the owner only", async () => {
    const res = await request(makeApp(OWNER)).get(`/api/myrmidon/fleet/servers?companyId=${COMPANY_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.servers).toHaveLength(1);
    expect(res.body.servers[0]).toMatchObject({ slug: "node-a", protocol: "ssh", username: "fleet-console" });
    const denied = await request(makeApp(MEMBER)).get(`/api/myrmidon/fleet/servers?companyId=${COMPANY_ID}`);
    expect(denied.status).toBe(403);
  });

  it("registers a row and fills the protocol defaults", async () => {
    const res = await request(makeApp(OWNER)).put("/api/myrmidon/fleet/servers").send({
      companyId: COMPANY_ID,
      slug: "node-b",
      name: "Node B",
      hostname: "192.0.2.11",
    });
    expect(res.status).toBe(200);
    expect(res.body.server).toMatchObject({
      slug: "node-b",
      protocol: "ssh",
      port: 22,
      username: "fleet-console",
      enabled: true,
    });
    const denied = await request(makeApp(MEMBER)).put("/api/myrmidon/fleet/servers").send({
      companyId: COMPANY_ID,
      slug: "node-b",
      name: "Node B",
      hostname: "192.0.2.11",
    });
    expect(denied.status).toBe(403);
  });

  it("rejects a row with a malformed slug", async () => {
    const res = await request(makeApp(OWNER)).put("/api/myrmidon/fleet/servers").send({
      companyId: COMPANY_ID,
      slug: "Node B",
      name: "Node B",
      hostname: "192.0.2.11",
    });
    expect(res.status).toBe(400);
  });
});