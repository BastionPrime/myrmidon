// myrmidon(L2, round 2 fix): claim-time regression tests. A queued run's own
// first claim (`cancelStaleQueuedRun`, run-dispatch/adapters/postgres.ts) is
// the plain vendor check: it never re-derives whether the wake was "explicit"
// and grants no bypass of its own. The only thing that lets an explicit
// wake's run through is that its admission superseded the hold in the same
// transaction (supersede-explicit-wake.ts); a hold the admission did not
// supersede (one that appeared afterwards, one it could not verify) still
// blocks the claim, so it can never be passed by a decision made earlier.
// See docs/myrmidon/DIVERGENCE.md "L2".
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
import { supersedeExplicitWakeSettledHold } from "./supersede-explicit-wake.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("run claim meets the vendor hold check (L2, round 2)", () => {
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
    /** Context keys a same-transaction comment adoption adds after admission decided. */
    adoptedCommentId?: string;
    wakeReason?: string;
    id?: string;
  }) {
    const runId = input.id ?? randomUUID();
    const contextSnapshot: Record<string, unknown> = {
      issueId: input.issueId,
      taskId: input.issueId,
      wakeReason: input.wakeReason ?? "issue_assigned",
    };
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

  /** The admission step: supersede the holds the wake verified, for this successor run. */
  async function supersedeAtAdmission(input: { companyId: string; issueId: string; successorRunId: string }) {
    return supersedeExplicitWakeSettledHold({
      db, companyId: input.companyId, issueId: input.issueId, successorRunId: input.successorRunId,
      requestedByActorType: "user", requestedByActorId: "user-a",
    });
  }

  /** A settled no-replay hold, optionally naming the run it was written for. */
  async function seedHold(companyId: string, issueId: string, runId?: string) {
    await db.insert(issueRecoveryActions).values({
      companyId,
      sourceIssueId: issueId,
      kind: "execution_reconciliation",
      status: "resolved",
      cause: "uncertain_provider_action",
      fingerprint: randomUUID(),
      evidence: { ...(runId ? { runId } : {}), automaticRecovery: { replay: "blocked" } },
      nextAction: "Automatic recovery stopped.",
    });
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

  it("keeps a person-authorized run whose admission superseded the hold and adopted a deferred comment", async () => {
    // The wake's own admission resolved the hold under its successor run id;
    // the run's context now also carries a comment the same transaction
    // adopted. The claim runs the plain vendor check, finds no hold, and the
    // run starts: nothing about the comment can turn the wake "not explicit"
    // at claim, because the claim decides nothing about explicitness.
    const { companyId, agentId, issueId } = await seed();
    const runId = randomUUID();
    expect(await supersedeAtAdmission({ companyId, issueId, successorRunId: runId })).not.toBeNull();
    await seedRun({ companyId, agentId, issueId, id: runId, adoptedCommentId: randomUUID() });

    expect(await claim(companyId, runId)).toMatchObject({ outcome: "not_stale" });
    expect(await runStatus(runId)).toEqual({ status: "queued", errorCode: null });
  });

  it("cancels a run when a hold appeared after its admission superseded the earlier one", async () => {
    // Admission superseded what it verified at that moment. A hold written
    // afterwards (a stop reconciled between admission and claim) was never
    // verified by anyone for this wake and must stop the claim.
    const { companyId, agentId, issueId } = await seed();
    const runId = randomUUID();
    await supersedeAtAdmission({ companyId, issueId, successorRunId: runId });
    await seedRun({ companyId, agentId, issueId, id: runId });
    await seedHold(companyId, issueId);

    expect(await claim(companyId, runId)).toMatchObject({
      outcome: "cancelled", errorCode: "execution_reconciliation_required",
    });
    expect((await runStatus(runId))?.status).toBe("cancelled");
  });

  it("cancels a run when admission left a hold standing that it could not verify", async () => {
    // A hold naming a run that is still executing is not bypassable, so
    // admission does not supersede it (the wake is deferred there instead).
    // Whatever else was superseded beside it, the claim must still meet it.
    const { companyId, agentId, issueId } = await seed();
    const stillRunning = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: stillRunning, companyId, agentId, invocationSource: "assignment", triggerDetail: "system",
      status: "running", contextSnapshot: { issueId },
    });
    await seedHold(companyId, issueId, stillRunning);
    const runId = randomUUID();
    await supersedeAtAdmission({ companyId, issueId, successorRunId: runId });
    await seedRun({ companyId, agentId, issueId, id: runId });

    expect(await claim(companyId, runId)).toMatchObject({
      outcome: "cancelled", errorCode: "execution_reconciliation_required",
    });
  });

  it("cancels a run that nothing superseded a hold for, however explicit its shape looks", async () => {
    const { companyId, agentId, issueId } = await seed();
    const runId = await seedRun({ companyId, agentId, issueId });

    expect(await claim(companyId, runId)).toMatchObject({
      outcome: "cancelled", errorCode: "execution_reconciliation_required",
    });
  });
});
