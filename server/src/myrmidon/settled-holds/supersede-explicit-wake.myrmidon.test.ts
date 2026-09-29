// myrmidon(L2, round 1 fix): supersedeExplicitWakeSettledHold — see
// supersede-explicit-wake.ts.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog, agents, companies, createDb, heartbeatRuns, issueRecoveryActions, issues,
  nativeRunFinalizations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { getExecutionBlocker } from "../../services/execution-blocker.js";
import { supersedeExplicitWakeSettledHold } from "./supersede-explicit-wake.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("supersedeExplicitWakeSettledHold (L2, round 1)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-settled-holds-supersede-");
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
    const [action] = await db.insert(issueRecoveryActions).values({
      companyId: input.companyId, sourceIssueId: input.issueId, kind: "execution_reconciliation",
      status: input.status, cause: "uncertain_provider_action", fingerprint: randomUUID(),
      evidence: {
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.replay ? { automaticRecovery: { replay: input.replay } } : {}),
      },
      nextAction: "Automatic recovery stopped.",
    }).returning();
    return action!;
  }

  it("resolves a settled hold it verifies has released its named run's claim, recording the successor", async () => {
    const { companyId, issueId, runId } = await seed();
    // No coordinator row: a terminal run with no coordinator has nothing
    // further to verify, same as getExecutionBlocker's own bypass check.
    const action = await seedAction({ companyId, issueId, runId, status: "resolved", replay: "blocked" });
    const successorRunId = randomUUID();

    const result = await supersedeExplicitWakeSettledHold({
      db, companyId, issueId, successorRunId,
      requestedByActorType: "user", requestedByActorId: "user-a",
    });

    expect(result?.recoveryActionIds).toEqual([action.id]);
    const [updated] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
    expect(updated!.status).toBe("resolved");
    expect((updated!.evidence.automaticRecovery as Record<string, unknown>).replay).toBe("explicit_wake_superseded");
    expect((updated!.evidence.automaticRecovery as Record<string, unknown>).successorRunId).toBe(successorRunId);
    expect((updated!.evidence.explicitWakeSuperseded as Record<string, unknown>).successorRunId).toBe(successorRunId);

    // Once superseded, the hold no longer blocks anything at all — not even
    // a plain, non-bypassed check (the whole point: subsequent automatic
    // continuations no longer need to reclassify as "explicit" to proceed).
    expect(await getExecutionBlocker(db, companyId, issueId)).toBeNull();

    const [logged] = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
    expect(logged?.action).toBe("issue.execution_recovery_settled");
  });

  it("leaves a genuinely still-open (active) recovery action untouched", async () => {
    const { companyId, issueId, runId } = await seed();
    const action = await seedAction({ companyId, issueId, runId, status: "active" });

    const result = await supersedeExplicitWakeSettledHold({
      db, companyId, issueId, successorRunId: randomUUID(),
      requestedByActorType: "user", requestedByActorId: "user-a",
    });

    expect(result).toBeNull();
    const [untouched] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
    expect(untouched!.status).toBe("active");
  });

  it("leaves a settled hold whose named run has not actually released its claim untouched", async () => {
    const { companyId, issueId, runId } = await seed();
    await seedAction({ companyId, issueId, runId, status: "resolved", replay: "blocked" });
    await db.insert(nativeRunFinalizations).values({
      runId, companyId, issueId, phase: "terminal_failure", leaseOwner: "runner-1:resume:abc",
    });

    const result = await supersedeExplicitWakeSettledHold({
      db, companyId, issueId, successorRunId: randomUUID(),
      requestedByActorType: "user", requestedByActorId: "user-a",
    });

    expect(result).toBeNull();
    expect(await getExecutionBlocker(db, companyId, issueId, { explicitWake: true })).not.toBeNull();
  });

  it("is a no-op when there is nothing matching a settled hold for the issue", async () => {
    const { companyId, issueId } = await seed();

    expect(await supersedeExplicitWakeSettledHold({
      db, companyId, issueId, successorRunId: randomUUID(),
      requestedByActorType: "user", requestedByActorId: "user-a",
    })).toBeNull();
  });
});
