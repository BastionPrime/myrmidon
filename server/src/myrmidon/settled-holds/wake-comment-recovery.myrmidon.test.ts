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
  agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issueRecoveryActions, issues,
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

import { heartbeatService } from "../../services/heartbeat.ts";
import { createPostgresRunDispatchAdapter } from "../../modules/run-dispatch/adapters/postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

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
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      if (!runs.some((run) => run.status === "queued" || run.status === "running")) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    mockAdapterExecute.mockClear();
  });

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
  async function parkAgentComment(agentId: string, issueId: string) {
    const commentId = randomUUID();
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

  async function waitForRunToFinish(runId: string, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = await heartbeat.getRun(runId);
      if (run && !["queued", "running"].includes(run.status)) return run;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return heartbeat.getRun(runId);
  }

  async function holdOf(actionId: string) {
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, actionId));
    return action!;
  }

  it("does not lose a deferred agent comment: the successor run starts with it and the hold is retired", async () => {
    const { companyId, agentId, issueId, actionId } = await seed();
    const { commentId, deferredId } = await parkAgentComment(agentId, issueId);

    const run = await assignmentWake(agentId, issueId);

    expect(run).not.toBeNull();
    // The comment is not lost: the successor run adopted it.
    expect((run!.contextSnapshot as Record<string, unknown>).wakeCommentId).toBe(commentId);
    const [coalesced] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, deferredId));
    expect(coalesced!.status).toBe("coalesced");
    expect(coalesced!.runId).toBe(run!.id);

    // The run's own claim must let it through (before the fix it re-derived
    // "not explicit" from the adopted comment id and cancelled the run with
    // the receipt still pointing at it). The adapter is really invoked.
    await expect.poll(() => mockAdapterExecute.mock.calls.length, { timeout: 10_000, interval: 50 })
      .toBeGreaterThan(0);
    const finished = await waitForRunToFinish(run!.id);
    expect(finished?.status).not.toBe("cancelled");
    expect(finished?.errorCode).not.toBe("execution_reconciliation_required");
    const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, deferredId));
    expect(receipt!.status).toBe("coalesced");
    expect(receipt!.runId).toBe(run!.id);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)))
      .not.toContainEqual(expect.objectContaining({ errorCode: "execution_reconciliation_required" }));

    // The hold itself is retired, not merely bypassed once more.
    const superseded = await holdOf(actionId);
    expect(superseded.status).toBe("resolved");
    const recovery = superseded.evidence.automaticRecovery as Record<string, unknown>;
    expect(recovery.replay).toBe("explicit_wake_superseded");
    expect(recovery.successorRunId).toBe(run!.id);
  });

  it("does not cancel the scheduled retry of the successor run: the superseded hold no longer blocks it", async () => {
    const { companyId, agentId, issueId } = await seed();
    const run = await assignmentWake(agentId, issueId);
    expect(run).not.toBeNull();
    const finished = await waitForRunToFinish(run!.id);
    expect(finished?.status).not.toBe("cancelled");

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
    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;
    const promotion = await heartbeat.promoteDueScheduledRetries(scheduled.dueAt);
    expect(promotion.runIds).toContain(scheduled.run.id);

    // The retry inherits the successor's context but not its authorization
    // (the record is bound to the successor's id); without the superseded
    // hold, the old one would cancel it here as
    // `execution_reconciliation_required`.
    const outcome = await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({
      companyId, runId: scheduled.run.id, expectedStatus: "queued", now: scheduled.dueAt,
    });
    expect(["not_stale", "lost_race"]).toContain(outcome.outcome);
    const retry = await heartbeat.getRun(scheduled.run.id);
    expect(retry?.status).not.toBe("cancelled");
    expect(retry?.errorCode).not.toBe("execution_reconciliation_required");
  });

  it.each([
    ["system", { requestedByActorType: "system", requestedByActorId: "system-a" }],
    ["agent", { requestedByActorType: "agent", requestedByActorId: "agent-a" }],
    ["user without an identifiable person", { requestedByActorType: "user", requestedByActorId: null }],
  ] as const)(
    "a wake requested by %s does not pass the hold, whatever its reason, and leaves the deferred comment parked",
    async (_label, requester) => {
      const { companyId, agentId, issueId, actionId } = await seed();
      const { deferredId } = await parkAgentComment(agentId, issueId);

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
