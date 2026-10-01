// myrmidon(EGRESS-B): the egress list routes — the project list, the bot's own
// list, the refusal feed and the document the proxy fetches.
// Plain fakes for the table and the proxy: no database, no network.

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import { BOT_EGRESS_TOKEN_ENV, type EgressPolicyRow } from "./egress-policy.js";
import { botEgressRoutes, type BotEgressRoutesDeps, type BotEgressStore } from "./egress-routes.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_PROJECT_ID = "44444444-4444-4444-8444-444444444444";
const BOT_KEY = "agent-a";

const member = { type: "board", source: "session", userId: "user-a", isInstanceAdmin: false, companyIds: [COMPANY_ID] };
const outsider = { type: "board", source: "session", userId: "user-b", isInstanceAdmin: false, companyIds: ["other-company"] };
const agentActor = { type: "agent", source: "agent_key", agentId: "agent-a", companyId: COMPANY_ID, keyId: "key-a" };

const TOKEN = "token-a";

const PROJECT_NAMES: Record<string, string> = {
  [PROJECT_ID]: "example-project",
  [OTHER_PROJECT_ID]: "other-project",
};

function memoryStore(seed: EgressPolicyRow[] = []): BotEgressStore & { rows: EgressPolicyRow[] } {
  const rows = [...seed];
  // The store returns project rows with the name the journal uses filled in
  // (the table holds the id); this fake does the same.
  const named = (row: EgressPolicyRow): EgressPolicyRow =>
    row.scope === "project" ? { ...row, project: PROJECT_NAMES[row.targetId] ?? null } : row;
  return {
    rows,
    async list(companyId) {
      return companyId === COMPANY_ID ? rows.map(named) : [];
    },
    async listAll() {
      return rows.map(named);
    },
    async upsertProject(_companyId, projectId, policy) {
      const index = rows.findIndex((row) => row.scope === "project" && row.targetId === projectId);
      const next: EgressPolicyRow = { scope: "project", targetId: projectId, mode: policy.mode, verified: policy.verified, allow: policy.allow, project: null };
      if (index >= 0) rows[index] = next;
      else rows.push(next);
    },
    async upsertBot(_companyId, botKey, policy) {
      const index = rows.findIndex((row) => row.scope === "bot" && row.targetId === botKey);
      const next: EgressPolicyRow = { scope: "bot", targetId: botKey, mode: "log", verified: false, allow: policy.allow, project: policy.project };
      if (index >= 0) rows[index] = next;
      else rows.push(next);
    },
    async projectNames(companyId) {
      return companyId === COMPANY_ID ? new Map(Object.entries(PROJECT_NAMES)) : new Map();
    },
    async hasProject(companyId, projectId) {
      return companyId === COMPANY_ID && (projectId === PROJECT_ID || projectId === OTHER_PROJECT_ID);
    },
  };
}

function app(actor: unknown, deps: Partial<BotEgressRoutesDeps> & { store?: BotEgressStore } = {}) {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  server.use(
    "/api",
    botEgressRoutes({
      store: deps.store ?? memoryStore(),
      readRefusals: deps.readRefusals ?? (async () => []),
      env: { [BOT_EGRESS_TOKEN_ENV]: TOKEN },
      ...deps,
    }),
  );
  server.use(errorHandler);
  return server;
}

const policiesUrl = `/api/myrmidon/companies/${COMPANY_ID}/bot-egress/policies`;
const projectUrl = `/api/myrmidon/companies/${COMPANY_ID}/bot-egress/projects/${PROJECT_ID}`;
const botUrl = `/api/myrmidon/companies/${COMPANY_ID}/bot-egress/bots/${BOT_KEY}`;
const policyDocUrl = "/api/myrmidon/bot-egress/policy";

describe("myrmidon(EGRESS-B) bot egress routes: access", () => {
  it("answers 404 for another company", async () => {
    await request(app(outsider)).get(policiesUrl).expect(404);
    await request(app(outsider)).put(projectUrl).send({ mode: "log" }).expect(404);
  });

  it("refuses an agent actor everywhere", async () => {
    await request(app(agentActor)).get(policiesUrl).expect(403);
    await request(app(agentActor)).put(botUrl).send({}).expect(403);
  });
});

