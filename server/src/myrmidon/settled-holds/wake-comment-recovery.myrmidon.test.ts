// myrmidon(L2, rounds 1 to 3 fixes): end-to-end regressions for the defects
// senior review found, run through the real admission (heartbeat.ts's
// enqueueWakeup), claim (run-dispatch/adapters/postgres.ts), retry scheduling
// and the /wakeup route:
//  - an explicit wake with no message of its own (here: reassignment) used to
//    adopt a deferred agent comment and then lose it, because admission and
//    the successor run's own first claim classified "explicit" from
//    different (and, for the claim, mutated) data;
//  - the hold it bypassed kept blocking every automatic continuation of the
//    successor (a scheduled retry here), so the hold is now superseded
//    atomically with the successor;
//  - a wake requested by anything but a person never bypasses a hold, even
//    when its reason/source shape is an explicit wake's;
//  - round 3: a wake admitted only by the bypass, for an issue on which the
//    same agent already has a run waiting in the queue (queued or a scheduled
//    retry). That run's claim would meet the hold and cancel it, so a wake
//    merged into it, or parked behind it, was lost with it. The admission now
//    cancels the waiting run as its claim would (same transaction, under the
//    issue lock, `execution_reconciliation_required`) and creates the
//    successor, which supersedes the hold. A wake the bypass does not admit
//    (a live hold, a wake by a non-person, the opt-out flag) is still
//    rejected, leaves the waiting run alone, and the /wakeup answer names the
//    lock.
// See supersede-explicit-wake.ts and cancel-waiting-run.ts.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterEach, afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issueComments, issueRecoveryActions, issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Wake-comment-recovery test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../../adapters/index.ts")>("../../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })),
  };
});

import { errorHandler } from "../../middleware/index.js";
import { agentRoutes } from "../../routes/agents.js";
import { heartbeatService } from "../../services/heartbeat.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// The first run in a fresh test process loads most of the server lazily and can
// take well over ten seconds on a loaded CI worker, so waits are generous and
// only ever cost time when something is actually wrong.
const RUN_WAIT_MS = 60_000;
const TEST_TIMEOUT_MS = 120_000;

