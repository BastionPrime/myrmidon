import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: vi.fn(function child() {
      return this;
    }),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
  httpLogger: vi.fn(),
}));

import {
  PENDING_INTERACTION_WAKE_CANCELLED_INTERACTION_REASON,
  PENDING_INTERACTION_WAKE_CANCELLED_ISSUE_REASON,
  PENDING_INTERACTION_WAKE_RE_ADMISSION_LIMIT_REASON,
  PENDING_INTERACTION_WAKE_RE_ADMITTED_REASON,
  createPendingInteractionWakeSweep,
  type PendingInteractionWakeRow,
} from "../myrmidon/pending-interaction-wake-sweep.ts";

/**
 * P12: a parked addressee wake (`interaction-pending:<interaction>`) is settled by
 * the scheduler sweep — re-admitted while the interaction still waits, finalized
 * once it stopped waiting — instead of starving until a run of that task promotes it.
 */
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres pending interaction wake sweep tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const GRACE_MS = 10 * 60 * 1000;

describeEmbeddedPostgres("pending interaction wake sweep", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pending-interaction-wake-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(agentWakeupRequests);
    await db.delete(issueThreadInteractions);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgents() {
    const companyId = randomUUID();
    const addresseeAgentId = randomUUID();
    const otherAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-p12",
      issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: addresseeAgentId,
        companyId,
        name: "addressee",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId,
        name: "other",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    return { companyId, addresseeAgentId, otherAgentId };
  }

  async function seedIssue(input: { companyId: string; assigneeAgentId: string; status?: string }) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: "Task with a waiting interaction",
      status: input.status ?? "in_review",
      priority: "high",
      assigneeAgentId: input.assigneeAgentId,
    });
    return issueId;
  }

  async function seedInteraction(input: {
    companyId: string;
    issueId: string;
    addresseeAgentId: string;
    status?: string;
  }) {
    const interactionId = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId: input.companyId,
      issueId: input.issueId,
      kind: "request_confirmation",
      status: input.status ?? "pending",
      continuationPolicy: "wake_assignee",
      addresseeAgentId: input.addresseeAgentId,
      title: "Confirm the plan",
      payload: { version: 1, prompt: "Confirm?", supersedeOnUserComment: true },
    });
    return interactionId;
  }

  async function seedParkedWake(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    interactionId: string;
    status?: string;
    createdAt?: Date;
    runId?: string | null;
    payload?: Record<string, unknown>;
  }) {
    const wakeId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeId,
      companyId: input.companyId,
      agentId: input.agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "interaction_pending",
      status: input.status ?? "deferred_issue_execution",
      requestedByActorType: "agent",
      requestedByActorId: randomUUID(),
      idempotencyKey: `interaction-pending:${input.interactionId}`,
      runId: input.runId ?? null,
      createdAt: input.createdAt ?? new Date(Date.now() - 2 * GRACE_MS),
      payload: input.payload ?? {
        issueId: input.issueId,
        mutation: "interaction",
        interactionId: input.interactionId,
        interactionKind: "request_confirmation",
        sourceCommentId: null,
        _paperclipWakeContext: {
          source: "issue.interaction.created",
          issueId: input.issueId,
          wakeReason: "interaction_pending",
          interactionId: input.interactionId,
          interactionKind: "request_confirmation",
          wakeSource: "automation",
        },
      },
    });
    return wakeId;
  }

  async function seedActiveRun(input: { companyId: string; agentId: string; issueId: string; status?: string }) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      status: input.status ?? "running",
      invocationSource: "assignment",
      startedAt: new Date(),
      contextSnapshot: { issueId: input.issueId },
    });
    return runId;
  }

  function sweepOf(reAdmitted: PendingInteractionWakeRow[]) {
    const reAdmit = vi.fn(async (wake: PendingInteractionWakeRow) => {
      reAdmitted.push(wake);
    });
    const sweep = createPendingInteractionWakeSweep({ db, reAdmit });
    return { sweep, reAdmit };
  }

  async function readWake(id: string) {
    return db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, id))
      .then((rows) => rows[0] ?? null);
  }

  it("finalizes a parked wake once its interaction is no longer waiting", async () => {
    const { companyId, addresseeAgentId, otherAgentId } = await seedCompanyAndAgents();
    const issueId = await seedIssue({ companyId, assigneeAgentId: otherAgentId });
    const interactionId = await seedInteraction({ companyId, issueId, addresseeAgentId, status: "expired" });
    const wakeId = await seedParkedWake({ companyId, agentId: addresseeAgentId, issueId, interactionId });
    const reAdmitted: PendingInteractionWakeRow[] = [];
    const { sweep, reAdmit } = sweepOf(reAdmitted);

    const result = await sweep({ graceMs: GRACE_MS });

    expect(result).toMatchObject({ inspected: 1, cancelled: 1, reAdmitted: 0, failed: 0 });
    expect(reAdmit).not.toHaveBeenCalled();
    const wake = await readWake(wakeId);
    expect(wake?.status).toBe("cancelled");
    expect(wake?.error).toBe(PENDING_INTERACTION_WAKE_CANCELLED_INTERACTION_REASON);
    expect(wake?.finishedAt).not.toBeNull();
  });

  it("finalizes an orphaned queued wake whose run died and whose interaction stopped waiting", async () => {
    const { companyId, addresseeAgentId, otherAgentId } = await seedCompanyAndAgents();
    const issueId = await seedIssue({ companyId, assigneeAgentId: otherAgentId, status: "done" });
    const interactionId = await seedInteraction({ companyId, issueId, addresseeAgentId, status: "cancelled" });
    const abandonedRunId = await seedActiveRun({
      companyId,
      agentId: addresseeAgentId,
      issueId,
      status: "cancelled",
    });
    await db.update(heartbeatRuns).set({ finishedAt: new Date() }).where(eq(heartbeatRuns.id, abandonedRunId));
    const wakeId = await seedParkedWake({
      companyId,
      agentId: addresseeAgentId,
      issueId,
      interactionId,
      status: "queued",
      runId: abandonedRunId,
    });
    const reAdmitted: PendingInteractionWakeRow[] = [];
    const { sweep } = sweepOf(reAdmitted);

    const result = await sweep({ graceMs: GRACE_MS });

    expect(result).toMatchObject({ inspected: 1, cancelled: 1, reAdmitted: 0 });
    expect((await readWake(wakeId))?.status).toBe("cancelled");
  });

  it("re-admits a parked wake whose interaction still waits on a task with no live run", async () => {
    const { companyId, addresseeAgentId, otherAgentId } = await seedCompanyAndAgents();
    const issueId = await seedIssue({ companyId, assigneeAgentId: otherAgentId });
    const interactionId = await seedInteraction({ companyId, issueId, addresseeAgentId });
    const wakeId = await seedParkedWake({ companyId, agentId: addresseeAgentId, issueId, interactionId });
    const reAdmitted: PendingInteractionWakeRow[] = [];
    const { sweep, reAdmit } = sweepOf(reAdmitted);

    const result = await sweep({ graceMs: GRACE_MS });

    expect(result).toMatchObject({ inspected: 1, cancelled: 0, reAdmitted: 1 });
    expect(reAdmit).toHaveBeenCalledTimes(1);
    // The parked receipt is settled, so the release drain cannot promote it twice.
    const wake = await readWake(wakeId);
    expect(wake?.status).toBe("cancelled");
    expect(wake?.error).toBe(PENDING_INTERACTION_WAKE_RE_ADMITTED_REASON);
    // The re-admitted wake keeps the interaction identity and carries the sweep marker.
    const delivered = reAdmitted[0]!;
    expect(delivered.agentId).toBe(addresseeAgentId);
    expect(delivered.idempotencyKey).toBe(`interaction-pending:${interactionId}`);
    expect(delivered.payload.interactionId).toBe(interactionId);
    expect(delivered.payload.mutation).toBe("interaction");
    expect(delivered.payload.pendingInteractionWakeSweep).toMatchObject({ attempt: 1 });
    expect(delivered.attempts).toBe(1);
  });

  it("leaves the wake to the live run that already holds the task", async () => {
    const { companyId, addresseeAgentId, otherAgentId } = await seedCompanyAndAgents();
    const issueId = await seedIssue({ companyId, assigneeAgentId: otherAgentId });
    const interactionId = await seedInteraction({ companyId, issueId, addresseeAgentId });
    const wakeId = await seedParkedWake({ companyId, agentId: addresseeAgentId, issueId, interactionId });
    await seedActiveRun({ companyId, agentId: otherAgentId, issueId });
    const reAdmitted: PendingInteractionWakeRow[] = [];
    const { sweep, reAdmit } = sweepOf(reAdmitted);

    const result = await sweep({ graceMs: GRACE_MS });

    expect(result).toMatchObject({ inspected: 1, reAdmitted: 0, cancelled: 0, skippedActiveRun: 1 });
    expect(reAdmit).not.toHaveBeenCalled();
    expect((await readWake(wakeId))?.status).toBe("deferred_issue_execution");
  });

  it("leaves the wake to its own live run", async () => {
    const { companyId, addresseeAgentId, otherAgentId } = await seedCompanyAndAgents();
    const issueId = await seedIssue({ companyId, assigneeAgentId: otherAgentId });
    const interactionId = await seedInteraction({ companyId, issueId, addresseeAgentId });
    const ownRunId = await seedActiveRun({ companyId, agentId: addresseeAgentId, issueId, status: "queued" });
    const wakeId = await seedParkedWake({
      companyId,
      agentId: addresseeAgentId,
      issueId,
      interactionId,
      status: "queued",
      runId: ownRunId,
    });
    const reAdmitted: PendingInteractionWakeRow[] = [];
    const { sweep, reAdmit } = sweepOf(reAdmitted);

    const result = await sweep({ graceMs: GRACE_MS });

    expect(result).toMatchObject({ inspected: 1, reAdmitted: 0, cancelled: 0, skippedOwnRun: 1 });
    expect(reAdmit).not.toHaveBeenCalled();
    expect((await readWake(wakeId))?.status).toBe("queued");
  });

  it("does not re-admit a wake whose interaction waits for another agent", async () => {
    const { companyId, addresseeAgentId, otherAgentId } = await seedCompanyAndAgents();
    const issueId = await seedIssue({ companyId, assigneeAgentId: otherAgentId });
    const interactionId = await seedInteraction({ companyId, issueId, addresseeAgentId: otherAgentId });
    const wakeId = await seedParkedWake({ companyId, agentId: addresseeAgentId, issueId, interactionId });
    const reAdmitted: PendingInteractionWakeRow[] = [];
    const { sweep, reAdmit } = sweepOf(reAdmitted);

    const result = await sweep({ graceMs: GRACE_MS });

    expect(result).toMatchObject({ inspected: 1, cancelled: 1, reAdmitted: 0 });
    expect(reAdmit).not.toHaveBeenCalled();
    expect((await readWake(wakeId))?.error).toBe(PENDING_INTERACTION_WAKE_CANCELLED_INTERACTION_REASON);
  });

  it("finalizes a wake whose task closed before the interaction was answered", async () => {
    const { companyId, addresseeAgentId, otherAgentId } = await seedCompanyAndAgents();
    const issueId = await seedIssue({ companyId, assigneeAgentId: otherAgentId, status: "done" });
    const interactionId = await seedInteraction({ companyId, issueId, addresseeAgentId });
    const wakeId = await seedParkedWake({ companyId, agentId: addresseeAgentId, issueId, interactionId });
    const reAdmitted: PendingInteractionWakeRow[] = [];
    const { sweep } = sweepOf(reAdmitted);

    const result = await sweep({ graceMs: GRACE_MS });

    expect(result).toMatchObject({ inspected: 1, cancelled: 1, reAdmitted: 0 });
    expect((await readWake(wakeId))?.error).toBe(PENDING_INTERACTION_WAKE_CANCELLED_ISSUE_REASON);
  });

  it("stops re-admitting once the budget is spent, so a wake cannot storm the task", async () => {
    const { companyId, addresseeAgentId, otherAgentId } = await seedCompanyAndAgents();
    const issueId = await seedIssue({ companyId, assigneeAgentId: otherAgentId });
    const interactionId = await seedInteraction({ companyId, issueId, addresseeAgentId });
    const wakeId = await seedParkedWake({
      companyId,
      agentId: addresseeAgentId,
      issueId,
      interactionId,
      payload: {
        issueId,
        mutation: "interaction",
        interactionId,
        interactionKind: "request_confirmation",
        pendingInteractionWakeSweep: { attempt: 1 },
      },
    });
    const reAdmitted: PendingInteractionWakeRow[] = [];
    const { sweep, reAdmit } = sweepOf(reAdmitted);

    const result = await sweep({ graceMs: GRACE_MS });

    expect(result).toMatchObject({ inspected: 1, cancelled: 1, reAdmitted: 0 });
    expect(reAdmit).not.toHaveBeenCalled();
    expect((await readWake(wakeId))?.error).toBe(PENDING_INTERACTION_WAKE_RE_ADMISSION_LIMIT_REASON);
  });

  it("leaves a wake inside the grace window alone", async () => {
    const { companyId, addresseeAgentId, otherAgentId } = await seedCompanyAndAgents();
    const issueId = await seedIssue({ companyId, assigneeAgentId: otherAgentId });
    const interactionId = await seedInteraction({ companyId, issueId, addresseeAgentId, status: "expired" });
    const wakeId = await seedParkedWake({
      companyId,
      agentId: addresseeAgentId,
      issueId,
      interactionId,
      createdAt: new Date(),
    });
    const reAdmitted: PendingInteractionWakeRow[] = [];
    const { sweep, reAdmit } = sweepOf(reAdmitted);

    const result = await sweep({ graceMs: GRACE_MS });

    expect(result).toMatchObject({ inspected: 0, cancelled: 0, reAdmitted: 0 });
    expect(reAdmit).not.toHaveBeenCalled();
    expect((await readWake(wakeId))?.status).toBe("deferred_issue_execution");
  });

  it("leaves a settled wake receipt alone", async () => {
    const { companyId, addresseeAgentId, otherAgentId } = await seedCompanyAndAgents();
    const issueId = await seedIssue({ companyId, assigneeAgentId: otherAgentId });
    const interactionId = await seedInteraction({ companyId, issueId, addresseeAgentId });
    const wakeId = await seedParkedWake({
      companyId,
      agentId: addresseeAgentId,
      issueId,
      interactionId,
      status: "completed",
    });
    const reAdmitted: PendingInteractionWakeRow[] = [];
    const { sweep } = sweepOf(reAdmitted);

    const result = await sweep({ graceMs: GRACE_MS });

    expect(result).toMatchObject({ inspected: 0 });
    expect((await readWake(wakeId))?.status).toBe("completed");
  });
});