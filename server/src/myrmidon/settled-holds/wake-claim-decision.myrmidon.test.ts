// myrmidon(L2, round 1 fix): claim-time regression tests. A queued run's own
// first claim (`cancelStaleQueuedRun`, run-dispatch/adapters/postgres.ts)
// must read the "may this wake pass a settled hold" decision its admission
// recorded on the run — it must not re-derive it from the run row and a
// context the admission transaction itself has since mutated, and it must
// never let a run that merely inherited a context (a scheduled retry) or a
// non-person requester borrow the authorization. See
// wake-admission-context.ts and docs/myrmidon/DIVERGENCE.md "L2".
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
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { createPostgresRunDispatchAdapter } from "../../modules/run-dispatch/adapters/postgres.js";
import { recordSettledHoldWakeContext } from "./wake-admission-context.js";
import type { WakeClassificationInput } from "./wake-classification.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// What a board reassignment wake records at admission: an explicit,
// person-authorized wake that carries no message of its own.
const USER_ASSIGNMENT_WAKE: WakeClassificationInput = {
  source: "assignment",
  triggerDetail: "system",
  reason: "issue_assigned",
  commentId: null,
  requestedByActorType: "user",
};

describeEmbeddedPostgres("run claim reads the recorded settled-hold wake decision (L2, round 1)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-wake-claim-decision-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueRecoveryActions);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "user-a",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "agent-a",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "task",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    // A settled ("do not replay") hold that names no run: nothing further to
    // verify, so a person-authorized wake may pass it (explicit-wake-bypass.ts).
    await db.insert(issueRecoveryActions).values({
      companyId,
      sourceIssueId: issueId,
      kind: "execution_reconciliation",
      status: "resolved",
      cause: "uncertain_provider_action",
      fingerprint: randomUUID(),
      evidence: { automaticRecovery: { replay: "blocked" } },
      nextAction: "Automatic recovery stopped.",
    });
    return { companyId, agentId, issueId };
  }

  async function seedRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    invocationSource?: string;
    /** Records this classification on the run, bound to `recordedFor` (default: the run itself). */
    record?: WakeClassificationInput;
    recordedFor?: string;
    /** Context keys a same-transaction comment adoption adds after admission decided. */
    adoptedCommentId?: string;
    wakeReason?: string;
  }) {
    const runId = randomUUID();
    const contextSnapshot: Record<string, unknown> = {
      issueId: input.issueId,
      taskId: input.issueId,
      wakeReason: input.wakeReason ?? "issue_assigned",
    };
    if (input.record) {
      recordSettledHoldWakeContext(contextSnapshot, input.record, input.recordedFor ?? runId);
    }
    if (input.adoptedCommentId) {
      contextSnapshot.wakeCommentId = input.adoptedCommentId;
      contextSnapshot.commentId = input.adoptedCommentId;
    }
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: input.invocationSource ?? "assignment",
      triggerDetail: "system",
      status: "queued",
      contextSnapshot,
    });
    return runId;
  }

  async function claim(companyId: string, runId: string) {
    return createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({
      runId,
      companyId,
      expectedStatus: "queued",
      now: new Date(),
    });
  }

  async function runStatus(runId: string) {
    return db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]);
  }

  it("keeps a person-authorized run whose admission adopted a deferred comment into its own context", async () => {
    // The regression: the record says "no comment" (what the wake itself
    // carried), while the run's context now carries the adopted comment id.
    // Re-deriving at claim read that comment id, called the wake
    // "not explicit", and cancelled the run with the wake lost.
    const { companyId, agentId, issueId } = await seed();
    const runId = await seedRun({
      companyId, agentId, issueId,
      record: USER_ASSIGNMENT_WAKE,
      adoptedCommentId: randomUUID(),
    });

    expect(await claim(companyId, runId)).toMatchObject({ outcome: "not_stale" });
    expect(await runStatus(runId)).toEqual({ status: "queued", errorCode: null });
  });

  it("cancels the same run when nothing was recorded for it, however explicit its shape looks", async () => {
    const { companyId, agentId, issueId } = await seed();
    const runId = await seedRun({ companyId, agentId, issueId });

    expect(await claim(companyId, runId)).toMatchObject({
      outcome: "cancelled", errorCode: "execution_reconciliation_required",
    });
  });

  it("does not let a run inherit the decision recorded for its predecessor", async () => {
    // A scheduled retry spreads the failed run's context wholesale, record
    // included; it is a replay of that run and must meet the hold again.
    const { companyId, agentId, issueId } = await seed();
    const runId = await seedRun({
      companyId, agentId, issueId,
      record: USER_ASSIGNMENT_WAKE,
      recordedFor: randomUUID(),
    });

    expect(await claim(companyId, runId)).toMatchObject({
      outcome: "cancelled", errorCode: "execution_reconciliation_required",
    });
    expect((await runStatus(runId))?.status).toBe("cancelled");
  });

  it.each(["system", "agent", null] as const)(
    "does not pass the hold for a wake requested by %s, whatever its reason",
    async (requestedByActorType) => {
      const { companyId, agentId, issueId } = await seed();
      const runId = await seedRun({
        companyId, agentId, issueId,
        record: { ...USER_ASSIGNMENT_WAKE, requestedByActorType },
      });

      expect(await claim(companyId, runId)).toMatchObject({
        outcome: "cancelled", errorCode: "execution_reconciliation_required",
      });
    },
  );
});