describe("myrmidon(EGRESS-B) project policy", () => {
  it("lists every project of the company, recording by default", async () => {
    const response = await request(app(member)).get(policiesUrl).expect(200);
    expect(response.body.projects.map((project: { name: string }) => project.name)).toEqual(["example-project", "other-project"]);
    expect(response.body.projects[0]).toMatchObject({ mode: "log", effectiveMode: "log", verified: false, allow: [] });
  });

  it("refuses block without a verified, non-empty list", async () => {
    const unverified = await request(app(member)).put(projectUrl).send({ mode: "block", allow: ["api.example.com"] }).expect(409);
    expect(unverified.body.error).toMatch(/verified/i);
    const empty = await request(app(member)).put(projectUrl).send({ mode: "block", verified: true, allow: [] }).expect(409);
    expect(empty.body.error).toMatch(/at least one allowed destination/i);
  });

  it("saves a verified blocking list and reports the effective mode", async () => {
    const response = await request(app(member))
      .put(projectUrl)
      .send({ mode: "block", verified: true, allow: ["api.example.com:443"] })
      .expect(200);
    expect(response.body.project).toMatchObject({ mode: "block", effectiveMode: "block", verified: true, allow: ["api.example.com:443"] });
  });

  it("refuses a mode it does not know and a destination that is a pattern", async () => {
    await request(app(member)).put(projectUrl).send({ mode: "refuse" }).expect(400);
    await request(app(member)).put(projectUrl).send({ mode: "log", allow: ["*.example.com"] }).expect(400);
  });

  it("answers 404 for a project that is not in the company", async () => {
    await request(app(member)).put(`/api/myrmidon/companies/${COMPANY_ID}/bot-egress/projects/55555555-5555-4555-8555-555555555555`).send({ mode: "log" }).expect(404);
    await request(app(member)).put("/api/myrmidon/companies/other-company/bot-egress/projects/not-a-uuid").send({ mode: "log" }).expect(404);
  });
});

describe("myrmidon(EGRESS-B) bot policy", () => {
  it("saves the bot's project and its own list, and lists them back", async () => {
    const store = memoryStore();
    await request(app(member, { store })).put(botUrl).send({ project: " example-project ", allow: ["extra.example.com:8443"] }).expect(200);
    const response = await request(app(member, { store })).get(policiesUrl).expect(200);
    expect(response.body.bots).toEqual([{ botKey: BOT_KEY, project: "example-project", allow: ["extra.example.com:8443"] }]);
  });

  it("refuses a bot key that cannot be one", async () => {
    await request(app(member)).put(`/api/myrmidon/companies/${COMPANY_ID}/bot-egress/bots/${encodeURIComponent("../etc")}`).send({}).expect(404);
  });
});

describe("myrmidon(EGRESS-B) the document the proxy fetches", () => {
  it("publishes nothing without the instance token set", async () => {
    const server = express();
    server.use(express.json());
    server.use("/api", botEgressRoutes({ store: memoryStore(), readRefusals: async () => [], env: {} }));
    server.use(errorHandler);
    const response = await request(server).get(policyDocUrl).expect(503);
    expect(response.body.code).toBe("bot_egress_policy_not_published");
  });

  it("refuses a wrong or missing token", async () => {
    await request(app(member)).get(policyDocUrl).expect(401);
    await request(app(member)).get(policyDocUrl).set("Authorization", "Bearer nope").expect(401);
  });

  it("publishes the lists, with block only where it is allowed", async () => {
    const store = memoryStore([
      { scope: "project", targetId: PROJECT_ID, mode: "block", verified: true, allow: ["api.example.com"], project: null },
      { scope: "project", targetId: OTHER_PROJECT_ID, mode: "block", verified: false, allow: ["api.example.com"], project: null },
      { scope: "bot", targetId: BOT_KEY, mode: "log", verified: false, allow: [], project: "example-project" },
    ]);
    const response = await request(app(member, { store })).get(policyDocUrl).set("Authorization", `Bearer ${TOKEN}`).expect(200);
    expect(response.body.bots).toEqual({ [BOT_KEY]: { project: "example-project", allow: [] } });
    expect(response.body.projects).toEqual({
      "example-project": { mode: "block", allow: ["api.example.com"] },
      "other-project": { mode: "log", allow: ["api.example.com"] },
    });
  });
});

describe("myrmidon(EGRESS-B) the refusal feed", () => {
  it("passes the proxy's refusals through", async () => {
    const readRefusals = vi.fn(async () => [{ bot: "agent-a", destination: "unknown.example.com", result: "blocked" }]);
    const response = await request(app(member, { readRefusals })).get(`/api/myrmidon/companies/${COMPANY_ID}/bot-egress/refusals`).expect(200);
    expect(response.body.refusals).toHaveLength(1);
  });

  it("answers 503, not a crash, when the proxy cannot be reached", async () => {
    const readRefusals = vi.fn(async () => {
      throw new Error("EGRESS_PROXY down");
    });
    const response = await request(app(member, { readRefusals })).get(`/api/myrmidon/companies/${COMPANY_ID}/bot-egress/refusals`).expect(503);
    expect(response.body.code).toBe("bot_egress_refusals_unavailable");
  });
});