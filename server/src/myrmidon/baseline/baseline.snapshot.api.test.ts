// myrmidon(1.6.2-BASELINE-SNAPSHOT): API tests for baseline snapshots with label and pinned functionality
//
// Tests:
// - Creating a snapshot with POST /api/myrmidon/companies/:companyId/baseline/snapshots
// - Getting all snapshots with GET /api/myrmidon/companies/:companyId/baseline/snapshots
// - Getting a specific snapshot with GET /api/myrmidon/companies/:companyId/baseline/snapshots/:id
// - Verifying that agent keys get 403 when creating snapshots
// - Testing pinned snapshot behavior (only one pinned per company)

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  baselineMetricSnapshots,
  companies,
  createDb,
  heartbeatRuns,
  issueRelations,
  issues,
  litellmCostEvents,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { computeBaselineMetrics } from "./service.js";
import { runBaselineSnapshot } from "./startup.js";
import type { BaselineWindow } from "./metrics.js";
import { baselineRoutes } from "./routes.js";
import express from "express";
import request from "supertest";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

const WINDOW: BaselineWindow = {
  from: new Date("2026-09-01T00:00:00Z"),
  to: new Date("2026-09-30T00:00:00Z"),
};

/** The snapshot window the job freezes: the 14 days before `now`. */
const JOB_NOW = new Date("2026-09-12T00:00:00Z");

