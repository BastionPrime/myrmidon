// myrmidon(L2, round 1 fix): end-to-end regressions for the defects senior
// review found in round 1, run through the real admission
// (heartbeat.ts's enqueueWakeup), claim (run-dispatch/adapters/postgres.ts)
// and retry scheduling:
//  - an explicit wake with no message of its own (here: reassignment) used to
//    adopt a deferred agent comment and then lose it, because admission and
//    the successor run's own first claim classified "explicit" from
//    different (and, for the claim, mutated) data;
//  - the hold it bypassed kept blocking every automatic continuation of the
//    successor (a scheduled retry here), so the hold is now superseded
//    atomically with the successor;
//  - a wake requested by anything but a person never bypasses a hold, even
//    when its reason/source shape is an explicit wake's.
// See supersede-explicit-wake.ts and wake-admission-context.ts.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
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

import { heartbeatService } from "../../services/heartbeat.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// The first run in a fresh test process loads most of the server lazily and can
// take well over ten seconds on a loaded CI worker, so waits are generous and
// only ever cost time when something is actually wrong.
const RUN_WAIT_MS = 60_000;
const TEST_TIMEOUT_MS = 120_000;

describeEmbeddedPostgres("explicit wake past a settled hold recovers a deferred comment (L2, round 1)", () => {
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
