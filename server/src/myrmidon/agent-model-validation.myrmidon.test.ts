// myrmidon(BOT-TUNING-C): effort validation on the agent card save path.
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentConfigRevisions,
  agents,
  companies,
  companyMemberships,
  createDb,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { assertAgentEffortAccepted } from "./agent-model-validation.js";
import { effortForModel } from "./effort-policy/effort-policy.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

async function createCompany(db: Db) {
  return db
    .insert(companies)
    .values({ name: `company-a ${randomUUID()}`, issuePrefix: `MS${randomUUID().slice(0, 6).toUpperCase()}` })
    .returning()
    .then((rows) => rows[0]!);
}

async function createAgent(db: Db, companyId: string, name: string, adapterType: string, adapterConfig: Record<string, unknown> = {}) {
  return db
    .insert(agents)
    .values({
      companyId,
      name,
      role: "engineer",
      permissions: {},
      adapterType,
      adapterConfig,
      runtimeConfig: {},
    })
    .returning()
    .then((rows) => rows[0]!);
}

function boardActor(companyId: string): Express.Request["actor"] {
  return {
    type: "board",
    userId: "user-a",
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "owner", status: "active" }],
    isInstanceAdmin: true,
    source: "local_implicit",
  };
}

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", agentRoutes(db));
  app.use(errorHandler);
  return app;
}

describe("myrmidon(BOT-TUNING-C) effort policy (pure)", () => {
  it("an empty effort resolves to the GLM model default, never medium", () => {
    const resolved = effortForModel("glm-5.3", "");
    expect(resolved.value).toBe("high");
    expect(resolved.value).not.toBe("medium");
  });

  it("medium is not an accepted GLM effort", () => {
    expect(effortForModel("glm-5.3", "medium").source).toBe("invalid");
  });

  it("an unknown model falls back to the global Hermes list", () => {
    const resolved = effortForModel("model-a", "");
    expect(resolved.efforts).toContain("medium");
    expect(resolved.source).toBe("global_default");
  });
});

describe("myrmidon(BOT-TUNING-C) effort validation (no db)", () => {
  it("rejects an effort the model does not accept", () => {
    expect(() =>
      assertAgentEffortAccepted("hermes_local", { model: "glm-5.3", effort: "medium" }),
    ).toThrow(/does not accept effort/);
  });

  it("accepts an accepted effort, an empty effort and other adapters", () => {
    expect(() =>
      assertAgentEffortAccepted("hermes_local", { model: "glm-5.3", effort: "high" }),
    ).not.toThrow();
    expect(() =>
      assertAgentEffortAccepted("hermes_local", { model: "glm-5.3", effort: "" }),
    ).not.toThrow();
    expect(() =>
      assertAgentEffortAccepted("claude_local", { model: "glm-5.3", effort: "medium" }),
    ).not.toThrow();
  });
});

describeEmbeddedPostgres("myrmidon(BOT-TUNING-C) card save rejects a wrong effort", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const savedAdapterModels = process.env.PAPERCLIP_ADAPTER_MODELS;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-effort-validation-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    if (savedAdapterModels === undefined) delete process.env.PAPERCLIP_ADAPTER_MODELS;
    else process.env.PAPERCLIP_ADAPTER_MODELS = savedAdapterModels;
    await db.delete(activityLog);
    await db.delete(agentConfigRevisions);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("PATCH with a GLM model and effort=medium returns 422; an accepted value saves", async () => {
    process.env.PAPERCLIP_ADAPTER_MODELS = JSON.stringify({
      hermes_local: [{ id: "glm-5.3" }],
    });
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id, "agent-a", "hermes_local", { model: "glm-5.3" });
    const app = createApp(db, boardActor(company.id));

    const rejected = await request(app)
      .patch(`/api/agents/${agent.id}`)
      .send({ adapterConfig: { model: "glm-5.3", effort: "medium" } });
    expect(rejected.status).toBe(422);
    expect(JSON.stringify(rejected.body)).toContain("medium");

    const accepted = await request(app)
      .patch(`/api/agents/${agent.id}`)
      .send({ adapterConfig: { model: "glm-5.3", effort: "high" } });
    expect(accepted.status).toBe(200);
    expect(accepted.body.adapterConfig.effort).toBe("high");

    const empty = await request(app)
      .patch(`/api/agents/${agent.id}`)
      .send({ adapterConfig: { model: "glm-5.3", effort: "" } });
    expect(empty.status).toBe(200);
  });
});
