import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { issueService } from "../services/issues.js";
import { checkoutRunStatusForIssue } from "../myrmidon/issue-checkout-guard.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres checkout guard tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

const CHECKOUT_STATUSES = ["todo", "backlog", "blocked", "in_review"];

describeEmbeddedPostgres("issue checkout run-context gate and lock-owner status (myrmidon P5)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-issue-checkout-guard-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  function agentActor(companyId: string, agentId: string, runId: string): Express.Request["actor"] {
    return { type: "agent", agentId, companyId, runId, source: "agent_jwt" };
  }

  function boardActor(companyId: string): Express.Request["actor"] {
    return {
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "admin", status: "active" }],
      isInstanceAdmin: false,
      source: "session",
    };
  }

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const failedRunId = randomUUID();
    const currentRunId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Company A",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "agent-a",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values([
      { id: failedRunId, companyId, agentId, status: "failed", invocationSource: "manual", finishedAt: new Date() },
      { id: currentRunId, companyId, agentId, status: "running", invocationSource: "manual", startedAt: new Date() },
    ]);
    return { companyId, agentId, failedRunId, currentRunId };
  }

  async function insertTodoIssue(companyId: string, agentId: string, title: string) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title,
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });
    return issueId;
  }

  async function readLock(issueId: string) {
    return db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
  }

  it("refuses a context-less agent checkout with 403 before the lock is written", async () => {
    const { companyId, agentId, currentRunId } = await seed();
    const issueId = await insertTodoIssue(companyId, agentId, "Context-less checkout");

    const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .post(`/api/issues/${issueId}/checkout`)
      .send({ agentId, expectedStatuses: CHECKOUT_STATUSES });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body?.details?.code).toBe("cross_issue_influence_run_context_required");
    expect(await readLock(issueId)).toEqual({
      status: "todo",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: null,
    });
    const checkoutActivity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.checked_out"));
    expect(checkoutActivity).toHaveLength(0);
  });

  it("refuses a checkout whose run header names a run of another agent", async () => {
    const { companyId, agentId } = await seed();
    const otherAgentId = randomUUID();
    const otherRunId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "agent-b",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const issueId = await insertTodoIssue(companyId, agentId, "Foreign run header");
    await db.insert(heartbeatRuns).values({
      id: otherRunId,
      companyId,
      agentId: otherAgentId,
      status: "running",
      invocationSource: "manual",
      startedAt: new Date(),
      contextSnapshot: { issueId },
    });

    const res = await request(createApp(agentActor(companyId, agentId, otherRunId)))
      .post(`/api/issues/${issueId}/checkout`)
      .send({ agentId, expectedStatuses: CHECKOUT_STATUSES });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body?.details?.code).toBe("cross_issue_influence_run_context_required");
    expect((await readLock(issueId))?.checkoutRunId).toBeNull();
  });

  it("keeps checkout working for an agent run that carries task context", async () => {
    const { companyId, agentId, currentRunId } = await seed();
    const issueId = await insertTodoIssue(companyId, agentId, "Context-carrying checkout");
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId } }).where(eq(heartbeatRuns.id, currentRunId));

    const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .post(`/api/issues/${issueId}/checkout`)
      .send({ agentId, expectedStatuses: CHECKOUT_STATUSES });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await readLock(issueId)).toEqual({
      status: "in_progress",
      assigneeAgentId: agentId,
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
    });
  });

  it("leaves board checkouts untouched by the run-context gate", async () => {
    const { companyId, agentId } = await seed();
    const issueId = await insertTodoIssue(companyId, agentId, "Board checkout");

    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${issueId}/checkout`)
      .send({ agentId, expectedStatuses: CHECKOUT_STATUSES });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await readLock(issueId))?.status).toBe("in_progress");
  });

  it("classifies a lock owner as running, terminal, or missing", async () => {
    const { failedRunId, currentRunId } = await seed();

    expect(await checkoutRunStatusForIssue(db, { checkoutRunId: currentRunId })).toBe("running");
    expect(await checkoutRunStatusForIssue(db, { checkoutRunId: failedRunId })).toBe("terminal");
    expect(await checkoutRunStatusForIssue(db, { executionRunId: failedRunId })).toBe("terminal");
    expect(await checkoutRunStatusForIssue(db, { checkoutRunId: randomUUID() })).toBe("missing");
    expect(await checkoutRunStatusForIssue(db, { checkoutRunId: null, executionRunId: null })).toBe("missing");
  });

  it("reports checkoutRunStatus in the checkout conflict 409", async () => {
    const { companyId, agentId, currentRunId } = await seed();
    const contenderRunId = randomUUID();
    const issueId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: contenderRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "assignment",
      startedAt: new Date(),
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Live checkout race",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
      executionAgentNameKey: "agent-a",
      executionLockedAt: new Date(),
    });

    const res = await request(createApp(agentActor(companyId, agentId, contenderRunId)))
      .post(`/api/issues/${issueId}/checkout`)
      .send({ agentId, expectedStatuses: ["in_progress"] });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body).toMatchObject({
      error: "Issue checkout conflict",
      details: { checkoutRunStatus: "running" },
    });
  });

  it("reports checkoutRunStatus in the run ownership conflict 409", async () => {
    const { companyId, agentId, currentRunId } = await seed();
    const contenderRunId = randomUUID();
    const issueId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: contenderRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "assignment",
      startedAt: new Date(),
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Ownership conflict",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
      executionAgentNameKey: "agent-a",
      executionLockedAt: new Date(),
    });

    const failure = await issueService(db)
      .assertCheckoutOwner(issueId, agentId, contenderRunId)
      .then(() => null)
      .catch((err) => err as { status?: number; message?: string; details?: Record<string, unknown> });

    expect(failure?.status).toBe(409);
    expect(failure?.message).toBe("Issue run ownership conflict");
    expect(failure?.details?.checkoutRunStatus).toBe("running");
  });

  it("reports checkoutRunStatus when only the checkout run can release", async () => {
    const { companyId, agentId, currentRunId } = await seed();
    const contenderRunId = randomUUID();
    const issueId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: contenderRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "manual",
      startedAt: new Date(),
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Release by a non-owning run",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
      executionAgentNameKey: "agent-a",
      executionLockedAt: new Date(),
    });

    const failure = await issueService(db)
      .release(issueId, agentId, contenderRunId)
      .then(() => null)
      .catch((err) => err as { status?: number; message?: string; details?: Record<string, unknown> });

    expect(failure?.status).toBe(409);
    expect(failure?.message).toBe("Only checkout run can release issue");
    expect(failure?.details?.checkoutRunStatus).toBe("running");
    expect(await readLock(issueId)).toEqual({
      status: "in_progress",
      assigneeAgentId: agentId,
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
    });
  });
});
