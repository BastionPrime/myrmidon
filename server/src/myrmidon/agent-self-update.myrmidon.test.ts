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
import { authorizationService } from "../services/authorization.js";
import { collectChangedModelNames } from "./agent-model-validation.js";

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

async function createAgent(db: Db, companyId: string, name: string, adapterConfig: Record<string, unknown> = {}) {
  return db
    .insert(agents)
    .values({
      companyId,
      name,
      role: "engineer",
      permissions: {},
      adapterType: "process",
      adapterConfig,
      runtimeConfig: {},
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function grantAgentPermission(db: Db, companyId: string, agentId: string, permissionKey: "agents:configure") {
  await db.insert(companyMemberships).values({
    companyId,
    principalType: "agent",
    principalId: agentId,
    status: "active",
    membershipRole: "member",
  });
  await db.insert(principalPermissionGrants).values({
    companyId,
    principalType: "agent",
    principalId: agentId,
    permissionKey,
    scope: null,
    grantedByUserId: null,
  });
}

function agentActor(companyId: string, agentId: string): Express.Request["actor"] {
  return { type: "agent", agentId, companyId, source: "agent_jwt" };
}

function boardActor(companyId: string, isInstanceAdmin: boolean): Express.Request["actor"] {
  return {
    type: "board",
    userId: "user-a",
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "owner", status: "active" }],
    isInstanceAdmin,
    source: isInstanceAdmin ? "local_implicit" : "session",
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

describe("myrmidon(S4) model change detection", () => {
  it("reports only new, non-special model names", () => {
    expect(
      collectChangedModelNames(
        { model: "model-a", models: { fallbacks: ["model-b"] } },
        { model: "model-a", models: { vision: "model-v", fallbacks: ["model-b", "model-c", ""], stt: "default" } },
      ),
    ).toEqual([
      { field: "adapterConfig.models.vision", model: "model-v" },
      { field: "adapterConfig.models.fallbacks", model: "model-c" },
    ]);
  });
});

describeEmbeddedPostgres("myrmidon(S4) agent does not change its own configuration", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const savedAdapterModels = process.env.PAPERCLIP_ADAPTER_MODELS;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-agent-self-update-");
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

  it("agent token PATCH of its own card returns 403", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id, "agent-a");

    const res = await request(createApp(db, agentActor(company.id, agent.id)))
      .patch(`/api/agents/${agent.id}`)
      .send({ adapterConfig: { timeoutSec: 99 } });
    expect(res.status).toBe(403);

    const profile = await request(createApp(db, agentActor(company.id, agent.id)))
      .patch(`/api/agents/${agent.id}`)
      .send({ title: "Self-promoted" });
    expect(profile.status).toBe(403);
  });

  it("an agent with agents:configure still cannot change itself", async () => {
    const company = await createCompany(db);
    const manager = await createAgent(db, company.id, "agent-manager");
    await grantAgentPermission(db, company.id, manager.id, "agents:configure");

    const res = await request(createApp(db, agentActor(company.id, manager.id)))
      .patch(`/api/agents/${manager.id}`)
      .send({ adapterConfig: { inheritProcessEnv: true } });
    expect(res.status).toBe(403);
  });

  it("reading its own configuration stays allowed", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id, "agent-a");
    const decision = await authorizationService(db).decide({
      actor: agentActor(company.id, agent.id),
      action: "agent_config:read",
      resource: { type: "agent", companyId: company.id, agentId: agent.id },
    });
    expect(decision.allowed).toBe(true);
  });

  it("agent with agents:configure changes another agent as before", async () => {
    const company = await createCompany(db);
    const manager = await createAgent(db, company.id, "agent-manager");
    const worker = await createAgent(db, company.id, "agent-worker");
    await grantAgentPermission(db, company.id, manager.id, "agents:configure");

    const decision = await authorizationService(db).decide({
      actor: agentActor(company.id, manager.id),
      action: "agent_config:update",
      resource: { type: "agent", companyId: company.id, agentId: worker.id },
    });
    expect(decision).toMatchObject({ allowed: true, reason: "allow_direct_change" });

    const res = await request(createApp(db, agentActor(company.id, manager.id)))
      .patch(`/api/agents/${worker.id}`)
      .send({ adapterConfig: { timeoutSec: 99 } });
    expect(res.status).toBe(200);
  });

  it("board admin changes the agent card", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id, "agent-a");

    const res = await request(createApp(db, boardActor(company.id, true)))
      .patch(`/api/agents/${agent.id}`)
      .send({ adapterConfig: { timeoutSec: 99 } });
    expect(res.status).toBe(200);
    expect(res.body.adapterConfig.timeoutSec).toBe(99);
  });

  it("unknown model returns 422, known and special values are accepted", async () => {
    process.env.PAPERCLIP_ADAPTER_MODELS = JSON.stringify({
      process: [{ id: "model-a" }, { id: "model-b" }],
    });
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id, "agent-a");
    const app = createApp(db, boardActor(company.id, true));

    const unknown = await request(app)
      .patch(`/api/agents/${agent.id}`)
      .send({ adapterConfig: { model: "model-unknown" } });
    expect(unknown.status).toBe(422);
    expect(JSON.stringify(unknown.body)).toContain("model-unknown");

    const unknownFallback = await request(app)
      .patch(`/api/agents/${agent.id}`)
      .send({ adapterConfig: { models: { vision: "model-b", fallbacks: ["model-a", "model-x"] } } });
    expect(unknownFallback.status).toBe(422);
    expect(JSON.stringify(unknownFallback.body)).toContain("adapterConfig.models.fallbacks");

    for (const field of ["vision", "video", "stt", "tts"]) {
      const res = await request(app)
        .patch(`/api/agents/${agent.id}`)
        .send({ adapterConfig: { models: { [field]: "model-unknown" } } });
      expect(res.status).toBe(422);
      expect(JSON.stringify(res.body)).toContain(`adapterConfig.models.${field}`);
    }

    const known = await request(app)
      .patch(`/api/agents/${agent.id}`)
      .send({ adapterConfig: { model: "model-a", models: { vision: "model-b", fallbacks: ["model-a"] } } });
    expect(known.status).toBe(200);

    const special = await request(app)
      .patch(`/api/agents/${agent.id}`)
      .send({ adapterConfig: { model: "default" } });
    expect(special.status).toBe(200);

    const empty = await request(app)
      .patch(`/api/agents/${agent.id}`)
      .send({ adapterConfig: { model: "" } });
    expect(empty.status).toBe(200);
  });

  it("inheritProcessEnv can be enabled only by an instance admin", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id, "agent-a");
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: "user-a",
      status: "active",
      membershipRole: "owner",
    });
    await db.insert(principalPermissionGrants).values({
      companyId: company.id,
      principalType: "user",
      principalId: "user-a",
      permissionKey: "agents:configure",
      scope: null,
      grantedByUserId: null,
    });

    const member = await request(createApp(db, boardActor(company.id, false)))
      .patch(`/api/agents/${agent.id}`)
      .send({ adapterConfig: { inheritProcessEnv: true } });
    expect(member.status).toBe(403);
    expect(JSON.stringify(member.body)).toContain("inheritProcessEnv");

    const admin = await request(createApp(db, boardActor(company.id, true)))
      .patch(`/api/agents/${agent.id}`)
      .send({ adapterConfig: { inheritProcessEnv: true } });
    expect(admin.status).toBe(200);
    expect(admin.body.adapterConfig.inheritProcessEnv).toBe(true);

    // Keeping an already enabled flag while editing other fields is fine.
    const memberEdit = await request(createApp(db, boardActor(company.id, false)))
      .patch(`/api/agents/${agent.id}`)
      .send({ adapterConfig: { inheritProcessEnv: true, timeoutSec: 30 } });
    expect(memberEdit.status).toBe(200);
  });
});
