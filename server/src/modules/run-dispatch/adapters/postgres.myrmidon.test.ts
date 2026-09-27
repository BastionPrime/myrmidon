import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../../__tests__/helpers/embedded-postgres.js";
import { createPostgresRunDispatchAdapter } from "./postgres.js";

// P2: the wake of a pending interaction's addressee survives an assignee that is someone else.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("run-dispatch: pending interaction addressee wake (P2)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-myrmidon-addressee-wake-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueThreadInteractions);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(input: { interactionStatus?: string; addressee?: "reviewer" | "assignee" } = {}) {
    const companyId = randomUUID();
    const assigneeId = randomUUID();
    const reviewerId = randomUUID();
    const issueId = randomUUID();
    const interactionId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "user-a",
    });
    for (const [id, name] of [
      [assigneeId, "agent-a"],
      [reviewerId, "agent-b"],
    ] as const) {
      await db.insert(agents).values({
        id,
        companyId,
        name,
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
      });
    }
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Task that asks another agent for confirmation",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: assigneeId,
    });
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId,
      issueId,
      kind: "request_confirmation",
      status: input.interactionStatus ?? "pending",
      addresseeAgentId: (input.addressee ?? "reviewer") === "reviewer" ? reviewerId : assigneeId,
      payload: { version: 1, prompt: "Approve the release notes?" },
    });
    return { companyId, assigneeId, reviewerId, issueId, interactionId };
  }

  async function seedRun(input: { companyId: string; agentId: string; contextSnapshot: Record<string, unknown> }) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "automation",
      status: "queued",
      contextSnapshot: input.contextSnapshot,
    });
    return runId;
  }

  function addresseeWakeContext(issueId: string, interactionId: string) {
    return {
      issueId,
      taskId: issueId,
      interactionId,
      interactionKind: "request_confirmation",
      wakeReason: "interaction_pending",
      source: "issue.interaction.created",
    };
  }

  async function runStatus(runId: string) {
    return db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]);
  }

  it("keeps the queued run of a non-assignee addressee of a pending interaction", async () => {
    const { companyId, reviewerId, issueId, interactionId } = await seed();
    const runId = await seedRun({
      companyId,
      agentId: reviewerId,
      contextSnapshot: addresseeWakeContext(issueId, interactionId),
    });

    const outcome = await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({
      runId,
      companyId,
      expectedStatus: "queued",
      now: new Date(),
    });

    expect(outcome.outcome).toBe("not_stale");
    expect(await runStatus(runId)).toEqual({ status: "queued", errorCode: null });
  });

  it("still cancels an ordinary wake of a non-assignee as issue_assignee_changed", async () => {
    const { companyId, reviewerId, issueId } = await seed();
    const runId = await seedRun({
      companyId,
      agentId: reviewerId,
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });

    const outcome = await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({
      runId,
      companyId,
      expectedStatus: "queued",
      now: new Date(),
    });

    expect(outcome).toMatchObject({ outcome: "cancelled", errorCode: "issue_assignee_changed" });
  });

  it("cancels the addressee wake once the interaction is no longer pending", async () => {
    const { companyId, reviewerId, issueId, interactionId } = await seed({ interactionStatus: "accepted" });
    const runId = await seedRun({
      companyId,
      agentId: reviewerId,
      contextSnapshot: addresseeWakeContext(issueId, interactionId),
    });

    const outcome = await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({
      runId,
      companyId,
      expectedStatus: "queued",
      now: new Date(),
    });

    expect(outcome).toMatchObject({ outcome: "cancelled", errorCode: "issue_assignee_changed" });
  });

  it("does not let another agent borrow the addressee wake context", async () => {
    const { companyId, assigneeId, issueId, interactionId } = await seed();
    const outsiderId = randomUUID();
    await db.insert(agents).values({
      id: outsiderId,
      companyId,
      name: "agent-c",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    expect(assigneeId).not.toBe(outsiderId);
    const runId = await seedRun({
      companyId,
      agentId: outsiderId,
      contextSnapshot: addresseeWakeContext(issueId, interactionId),
    });

    const outcome = await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({
      runId,
      companyId,
      expectedStatus: "queued",
      now: new Date(),
    });

    expect(outcome).toMatchObject({ outcome: "cancelled", errorCode: "issue_assignee_changed" });
  });
});
