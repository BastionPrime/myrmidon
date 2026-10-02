// myrmidon(H2): instructions bundle revisions — recording, listing, rollback.
//
// Runs against the real routes and an embedded Postgres, so the full path is
// exercised: PUT a bundle file -> a revision row appears; edit again -> the
// revision number grows; rollback -> the file content on disk is restored and
// the next bundle read (what a run's instruction delivery consumes) sees the
// old text, and the rollback itself is a new revision.

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentConfigRevisions,
  agents,
  agentInstructionsRevisions,
  companies,
  companyMemberships,
  createDb,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { errorHandler } from "../../middleware/index.js";
import { agentRoutes } from "../../routes/agents.js";
import { agentInstructionsRevisionsRoutes } from "./index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

const AGENTS_BODY_TEXT_V1 = "# Instructions v1\n\nAnswer in short sentences.\n";
const AGENTS_BODY_TEXT_V2 = "# Instructions v2\n\nAnswer with citations.\n";

function boardActor(companyId: string): Express.Request["actor"] {
  return {
    type: "board",
    userId: "user-a",
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "owner", status: "active" }],
    isInstanceAdmin: false,
    source: "session",
  };
}

async function createCompany(db: Db) {
  return db
    .insert(companies)
    .values({ name: `company-a ${randomUUID()}`, issuePrefix: `MS${randomUUID().slice(0, 6).toUpperCase()}` })
    .returning()
    .then((rows) => rows[0]!);
}

async function createBoardMembership(db: Db, companyId: string, userId: string) {
  await db.insert(companyMemberships).values({
    companyId,
    principalType: "user",
    principalId: userId,
    status: "active",
    membershipRole: "owner",
  });
  await db.insert(principalPermissionGrants).values({
    companyId,
    principalType: "user",
    principalId: userId,
    permissionKey: "agents:configure",
    scope: null,
    grantedByUserId: null,
  });
}

async function createAgent(db: Db, companyId: string, adapterConfig: Record<string, unknown> = {}) {
  return db
    .insert(agents)
    .values({
      companyId,
      name: `agent-a ${randomUUID().slice(0, 8)}`,
      role: "engineer",
      permissions: {},
      adapterType: "codex_local",
      adapterConfig,
      runtimeConfig: {},
    })
    .returning()
    .then((rows) => rows[0]!);
}

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", agentRoutes(db));
  app.use("/api", agentInstructionsRevisionsRoutes(db));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("myrmidon(H2) instructions revisions", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let paperclipHome: string | null = null;
  const savedPaperclipHome = process.env.PAPERCLIP_HOME;
  const savedInstanceId = process.env.PAPERCLIP_INSTANCE_ID;

  beforeAll(async () => {
    paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "h2-instructions-home-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "h2-instructions-test";
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-instructions-revisions-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(agentConfigRevisions);
    await db.delete(agentInstructionsRevisions);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    if (savedPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = savedPaperclipHome;
    if (savedInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = savedInstanceId;
    if (paperclipHome) await fs.rm(paperclipHome, { recursive: true, force: true });
    await tempDb?.cleanup();
  });

  it("an instructions edit creates a revision, and the rollback restores it", async () => {
    const company = await createCompany(db);
    await createBoardMembership(db, company.id, "user-a");
    const actor = boardActor(company.id);
    const app = () => createApp(db, actor);

    // Put the first version of the entry file through the vendored route.
    const agent = await createAgent(db, company.id);
    const putRes1 = await request(createApp(db, actor))
      .put(`/api/agents/${agent.id}/instructions-bundle/file`)
      .send({ path: "AGENTS.md", content: AGENTS_BODY_TEXT_V1 });
    expect(putRes1.status, JSON.stringify(putRes1.body)).toBe(200);

    const rows1 = await db
      .select()
      .from(agentInstructionsRevisions);
    expect(rows1).toHaveLength(1);
    expect(rows1[0]!.revisionNumber).toBe(1);
    expect(rows1[0]!.source).toBe("instructions_bundle_file_put");
    expect(rows1[0]!.files).toEqual([{ path: "AGENTS.md", content: AGENTS_BODY_TEXT_V1 }]);

    // Second edit: the revision count grows.
    const putRes2 = await request(createApp(db, actor))
      .put(`/api/agents/${agent.id}/instructions-bundle/file`)
      .send({ path: "AGENTS.md", content: AGENTS_BODY_TEXT_V2 });
    expect(putRes2.status).toBe(200);

    const rows2 = await db.select().from(agentInstructionsRevisions);
    expect(rows2).toHaveLength(2);

    // The list endpoint shows both, newest first.
    const listRes = await request(createApp(db, actor))
      .get(`/api/agents/${agent.id}/instructions-revisions`);
    expect(listRes.status).toBe(200);
    expect(listRes.body).toHaveLength(2);
    expect(listRes.body[0].revisionNumber).toBe(2);
    expect(listRes.body[0].source).toBe("instructions_bundle_file_put");

    // Roll back to revision 1 through the new route.
    const revisionId = rows1[0]!.id;
    const rollbackRes = await request(createApp(db, actor))
      .post(`/api/agents/${agent.id}/instructions-revisions/${revisionId}/rollback`)
      .send({});
    expect(rollbackRes.status, JSON.stringify(rollbackRes.body)).toBe(200);
    expect(rollbackRes.body.restoredRevisionNumber).toBe(1);

    // The bundle on disk (what the next run's instruction delivery reads) is
    // back to the first version.
    const fileRes = await request(createApp(db, actor))
      .get(`/api/agents/${agent.id}/instructions-bundle/file`)
      .query({ path: "AGENTS.md" });
    expect(fileRes.status).toBe(200);
    expect(fileRes.body.content).toBe(AGENTS_BODY_TEXT_V1);

    // The rollback itself became revision 3.
    const rows3 = await db.select().from(agentInstructionsRevisions);
    expect(rows3).toHaveLength(3);
    const rollbackRow = rows3.find((row) => row.source === "rollback");
    expect(rollbackRow).toBeDefined();
    expect(rollbackRow!.rolledBackFromRevisionId).toBe(revisionId);
    expect(rollbackRow!.files).toEqual([{ path: "AGENTS.md", content: AGENTS_BODY_TEXT_V1 }]);
  });

  it("the revision history is company-scoped and requires read access", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);

    const outsiderApp = createApp(db, {
      type: "board",
      userId: "user-b",
      companyIds: [],
      memberships: [],
      isInstanceAdmin: false,
      source: "session",
    });
    const res = await request(outsiderApp)
      .get(`/api/agents/${agent.id}/instructions-revisions`);
    expect(res.status).toBe(404);
  });

  it("an empty file set is not recorded as a revision", async () => {
    const company = await createCompany(db);
    await createBoardMembership(db, company.id, "user-a");
    const agent = await createAgent(db, company.id, {
      adapterType: "process",
    });
    const app = createApp(db, boardActor(company.id));

    // A delete on a bundle that never had files leaves no revision row.
    const delRes = await request(app)
      .delete(`/api/agents/${agent.id}/instructions-bundle/file`)
      .query({ path: "notes.md" });
    // The vendored route refuses an unconfigured bundle (404) or an unknown
    // file (404/422), and a board member without the right decision can see
    // 403; the point is: no revision row appears.
    expect([200, 403, 404, 422]).toContain(delRes.status);

    const rows = await db.select().from(agentInstructionsRevisions);
    expect(rows).toHaveLength(0);
  });
});