describeEmbeddedPostgres("explicit wake past a settled hold (L2, rounds 1 to 3)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-wake-comment-recovery-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
  }, 30_000);

  afterEach(async () => {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      if (!runs.some((run) => ["queued", "running", "scheduled_retry"].includes(run.status))) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    mockAdapterExecute.mockClear();
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: `W${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "user-a",
      requireBoardApprovalForNewAgents: false,
    });
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId, companyId, name: "agent-a", role: "engineer", status: "active",
      adapterType: "codex_local", adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    const [issue] = await db.insert(issues).values({
      companyId, title: "task", status: "in_progress", priority: "medium", assigneeAgentId: agentId,
    }).returning();
    // A settled ("do not replay") hold with no named run: nothing to verify
    // has actually stopped, so an explicitly authorized wake may bypass it —
    // see explicit-wake-bypass.ts.
    const [action] = await db.insert(issueRecoveryActions).values({
      companyId, sourceIssueId: issue!.id, kind: "execution_reconciliation",
      status: "resolved", cause: "uncertain_provider_action", fingerprint: randomUUID(),
      evidence: { automaticRecovery: { replay: "blocked" } },
      nextAction: "Automatic recovery stopped.",
    }).returning();
    return { companyId, agentId, issueId: issue!.id, actionId: action!.id };
  }

  // The agent's own comment wake carries no user actor, so
  // admitExplicitNativeContinuation cannot admit it past the hold; it parks as
  // `deferred_issue_execution` instead of being lost.
  async function parkAgentComment(companyId: string, agentId: string, issueId: string) {
    const commentId = randomUUID();
    // The deferred comment is a real, agent-authored comment, as in production.
    await db.insert(issueComments).values({
      id: commentId, companyId, issueId, authorAgentId: agentId, authorType: "agent", body: "note from agent-a",
    });
    const result = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      requestedByActorType: "agent",
      requestedByActorId: agentId,
      payload: { issueId, commentId },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_commented", commentId },
    });
    expect(result).toBeNull();
    const [deferred] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(deferred?.status).toBe("deferred_issue_execution");
    return { commentId, deferredId: deferred!.id };
  }

  // A board reassignment: an explicit, person-authorized wake with no message
  // of its own. `requester` overrides who asked, to build the wakes that only
  // look the same.
  function assignmentWake(
    agentId: string,
    issueId: string,
    requester: { requestedByActorType?: "user" | "agent" | "system"; requestedByActorId?: string | null } = {
      requestedByActorType: "user",
      requestedByActorId: "user-a",
    },
  ) {
    return heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      ...requester,
      payload: { issueId },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
    });
  }

  async function waitForRunToFinish(runId: string, timeoutMs = RUN_WAIT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = await heartbeat.getRun(runId);
      if (run && !["queued", "running", "scheduled_retry"].includes(run.status)) return run;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return heartbeat.getRun(runId);
  }

  // Everything the company's runs do after the one under test has left
  // queued/running (follow-up wakes, finalization) has to land before the test
  // rewrites that run's state by hand.
  async function waitForCompanyIdle(companyId: string, timeoutMs = RUN_WAIT_MS) {
    const deadline = Date.now() + timeoutMs;
    let idlePolls = 0;
    while (Date.now() < deadline && idlePolls < 20) {
      const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
        .where(eq(heartbeatRuns.companyId, companyId));
      idlePolls = runs.some((run) => ["queued", "running", "scheduled_retry"].includes(run.status)) ? 0 : idlePolls + 1;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  // Attached to assertion messages so a CI failure names the cause (which run
  // was cancelled, why, and which recovery actions were still open) instead of
  // only the mismatched value.
  async function describeState(companyId: string, issueId: string) {
    const runs = await db.select({
      id: heartbeatRuns.id, status: heartbeatRuns.status, source: heartbeatRuns.invocationSource,
      errorCode: heartbeatRuns.errorCode, error: heartbeatRuns.error, retryOfRunId: heartbeatRuns.retryOfRunId,
    }).from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, companyId));
    const [issue] = await db.select({
      status: issues.status, assigneeAgentId: issues.assigneeAgentId,
      executionRunId: issues.executionRunId, checkoutRunId: issues.checkoutRunId,
    }).from(issues).where(eq(issues.id, issueId));
    return JSON.stringify({
      issue,
      runs,
      recoveryActions: actions.map((action) => ({
        id: action.id, kind: action.kind, status: action.status, cause: action.cause,
        replay: ((action.evidence.automaticRecovery ?? {}) as Record<string, unknown>).replay ?? null,
      })),
    });
  }

  // A run of the same agent waiting for its retry: it holds the issue's
  // execution lock and is not claimable until `scheduledRetryAt`, which is
  // far enough out that nothing picks it up while the test looks.
  async function seedScheduledRetry(companyId: string, agentId: string, issueId: string) {
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId, invocationSource: "automation", triggerDetail: "system",
      status: "scheduled_retry", scheduledRetryAttempt: 1, scheduledRetryReason: "transient_failure",
      scheduledRetryAt: new Date(Date.now() + 60 * 60_000),
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
    }).returning();
    await db.update(issues).set({
      executionRunId: run!.id, executionAgentNameKey: "agent-a", executionLockedAt: new Date(),
    }).where(eq(issues.id, issueId));
    return run!.id;
  }

  // The afterEach hook waits for every run to leave queued/running/
  // scheduled_retry; a seeded retry never would on its own.
  async function cancelRun(runId: string) {
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, runId));
  }

  async function holdOf(actionId: string) {
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, actionId));
    return action!;
  }

  it("does not lose a deferred agent comment: the successor run starts with it and the hold is retired", async () => {
    const { companyId, agentId, issueId, actionId } = await seed();
    const { commentId, deferredId } = await parkAgentComment(companyId, agentId, issueId);

    const run = await assignmentWake(agentId, issueId);

    expect(run).not.toBeNull();
    // The comment is not lost: the successor run adopted it.
    expect((run!.contextSnapshot as Record<string, unknown>).wakeCommentId).toBe(commentId);
    const [coalesced] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, deferredId));
    expect(coalesced!.status).toBe("coalesced");
    expect(coalesced!.runId).toBe(run!.id);

    // The hold is retired in the admission transaction itself, before the run
    // is ever claimed.
    const superseded = await holdOf(actionId);
    expect(superseded.status).toBe("resolved");
    const recovery = superseded.evidence.automaticRecovery as Record<string, unknown>;
    expect(recovery.replay).toBe("explicit_wake_superseded");
    expect(recovery.successorRunId).toBe(run!.id);

    // The run's own claim must let it through (before the fix it re-derived
    // "not explicit" from the adopted comment id and cancelled the run with
    // the receipt still pointing at it), and the adapter is really invoked.
    const finished = await waitForRunToFinish(run!.id);
    const state = await describeState(companyId, issueId);
    expect(finished?.status, state).not.toBe("cancelled");
    expect(finished?.errorCode, state).not.toBe("execution_reconciliation_required");
    expect(mockAdapterExecute.mock.calls.length, state).toBeGreaterThan(0);
    const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, deferredId));
    expect(receipt!.status).toBe("coalesced");
    expect(receipt!.runId).toBe(run!.id);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)))
      .not.toContainEqual(expect.objectContaining({ errorCode: "execution_reconciliation_required" }));
  }, TEST_TIMEOUT_MS);

  it("does not cancel the scheduled retry of the successor run: the superseded hold no longer blocks it", async () => {
    const { companyId, agentId, issueId, actionId } = await seed();
    const run = await assignmentWake(agentId, issueId);
    expect(run).not.toBeNull();
    expect((await holdOf(actionId)).evidence.automaticRecovery).toMatchObject({ replay: "explicit_wake_superseded" });
    const finished = await waitForRunToFinish(run!.id);
    expect(finished?.status, await describeState(companyId, issueId)).not.toBe("cancelled");
    await waitForCompanyIdle(companyId);

    // The successor then fails transiently before any provider work started.
    const now = new Date();
    await db.update(heartbeatRuns).set({
      status: "failed",
      error: "upstream overload",
      errorCode: "adapter_failed",
      finishedAt: now,
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
    }).where(eq(heartbeatRuns.id, run!.id));

    const scheduled = await heartbeat.scheduleBoundedRetry(run!.id, { now, random: () => 0 });
    expect(scheduled.outcome, await describeState(companyId, issueId)).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;
    // The retry may already have been promoted (and even run) by the time this
    // call looks, and the vendor's own follow-up retry of a finished run can
    // be the very run scheduleBoundedRetry hands back, so what this returns is
    // not asserted; it only makes sure a still-scheduled retry is handed to
    // the dispatcher.
    await heartbeat.promoteDueScheduledRetries(scheduled.dueAt);

    // The retry inherits the successor's context but not its authorization
    // (the record is bound to the successor's id); without the superseded
    // hold, the old one would cancel it at claim as
    // `execution_reconciliation_required`. The dispatcher's own claim decides,
    // so the outcome is read from the run once it has left queued/running.
    const retry = await waitForRunToFinish(scheduled.run.id);
    const state = await describeState(companyId, issueId);
    expect(retry?.errorCode, state).not.toBe("execution_reconciliation_required");
    expect(retry?.status, state).toBe("succeeded");
  }, TEST_TIMEOUT_MS);

  // A run of the same agent already waiting in the queue: not yet claimed, and
  // (a queued run takes the issue's execution lock only when claimed) not
  // stamped on the issue. The wake receipt it was created from is the durable
  // record of what asked for it.
  async function seedQueuedRun(companyId: string, agentId: string, issueId: string) {
    const [receipt] = await db.insert(agentWakeupRequests).values({
      companyId, agentId, source: "automation", triggerDetail: "system", reason: "issue_assigned",
      status: "queued", payload: { issueId },
    }).returning();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId, invocationSource: "automation", triggerDetail: "system", status: "queued",
      wakeupRequestId: receipt!.id,
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
    }).returning();
    await db.update(agentWakeupRequests).set({ runId: run!.id }).where(eq(agentWakeupRequests.id, receipt!.id));
    return { runId: run!.id, receiptId: receipt!.id };
  }

  async function runOf(runId: string) {
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    return run!;
  }

  // Round 3. The same agent already has a run waiting in the queue, and that
  // run's own claim would meet the settled hold and cancel it. So the wake
  // retires the waiting run (as its claim would, in the same transaction that
  // holds the issue lock) and creates a successor that supersedes the hold.
  it("cancels the same agent's queued run and starts the successor, when the wake is admitted only by the bypass", async () => {
    const { companyId, agentId, issueId, actionId } = await seed();
    const waiting = await seedQueuedRun(companyId, agentId, issueId);

    const run = await assignmentWake(agentId, issueId);

    const state = await describeState(companyId, issueId);
    expect(run, state).not.toBeNull();
    expect(run!.id, state).not.toBe(waiting.runId);

    // The waiting run is cancelled with exactly what its own claim would have
    // written, and its wake receipt is closed with it.
    const cancelled = await runOf(waiting.runId);
    expect(cancelled.status, state).toBe("cancelled");
    expect(cancelled.errorCode, state).toBe("execution_reconciliation_required");
    expect(cancelled.error, state).toBe("Automatic recovery stopped.");
    expect(cancelled.finishedAt, state).not.toBeNull();
    expect(cancelled.resultJson, state).toMatchObject({
      stopReason: "execution_reconciliation_required",
      executionWait: { issueId, recoveryActionId: actionId },
    });
    const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, waiting.receiptId));
    expect(receipt!.status, state).toBe("skipped");

    // The hold is retired for the successor only, in that same transaction.
    const recovery = (await holdOf(actionId)).evidence.automaticRecovery as Record<string, unknown>;
    expect(recovery.replay, state).toBe("explicit_wake_superseded");
    expect(recovery.successorRunId, state).toBe(run!.id);

    // A run that had not been retried carries no retry budget over.
    expect((run!.contextSnapshot as Record<string, unknown>).infraInterruptAttempt).toBeUndefined();

    // The successor is claimed and executed: it is not cancelled by the hold
    // that cancelled the run it replaces.
    const finished = await waitForRunToFinish(run!.id);
    const after = await describeState(companyId, issueId);
    expect(finished?.status, after).not.toBe("cancelled");
    expect(finished?.errorCode, after).not.toBe("execution_reconciliation_required");
    expect(mockAdapterExecute.mock.calls.length, after).toBeGreaterThan(0);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)))
      .filter((row) => row.errorCode === "execution_reconciliation_required").map((row) => row.id), after)
      .toEqual([waiting.runId]);
  }, TEST_TIMEOUT_MS);

  it("cancels the same agent's scheduled retry and starts the successor, keeping the retry budget it had used", async () => {
    const { companyId, agentId, issueId, actionId } = await seed();
    const retryRunId = await seedScheduledRetry(companyId, agentId, issueId);

    const run = await assignmentWake(agentId, issueId);

    const state = await describeState(companyId, issueId);
    expect(run, state).not.toBeNull();
    expect(run!.id, state).not.toBe(retryRunId);
    const cancelled = await runOf(retryRunId);
    expect(cancelled.status, state).toBe("cancelled");
    expect(cancelled.errorCode, state).toBe("execution_reconciliation_required");
    expect(cancelled.resultJson, state).toMatchObject({
      stopReason: "execution_reconciliation_required",
      executionWait: { issueId, recoveryActionId: actionId },
    });
    expect((await holdOf(actionId)).evidence.automaticRecovery, state)
      .toMatchObject({ replay: "explicit_wake_superseded", successorRunId: run!.id });

    // The retry it replaces had used one attempt (scheduledRetryAttempt 1). The
    // successor is a new row that starts at zero, so the count travels in its
    // context: a person's wake does not hand the issue a fresh budget.
    expect((run!.contextSnapshot as Record<string, unknown>).infraInterruptAttempt, state).toBe(1);

    const finished = await waitForRunToFinish(run!.id);
    await waitForCompanyIdle(companyId);
    const after = await describeState(companyId, issueId);
    expect(finished?.status, after).toBe("succeeded");
    // Cancelling the retry ends it: nothing schedules another one from it.
    const rows = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    expect(rows.filter((row) => row.status === "cancelled").map((row) => row.id), after).toEqual([retryRunId]);
    expect(rows.filter((row) => row.status === "scheduled_retry"), after).toHaveLength(0);
  }, TEST_TIMEOUT_MS);

  it("does not cancel the waiting run, nor supersede anything, while another hold on the issue is still open", async () => {
    // The bypass covers closed holds only. With a live hold next to the settled
    // one the wake is rejected before the waiting run is looked at, and neither
    // hold changes.
    const { companyId, agentId, issueId, actionId } = await seed();
    const [live] = await db.insert(issueRecoveryActions).values({
      companyId, sourceIssueId: issueId, kind: "execution_reconciliation",
      status: "active", cause: "uncertain_provider_action", fingerprint: randomUUID(),
      evidence: {}, nextAction: "Confirm what the provider did.",
    }).returning();
    const retryRunId = await seedScheduledRetry(companyId, agentId, issueId);
    try {
      expect(await assignmentWake(agentId, issueId)).toBeNull();

      const state = await describeState(companyId, issueId);
      expect((await runOf(retryRunId)).status, state).toBe("scheduled_retry");
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))), state)
        .toHaveLength(1);
      expect((await holdOf(live!.id)).status, state).toBe("active");
      const settled = await holdOf(actionId);
      expect(settled.status, state).toBe("resolved");
      expect((settled.evidence.automaticRecovery as Record<string, unknown>).replay, state).toBe("blocked");
      expect(mockAdapterExecute).not.toHaveBeenCalled();
    } finally {
      await cancelRun(retryRunId);
    }
  }, TEST_TIMEOUT_MS);

  it("with MYRMIDON_SETTLED_HOLDS_BLOCK_EXPLICIT_WAKES=1 the wake is deferred and the waiting run untouched, as in the vendor", async () => {
    const { companyId, agentId, issueId, actionId } = await seed();
    const retryRunId = await seedScheduledRetry(companyId, agentId, issueId);
    const saved = process.env.MYRMIDON_SETTLED_HOLDS_BLOCK_EXPLICIT_WAKES;
    process.env.MYRMIDON_SETTLED_HOLDS_BLOCK_EXPLICIT_WAKES = "1";
    try {
      expect(await assignmentWake(agentId, issueId)).toBeNull();

      const state = await describeState(companyId, issueId);
      expect((await runOf(retryRunId)).status, state).toBe("scheduled_retry");
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)), state).toHaveLength(1);
      const hold = await holdOf(actionId);
      expect(hold.status, state).toBe("resolved");
      expect((hold.evidence.automaticRecovery as Record<string, unknown>).replay, state).toBe("blocked");
      expect(mockAdapterExecute).not.toHaveBeenCalled();
    } finally {
      if (saved === undefined) delete process.env.MYRMIDON_SETTLED_HOLDS_BLOCK_EXPLICIT_WAKES;
      else process.env.MYRMIDON_SETTLED_HOLDS_BLOCK_EXPLICIT_WAKES = saved;
      await cancelRun(retryRunId);
    }
  }, TEST_TIMEOUT_MS);

  it("does not touch the same agent's scheduled retry for a wake the bypass does not admit (requested by a system actor)", async () => {
    const { companyId, agentId, issueId } = await seed();
    const retryRunId = await seedScheduledRetry(companyId, agentId, issueId);
    try {
      expect(await assignmentWake(agentId, issueId, { requestedByActorType: "system", requestedByActorId: "system-a" }))
        .toBeNull();
      const state = await describeState(companyId, issueId);
      expect((await runOf(retryRunId)).status, state).toBe("scheduled_retry");
    } finally {
      await cancelRun(retryRunId);
    }
  }, TEST_TIMEOUT_MS);

  // What `POST /agents/:id/wakeup` answers when the wake is rejected. With a
  // hold still open the wake is refused (nothing is created), and the answer
  // names the lock instead of the generic "already being executed" / "skipped".
  describe("POST /agents/:id/wakeup", () => {
    function wakeupApp(companyId: string) {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.actor = {
          type: "board", userId: "user-a", companyIds: [companyId],
          memberships: [{ companyId, membershipRole: "owner", status: "active" }],
          isInstanceAdmin: true, source: "local_implicit",
        };
        next();
      });
      app.use("/api", agentRoutes(db));
      app.use(errorHandler);
      return app;
    }

    it("names the hold that still blocks the wake, and changes nothing", async () => {
      const { companyId, agentId, issueId, actionId } = await seed();
      await db.update(issueRecoveryActions).set({ status: "active", evidence: {} })
        .where(eq(issueRecoveryActions.id, actionId));
      const retryRunId = await seedScheduledRetry(companyId, agentId, issueId);
      try {
        const res = await request(wakeupApp(companyId)).post(`/api/agents/${agentId}/wakeup`)
          .send({ payload: { issueId } });

        const state = await describeState(companyId, issueId);
        expect(res.status, state).toBe(202);
        expect(res.body, state).toMatchObject({
          status: "skipped",
          reason: "execution_reconciliation_required",
          message: "Automatic recovery stopped.",
          issueId,
        });
        expect((await runOf(retryRunId)).status, state).toBe("scheduled_retry");
        expect((await holdOf(actionId)).status, state).toBe("active");
        expect(mockAdapterExecute).not.toHaveBeenCalled();
      } finally {
        await cancelRun(retryRunId);
      }
    }, TEST_TIMEOUT_MS);

    it("creates the run when the only hold is a closed one and the waiting run is the agent's own", async () => {
      // The counterpart: the same request against a settled hold is not a
      // rejection at all.
      const { companyId, agentId, issueId, actionId } = await seed();
      const retryRunId = await seedScheduledRetry(companyId, agentId, issueId);

      const res = await request(wakeupApp(companyId)).post(`/api/agents/${agentId}/wakeup`)
        .send({ payload: { issueId } });

      const state = await describeState(companyId, issueId);
      expect(res.status, state).toBe(202);
      expect(res.body.status, state).not.toBe("skipped");
      expect(res.body.id, state).toEqual(expect.any(String));
      expect(res.body.id, state).not.toBe(retryRunId);
      expect((await runOf(retryRunId)).errorCode, state).toBe("execution_reconciliation_required");
      expect((await holdOf(actionId)).evidence.automaticRecovery, state)
        .toMatchObject({ replay: "explicit_wake_superseded", successorRunId: res.body.id });
      await waitForRunToFinish(res.body.id);
    }, TEST_TIMEOUT_MS);
  });

  it.each([
    ["system", { requestedByActorType: "system", requestedByActorId: "system-a" }],
    ["agent", { requestedByActorType: "agent", requestedByActorId: "agent-a" }],
    ["user without an identifiable person", { requestedByActorType: "user", requestedByActorId: null }],
  ] as const)(
    "a wake requested by %s does not pass the hold, whatever its reason, and leaves the deferred comment parked",
    async (_label, requester) => {
      const { companyId, agentId, issueId, actionId } = await seed();
      const { deferredId } = await parkAgentComment(companyId, agentId, issueId);

      // An unattended sweep reassigns and wakes with exactly this shape.
      expect(await assignmentWake(agentId, issueId, requester)).toBeNull();

      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(0);
      expect(mockAdapterExecute).not.toHaveBeenCalled();
      const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, deferredId));
      expect(receipt!.status).toBe("deferred_issue_execution");
      const hold = await holdOf(actionId);
      expect(hold.status).toBe("resolved");
      expect((hold.evidence.automaticRecovery as Record<string, unknown>).replay).toBe("blocked");
    },
  );
});
