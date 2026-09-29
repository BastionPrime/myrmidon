// myrmidon(L1): a stranded assigned issue whose agent is merely paused by
// infrastructure (not failed provider work) is not escalated to the board
// while the shared infra-interrupt retry budget still allows it -- and the
// stranded run's own claimed adapter can safely take a blind retry (a
// conversation adapter, or one with its own idempotency key; see
// infra-interrupts.ts's module comment). A non-conversation adapter
// (process, http, openclaw_gateway, …) or an unclaimed one still escalates,
// same as the vendor, regardless of the retry budget.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { heartbeatService } from "../heartbeat.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("reconcileStrandedAssignedIssues: infrastructure interruptions (L1)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-infra-interrupts-stranded-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedStrandedIssue(input: {
    errorCode: string | null;
    scheduledRetryAttempt?: number;
    scheduledRetryReason?: string | null;
    contextSnapshotExtra?: Record<string, unknown>;
    // myrmidon(L1): the run's claimed adapter (runnerProfileJson.adapterDispatch).
    // Defaults to the conversation adapter the seeded agent itself uses
    // (codex_local) so existing callers keep exercising the intended
    // positive path; pass a non-conversation adapter (or null) to exercise
    // the gate that keeps the vendor's escalation in place for those.
    adapterType?: string | null;
    // myrmidon(L1): the run's persisted resultJson, e.g. an
    // executionCancellation state the provider stop left behind.
    resultJson?: Record<string, unknown> | null;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const now = new Date();

    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: `W${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "user-a",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "agent-a",
      role: "engineer",
      status: "paused",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "in progress when the agent paused",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "user-a",
      createdAt: new Date(now.getTime() - 60 * 60 * 1000),
    });
    const claimedAdapterType = input.adapterType === undefined ? "codex_local" : input.adapterType;
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "cancelled",
      contextSnapshot: { issueId, ...input.contextSnapshotExtra },
      errorCode: input.errorCode,
      scheduledRetryAttempt: input.scheduledRetryAttempt ?? 0,
      scheduledRetryReason: input.scheduledRetryReason ?? null,
      runnerProfileJson: claimedAdapterType === null ? null : { adapterDispatch: { adapterType: claimedAdapterType } },
      resultJson: input.resultJson ?? null,
      finishedAt: now,
      updatedAt: now,
    });
    return { companyId, agentId, issueId, runId };
  }

  async function activeRecoveryActionsFor(issueId: string) {
    return db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
  }

  it("does not escalate while the agent is only paused and the retry budget is not exhausted", async () => {
    const { issueId } = await seedStrandedIssue({ errorCode: "agent_paused", scheduledRetryAttempt: 0 });

    await heartbeatService(db).reconcileStrandedAssignedIssues();

    expect(await activeRecoveryActionsFor(issueId)).toHaveLength(0);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue!.status).toBe("in_progress");
  }, 30_000);

  it("still escalates to the board once the shared infra-interrupt retry budget is exhausted", async () => {
    const { issueId } = await seedStrandedIssue({ errorCode: "agent_paused", scheduledRetryAttempt: 2 });

    await heartbeatService(db).reconcileStrandedAssignedIssues();

    const actions = await activeRecoveryActionsFor(issueId);
    expect(actions.length).toBeGreaterThan(0);
    expect(actions[0]!.ownerType).toBe("board");
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue!.status).toBe("blocked");
  }, 30_000);

  it("still escalates a paused agent's stranded issue when the run failed for a non-infrastructure reason", async () => {
    const { issueId } = await seedStrandedIssue({ errorCode: "adapter_failed", scheduledRetryAttempt: 0 });

    await heartbeatService(db).reconcileStrandedAssignedIssues();

    expect((await activeRecoveryActionsFor(issueId)).length).toBeGreaterThan(0);
  }, 30_000);

  // Regression: the raw scheduledRetryAttempt column runs ahead of the
  // budget executionFailureRetryCount actually reports for a
  // workspace_busy-retried run (it counts contextSnapshot's preserved
  // failureRetriesBeforeWorkspaceWait instead, see execution-recovery-attempt.ts).
  // The retry-budget read here must use the same full run shape or this
  // sweep would disagree with legacyExecutionNeedsReconciliation about
  // whether the shared budget is exhausted.
  it("does not escalate a workspace_busy-retried run whose raw attempt column outruns its preserved failure count", async () => {
    const { issueId } = await seedStrandedIssue({
      errorCode: "agent_paused",
      scheduledRetryAttempt: 5,
      scheduledRetryReason: "workspace_busy",
      contextSnapshotExtra: { failureRetriesBeforeWorkspaceWait: 0 },
    });

    await heartbeatService(db).reconcileStrandedAssignedIssues();

    expect(await activeRecoveryActionsFor(issueId)).toHaveLength(0);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue!.status).toBe("in_progress");
  }, 30_000);

  it("still escalates a workspace_busy-retried run once its preserved failure count exhausts the budget", async () => {
    const { issueId } = await seedStrandedIssue({
      errorCode: "agent_paused",
      scheduledRetryAttempt: 0,
      scheduledRetryReason: "workspace_busy",
      contextSnapshotExtra: { failureRetriesBeforeWorkspaceWait: 2 },
    });

    await heartbeatService(db).reconcileStrandedAssignedIssues();

    const actions = await activeRecoveryActionsFor(issueId);
    expect(actions.length).toBeGreaterThan(0);
    expect(actions[0]!.ownerType).toBe("board");
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue!.status).toBe("blocked");
  }, 30_000);

  // Senior review, round 1: a process/webhook-style adapter is exactly what
  // the vendor's own CONVERSATION_ADAPTER_TYPES exception protects against a
  // blind retry -- so a paused stranded issue on one of those still
  // escalates to the board, even though the retry budget is not exhausted.
  it("still escalates while paused and within budget when the stranded run's adapter is not a conversation adapter (openclaw_gateway)", async () => {
    const { issueId } = await seedStrandedIssue({
      errorCode: "agent_paused",
      scheduledRetryAttempt: 0,
      adapterType: "openclaw_gateway",
    });

    await heartbeatService(db).reconcileStrandedAssignedIssues();

    const actions = await activeRecoveryActionsFor(issueId);
    expect(actions.length).toBeGreaterThan(0);
    expect(actions[0]!.ownerType).toBe("board");
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue!.status).toBe("blocked");
  }, 30_000);

  // Senior review, round 2: a conversation adapter's run whose provider stop
  // is only requested has not been proven stopped; waiting for resume would
  // let the next turn overlap it, so the vendor escalation stays.
  it("still escalates while paused and within budget when the provider stop was requested but never confirmed", async () => {
    const { issueId } = await seedStrandedIssue({
      errorCode: "agent_paused",
      scheduledRetryAttempt: 0,
      resultJson: { executionCancellation: { state: "requested", requestedAt: new Date().toISOString() } },
    });

    await heartbeatService(db).reconcileStrandedAssignedIssues();

    const actions = await activeRecoveryActionsFor(issueId);
    expect(actions.length).toBeGreaterThan(0);
    expect(actions[0]!.ownerType).toBe("board");
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue!.status).toBe("blocked");
  }, 30_000);

  it("does not escalate while paused and within budget when the provider stop was acknowledged", async () => {
    const { issueId } = await seedStrandedIssue({
      errorCode: "agent_paused",
      scheduledRetryAttempt: 0,
      resultJson: { executionCancellation: { state: "acknowledged", acknowledgedAt: new Date().toISOString() } },
    });

    await heartbeatService(db).reconcileStrandedAssignedIssues();

    expect(await activeRecoveryActionsFor(issueId)).toHaveLength(0);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue!.status).toBe("in_progress");
  }, 30_000);

  it("still escalates while paused and within budget when the stranded run's adapter was never claimed", async () => {
    const { issueId } = await seedStrandedIssue({
      errorCode: "agent_paused",
      scheduledRetryAttempt: 0,
      adapterType: null,
    });

    await heartbeatService(db).reconcileStrandedAssignedIssues();

    expect((await activeRecoveryActionsFor(issueId)).length).toBeGreaterThan(0);
  }, 30_000);
});
