// myrmidon(L2): getExecutionBlocker with `explicitWake` — see execution-blocker.ts
// (point of call) and explicit-wake-bypass.ts.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, companies, createDb, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { getExecutionBlocker } from "../../services/execution-blocker.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("getExecutionBlocker explicitWake (L2)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-settled-holds-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(runStatus: string = "failed") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: `H${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "user-a",
      requireBoardApprovalForNewAgents: false,
    });
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId, companyId, name: "agent-a", role: "engineer", status: "idle",
      adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    const [issue] = await db.insert(issues).values({
      companyId, title: "held", status: "blocked", priority: "medium", assigneeAgentId: agentId,
    }).returning();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId, invocationSource: "assignment", triggerDetail: "system",
      status: runStatus, runtimeMode: "native", nativeIssueId: issue!.id,
      contextSnapshot: { issueId: issue!.id },
    }).returning();
    return { companyId, agentId, issueId: issue!.id, runId: run!.id };
  }

  async function seedAction(input: {
    companyId: string; issueId: string; runId?: string | null;
    status: "active" | "resolved" | "escalated"; replay?: string;
  }) {
    await db.insert(issueRecoveryActions).values({
      companyId: input.companyId, sourceIssueId: input.issueId, kind: "execution_reconciliation",
      status: input.status, cause: "uncertain_provider_action", fingerprint: randomUUID(),
      evidence: {
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.replay ? { automaticRecovery: { replay: input.replay } } : {}),
      },
      nextAction: "Automatic recovery stopped.",
    });
  }

  async function seedCoordinator(input: {
    companyId: string; issueId: string; runId: string;
    phase?: string; leaseOwner?: string | null; resultId?: string | null;
    successorRunId?: string;
  }) {
    await db.insert(nativeRunFinalizations).values({
      runId: input.runId, companyId: input.companyId, issueId: input.issueId,
      phase: input.phase ?? "terminal_failure",
      leaseOwner: input.leaseOwner ?? null,
      resultId: input.resultId ?? null,
      failureDetail: input.successorRunId ? { successorRunId: input.successorRunId } : {},
    });
  }

  it("bypasses a settled no-replay hold for an explicit wake when it names no run to verify", async () => {
    const { companyId, issueId } = await seed();
    // No evidence.runId/sourceRunId: nothing to verify has actually stopped,
    // so an explicit wake may go straight through.
    await seedAction({ companyId, issueId, status: "resolved", replay: "blocked" });

    expect(await getExecutionBlocker(db, companyId, issueId)).not.toBeNull();
    expect(await getExecutionBlocker(db, companyId, issueId, { explicitWake: false })).not.toBeNull();
    expect(await getExecutionBlocker(db, companyId, issueId, { explicitWake: true })).toBeNull();
  });

  it("bypasses a settled no-replay hold for an explicit wake once the named run's coordinator has released it", async () => {
    const { companyId, issueId, runId } = await seed();
    await seedAction({ companyId, issueId, runId, status: "resolved", replay: "blocked" });
    // Same state settleUnrecoverableExecutions itself requires before ever
    // writing this disposition: terminal_failure, no lease owner, no
    // result, no successor.
    await seedCoordinator({ companyId, issueId, runId });

    expect(await getExecutionBlocker(db, companyId, issueId)).not.toBeNull();
    expect(await getExecutionBlocker(db, companyId, issueId, { explicitWake: false })).not.toBeNull();
    expect(await getExecutionBlocker(db, companyId, issueId, { explicitWake: true })).toBeNull();
  });

  it("bypasses a settled no-replay hold for an explicit wake on a terminal run with no coordinator row", async () => {
    const { companyId, issueId, runId } = await seed();
    // No nativeRunFinalizations row at all (e.g. legacy runtime, or a
    // native run this reconciler never tracked): the run's own terminal
    // status is all there is to verify.
    await seedAction({ companyId, issueId, runId, status: "resolved", replay: "blocked" });

    expect(await getExecutionBlocker(db, companyId, issueId, { explicitWake: true })).toBeNull();
  });

  it("bypasses a settled no-replay hold for an explicit wake when the named run row is gone", async () => {
    const { companyId, issueId } = await seed();
    await seedAction({ companyId, issueId, runId: randomUUID(), status: "resolved", replay: "blocked" });

    expect(await getExecutionBlocker(db, companyId, issueId, { explicitWake: true })).toBeNull();
  });

  it("keeps blocking an explicit wake while the named run's coordinator still holds an active lease", async () => {
    const { companyId, issueId, runId } = await seed();
    await seedAction({ companyId, issueId, runId, status: "resolved", replay: "blocked" });
    await seedCoordinator({ companyId, issueId, runId, leaseOwner: "runner-1:resume:abc" });

    const blocked = await getExecutionBlocker(db, companyId, issueId, { explicitWake: true });
    expect(blocked).not.toBeNull();
    expect(blocked!.runId).toBe(runId);
  });

  it("keeps blocking an explicit wake while the named run's coordinator recorded a successor run", async () => {
    const { companyId, issueId, runId } = await seed();
    await seedAction({ companyId, issueId, runId, status: "resolved", replay: "blocked" });
    await seedCoordinator({ companyId, issueId, runId, successorRunId: randomUUID() });

    expect(await getExecutionBlocker(db, companyId, issueId, { explicitWake: true })).not.toBeNull();
  });

  it("keeps blocking an explicit wake while the named run's coordinator has not reached terminal_failure", async () => {
    const { companyId, issueId, runId } = await seed();
    await seedAction({ companyId, issueId, runId, status: "resolved", replay: "blocked" });
    await seedCoordinator({ companyId, issueId, runId, phase: "retryable_failure" });

    expect(await getExecutionBlocker(db, companyId, issueId, { explicitWake: true })).not.toBeNull();
  });

  it("keeps blocking an explicit wake while the named run itself has not reached a terminal status", async () => {
    const { companyId, issueId, runId } = await seed("running");
    await seedAction({ companyId, issueId, runId, status: "resolved", replay: "blocked" });

    expect(await getExecutionBlocker(db, companyId, issueId, { explicitWake: true })).not.toBeNull();
  });

  it("still blocks an explicit wake on a genuinely active (unsettled) recovery action", async () => {
    const { companyId, issueId, runId } = await seed();
    await seedAction({ companyId, issueId, runId, status: "active" });
    await seedCoordinator({ companyId, issueId, runId });

    const blocked = await getExecutionBlocker(db, companyId, issueId, { explicitWake: true });
    expect(blocked).not.toBeNull();
    expect(blocked!.recoveryActionId).not.toBeNull();
  });

  it("still blocks an explicit wake on an escalated recovery action", async () => {
    const { companyId, issueId, runId } = await seed();
    await seedAction({ companyId, issueId, runId, status: "escalated" });
    await seedCoordinator({ companyId, issueId, runId });

    expect(await getExecutionBlocker(db, companyId, issueId, { explicitWake: true })).not.toBeNull();
  });

  it("does not block anything once the recovery action is settled without a no-replay disposition", async () => {
    const { companyId, issueId, runId } = await seed();
    await seedAction({ companyId, issueId, runId, status: "resolved" });

    expect(await getExecutionBlocker(db, companyId, issueId)).toBeNull();
    expect(await getExecutionBlocker(db, companyId, issueId, { explicitWake: true })).toBeNull();
  });
});