describeEmbeddedPostgres("myrmidon(1.6.2-BASELINE-SNAPSHOT) API endpoints", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let projectA!: string;
  let blockerX!: string;
  let blockerY!: string;
  let blockerZ!: string;
  let taskIds!: string[];
  let app: express.Application;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-baseline-snapshot-");
    db = createDb(tempDb.connectionString);

    const company = await db
      .insert(companies)
      .values({ name: `company-a ${randomUUID()}`, issuePrefix: `BL${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning()
      .then((rows) => rows[0]!);
    companyId = company.id;

    const engineer = await db
      .insert(agents)
      .values({
        companyId,
        name: "agent-a",
        role: "engineer",
        permissions: {},
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
      })
      .returning()
      .then((rows) => rows[0]!);
    const reviewer = await db
      .insert(agents)
      .values({
        companyId,
        name: "agent-b",
        role: "reviewer",
        permissions: {},
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
      })
      .returning()
      .then((rows) => rows[0]!);

    projectA = await db
      .insert(projects)
      .values({ companyId, name: "project-a" })
      .returning()
      .then((rows) => rows[0]!.id);

    const blockers = await db
      .insert(issues)
      .values(
        ["blocker-x", "blocker-y", "blocker-z"].map((title) => ({
          companyId,
          title,
          status: "in_progress",
        })),
      )
      .returning();
    [blockerX, blockerY, blockerZ] = blockers.map((row) => row.id);

    const t1 = await db
      .insert(issues)
      .values({
        companyId,
        title: "task-1",
        status: "done",
        projectId: projectA,
        assigneeAgentId: engineer.id,
        createdAt: new Date("2026-09-01T00:00:00Z"),
        completedAt: new Date("2026-09-02T00:00:00Z"),
      })
      .returning()
      .then((rows) => rows[0]!);
    const t2 = await db
      .insert(issues)
      .values({
        companyId,
        title: "task-2",
        status: "done",
        projectId: projectA,
        assigneeAgentId: reviewer.id,
        createdAt: new Date("2026-09-05T00:00:00Z"),
        completedAt: new Date("2026-09-05T12:00:00Z"),
      })
      .returning()
      .then((rows) => rows[0]!);
    const t3 = await db
      .insert(issues)
      .values({
        companyId,
        title: "task-3",
        status: "done",
        projectId: null,
        assigneeAgentId: engineer.id,
        createdAt: new Date("2026-09-10T00:00:00Z"),
        completedAt: new Date("2026-09-10T06:00:00Z"),
      })
      .returning()
      .then((rows) => rows[0]!);
    taskIds = [t1.id, t2.id, t3.id];

    // Status transitions, exactly the seeded story of the unit test:
    //  cycle 23h / review 9h / blocked 6h / one return  -> task-1
    //  cycle 10h / review 2h / no return                -> task-2
    //  cycle  5h / blocked 1h / never in review         -> task-3
    const transitions: Array<[string, string, string, string]> = [
      [t1.id, "2026-09-01T01:00:00Z", "backlog", "todo"],
      [t1.id, "2026-09-01T03:00:00Z", "todo", "in_progress"],
      [t1.id, "2026-09-01T05:00:00Z", "in_progress", "in_review"],
      [t1.id, "2026-09-01T09:00:00Z", "in_review", "in_progress"],
      [t1.id, "2026-09-01T11:00:00Z", "in_progress", "blocked"],
      [t1.id, "2026-09-01T13:00:00Z", "blocked", "in_progress"],
      [t1.id, "2026-09-01T14:00:00Z", "in_progress", "blocked"],
      [t1.id, "2026-09-01T18:00:00Z", "blocked", "in_progress"],
      [t1.id, "2026-09-01T19:00:00Z", "in_progress", "in_review"],
      [t1.id, "2026-09-02T00:00:00Z", "in_review", "done"],
      [t2.id, "2026-09-05T02:00:00Z", "backlog", "todo"],
      [t2.id, "2026-09-05T04:00:00Z", "todo", "in_progress"],
      [t2.id, "2026-09-05T10:00:00Z", "in_progress", "in_review"],
      [t2.id, "2026-09-05T12:00:00Z", "in_review", "done"],
      [t3.id, "2026-09-10T01:00:00Z", "backlog", "todo"],
      [t3.id, "2026-09-10T03:00:00Z", "todo", "in_progress"],
      [t3.id, "2026-09-10T04:00:00Z", "in_progress", "blocked"],
      [t3.id, "2026-09-10T05:00:00Z", "blocked", "in_progress"],
      [t3.id, "2026-09-10T06:00:00Z", "in_progress", "done"],
    ];
    await db.insert(activityLog).values(
      transitions.map(([issueId, at, from, to]) => ({
        companyId,
        actorType: "system",
        actorId: "system",
        action: "issue.updated",
        entityType: "issue",
        entityId: issueId,
        details: { status: to, _previous: { status: from } },
        createdAt: new Date(at),
      })),
    );

    // Three runs for task-1 inside the window, one outside it, one for task-2.
    const runValues: Array<{ issueId: string; at: string; agentId: string }> = [
      { issueId: t1.id, at: "2026-09-01T02:00:00Z", agentId: engineer.id },
      { issueId: t1.id, at: "2026-09-01T06:00:00Z", agentId: engineer.id },
      { issueId: t1.id, at: "2026-09-01T20:00:00Z", agentId: engineer.id },
      { issueId: t1.id, at: "2026-08-20T00:00:00Z", agentId: engineer.id },
      { issueId: t2.id, at: "2026-09-05T05:00:00Z", agentId: reviewer.id },
    ];
    await db.insert(heartbeatRuns).values(
      runValues.map((run) => ({
        companyId,
        agentId: run.agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "succeeded",
        startedAt: new Date(run.at),
        finishedAt: new Date(new Date(run.at).getTime() + 60_000),
        contextSnapshot: { issueId: run.issueId },
      })),
    );

    // Gateway-collected costs: 150 + 100 cents inside the window for task-1,
    // 999 outside it, 50 for task-2. litellm_cost_events wins as the source.
    await db.insert(litellmCostEvents).values(
      [
        { issueId: t1.id, cents: 150, at: "2026-09-01T06:00:00Z" },
        { issueId: t1.id, cents: 100, at: "2026-09-01T20:00:00Z" },
        { issueId: t1.id, cents: 999, at: "2026-08-20T00:00:00Z" },
        { issueId: t2.id, cents: 50, at: "2026-09-05T05:00:00Z" },
      ].map((cost) => ({
        id: `req-${randomUUID()}`,
        companyId,
        agentId: engineer.id,
        issueId: cost.issueId,
        provider: "openai",
        model: "example-model",
        inputTokens: 1,
        outputTokens: 1,
        costCents: cost.cents,
        occurredAt: new Date(cost.at),
      })),
    );

    await db.insert(issueRelations).values([
      { companyId, issueId: blockerX, relatedIssueId: t1.id, type: "blocks" },
      { companyId, issueId: blockerY, relatedIssueId: t1.id, type: "blocks" },
      { companyId, issueId: blockerZ, relatedIssueId: t3.id, type: "blocks" },
    ]);

    // Create an Express app for testing the routes
    app = express();
    app.use(express.json());
    
    // Mock actor middleware to simulate board access
    app.use((req, _res, next) => {
      req.actor = { type: "board", id: "test-board-user" };
      next();
    });
    
    app.use(baselineRoutes(db, { now: () => new Date("2026-10-01T12:00:00Z") }));
  }, 90_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("creates a snapshot with POST /api/myrmidon/companies/:companyId/baseline/snapshots", async () => {
    const response = await request(app)
      .post(`/api/myrmidon/companies/${companyId}/baseline/snapshots`)
      .send({
        from: "2026-09-01T00:00:00Z",
        to: "2026-09-30T00:00:00Z",
        label: "test-label",
        pinned: false
      })
      .expect(201);

    expect(response.body).toHaveProperty('id');
    expect(response.body.companyId).toBe(companyId);
    expect(response.body.windowFrom).toBe("2026-09-01T00:00:00.000Z");
    expect(response.body.windowTo).toBe("2026-09-30T00:00:00.000Z");
    expect(response.body.label).toBe("test-label");
    expect(response.body.pinned).toBe(false);
    
    // Verify the snapshot was saved in the database
    const dbSnapshot = await db
      .select()
      .from(baselineMetricSnapshots)
      .where(sql`id = ${response.body.id}`)
      .then(rows => rows[0]);
      
    expect(dbSnapshot).toBeDefined();
    expect(dbSnapshot.companyId).toBe(companyId);
    expect(dbSnapshot.label).toBe("test-label");
    expect(dbSnapshot.pinned).toBe(false);
  });

  it("gets all snapshots with GET /api/myrmidon/companies/:companyId/baseline/snapshots", async () => {
    // Create another snapshot to have multiple
    await request(app)
      .post(`/api/myrmidon/companies/${companyId}/baseline/snapshots`)
      .send({
        from: "2026-08-01T00:00:00Z",
        to: "2026-08-31T00:00:00Z",
        label: "second-test-label",
        pinned: true
      })
      .expect(201);

    const response = await request(app)
      .get(`/api/myrmidon/companies/${companyId}/baseline/snapshots`)
      .expect(200);

    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body.length).toBeGreaterThanOrEqual(2);
    
    // Should include both snapshots
    const snapshotLabels = response.body.map((s: any) => s.label);
    expect(snapshotLabels).toContain("test-label");
    expect(snapshotLabels).toContain("second-test-label");
  });

  it("gets a specific snapshot with GET /api/myrmidon/companies/:companyId/baseline/snapshots/:id", async () => {
    // Create a snapshot and get its ID
    const createResponse = await request(app)
      .post(`/api/myrmidon/companies/${companyId}/baseline/snapshots`)
      .send({
        from: "2026-07-01T00:00:00Z",
        to: "2026-07-31T00:00:00Z",
        label: "specific-test-label",
        pinned: false
      })
      .expect(201);

    const snapshotId = createResponse.body.id;
    
    const response = await request(app)
      .get(`/api/myrmidon/companies/${companyId}/baseline/snapshots/${snapshotId}`)
      .expect(200);

    expect(response.body.id).toBe(snapshotId);
    expect(response.body.label).toBe("specific-test-label");
    expect(response.body.pinned).toBe(false);
    expect(response.body.payload).toBeDefined(); // Full payload should be returned
  });

  it("allows only board users to create snapshots (agent key gets 403)", async () => {
    // Create a mock app that simulates agent access
    const agentApp = express();
    agentApp.use(express.json());
    
    // Mock actor middleware to simulate agent access
    agentApp.use((req, _res, next) => {
      req.actor = { type: "agent", id: "test-agent-key" };
      next();
    });
    
    agentApp.use(baselineRoutes(db, { now: () => new Date("2026-10-01T12:00:00Z") }));

    await request(agentApp)
      .post(`/api/myrmidon/companies/${companyId}/baseline/snapshots`)
      .send({
        from: "2026-09-01T00:00:00Z",
        to: "2026-09-30T00:00:00Z",
        label: "agent-attempt",
        pinned: false
      })
      .expect(403);
  });

  it("correctly handles pinned snapshot behavior (only one pinned per company)", async () => {
    // Create first pinned snapshot
    const firstPinned = await request(app)
      .post(`/api/myrmidon/companies/${companyId}/baseline/snapshots`)
      .send({
        from: "2026-06-01T00:00:00Z",
        to: "2026-06-30T00:00:00Z",
        label: "first-pinned",
        pinned: true
      })
      .expect(201);

    // Verify it's pinned
    expect(firstPinned.body.pinned).toBe(true);

    // Create second pinned snapshot (this should unpin the first)
    const secondPinned = await request(app)
      .post(`/api/myrmidon/companies/${companyId}/baseline/snapshots`)
      .send({
        from: "2026-07-01T00:00:00Z",
        to: "2026-07-31T00:00:00Z",
        label: "second-pinned",
        pinned: true
      })
      .expect(201);

    expect(secondPinned.body.pinned).toBe(true);

    // Get all snapshots to verify only the second one is pinned
    const allSnapshots = await request(app)
      .get(`/api/myrmidon/companies/${companyId}/baseline/snapshots`)
      .expect(200);

    const firstPinnedSnapshot = allSnapshots.body.find((s: any) => s.label === "first-pinned");
    const secondPinnedSnapshot = allSnapshots.body.find((s: any) => s.label === "second-pinned");

    // The first snapshot should now be unpinned
    expect(firstPinnedSnapshot.pinned).toBe(false);
    // The second snapshot should still be pinned
    expect(secondPinnedSnapshot.pinned).toBe(true);

    // Verify in the database too
    const dbFirst = await db
      .select({ pinned: baselineMetricSnapshots.pinned })
      .from(baselineMetricSnapshots)
      .where(sql`id = ${firstPinned.body.id}`)
      .then(rows => rows[0]);

    const dbSecond = await db
      .select({ pinned: baselineMetricSnapshots.pinned })
      .from(baselineMetricSnapshots)
      .where(sql`id = ${secondPinned.body.id}`)
      .then(rows => rows[0]);

    expect(dbFirst.pinned).toBe(false);
    expect(dbSecond.pinned).toBe(true);
  });
}, 120_000);