import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentRuntimeState,
  authUsers,
  agentWakeupRequests,
  activityLog,
  companies,
  createDb,
  environmentLeases,
  environments,
  heartbeatRuns,
  issueComments,
  issueInboxArchives,
  issueRecoveryActions,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { buildPaperclipWakePayload, heartbeatService } from "../services/heartbeat.js";
import { deliverReconciledExecutions } from "../services/execution-recovery-resolution.js";
import {
  applyIssueExecutionPolicyTransition,
  normalizeIssueExecutionPolicy,
} from "../services/issue-execution-policy.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { issueService } from "../services/issues.js";
import { recoveryService } from "../services/recovery/service.js";
// myrmidon(L4): DB-backed coverage for the auto-policy's counters and its
// two live-write branches; see ../myrmidon/stranded-autopolicy.myrmidon.test.ts
// for the pure-function coverage.
import {
  countStrandedAutoPolicyAttemptsInWindow,
  findActiveManagerAgentId,
  STRANDED_AUTO_POLICY_RETRY_SOURCE,
} from "../myrmidon/stranded-autopolicy.js";
import { noticeMetadataReferencesRecoveryAction } from "../services/recovery/successful-run-handoff.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function makeRecoveryActionRow(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-05-09T19:30:00.000Z");
  return {
    id: randomUUID(),
    companyId: "company-1",
    sourceIssueId: "source-1",
    recoveryIssueId: null,
    kind: "missing_disposition",
    status: "active",
    ownerType: "agent",
    ownerAgentId: "agent-1",
    ownerUserId: null,
    previousOwnerAgentId: null,
    returnOwnerAgentId: null,
    cause: "successful_run_missing_issue_disposition",
    fingerprint: "missing-disposition:fingerprint",
    evidence: {},
    nextAction: "Choose a valid issue disposition.",
    wakePolicy: null,
    monitorPolicy: null,
    attemptCount: 1,
    maxAttempts: null,
    timeoutAt: null,
    lastAttemptAt: now,
    outcome: null,
    resolutionNote: null,
    resolvedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("issueRecoveryActionService", () => {
  it("does not reactivate an action resolved between the active read and update", async () => {
    const existingRow = makeRecoveryActionRow({ id: "existing-action", attemptCount: 1 });
    const createdRow = makeRecoveryActionRow({ id: "new-action", attemptCount: 1 });
    const selectResults = [[existingRow], []];

    const makeSelectQuery = (rows: unknown[]) => ({
      from() {
        return this;
      },
      where() {
        return this;
      },
      orderBy() {
        return this;
      },
      limit() {
        return Promise.resolve(rows);
      },
    });

    const fakeDb = {
      select: vi.fn(() => makeSelectQuery(selectResults.shift() ?? [])),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn(async () => []),
          })),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn(async () => [createdRow]),
        })),
      })),
    };

    const result = await issueRecoveryActionService(fakeDb as never).upsertSourceScoped({
      companyId: "company-1",
      sourceIssueId: "source-1",
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId: "agent-1",
      cause: "successful_run_missing_issue_disposition",
      fingerprint: "missing-disposition:fingerprint",
      nextAction: "Choose a valid issue disposition.",
    });

    expect(result).toMatchObject({ id: "new-action", status: "active" });
    expect(fakeDb.update).toHaveBeenCalledTimes(1);
    expect(fakeDb.insert).toHaveBeenCalledTimes(1);
  });
});

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue recovery action tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue recovery actions", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-recovery-actions-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueRecoveryActions);
    await db.delete(issueComments);
    await db.delete(environmentLeases);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(environments);
    await db.delete(issueInboxArchives);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const coderId = randomUUID();
    const sourceIssueId = randomUUID();
    const prefix = `RA${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Recovery Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: managerId,
        companyId,
        name: "CTO",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: coderId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "idle",
        reportsTo: managerId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Implement backend recovery",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: coderId,
      issueNumber: 1,
      identifier: `${prefix}-1`,
    });
    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    return { companyId, managerId, coderId, sourceIssueId, prefix, sourceIssue: sourceIssue! };
  }

  async function seedHeartbeatRun(input: {
    companyId: string;
    agentId: string;
    runId: string;
    issueId?: string;
    status?: string;
  }) {
    await db.insert(heartbeatRuns).values({
      id: input.runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "manual",
      status: input.status ?? "running",
      startedAt: new Date("2026-05-13T18:00:00.000Z"),
      contextSnapshot: input.issueId ? { issueId: input.issueId } : undefined,
    });
  }

  function createApp(
    actor: any = { type: "board", source: "local_implicit" },
    opts: Parameters<typeof issueRoutes>[2] = {},
  ) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any, opts));
    app.use(errorHandler);
    return app;
  }

  it("upserts one active source-scoped action per issue and keeps company scoping explicit", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const svc = issueRecoveryActionService(db);

    const first = await svc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "stranded_assigned_issue",
      fingerprint: "recovery:fingerprint",
      evidence: { latestRunId: "run-1" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "wake_owner" },
    });
    const second = await svc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "stranded_assigned_issue",
      fingerprint: "recovery:fingerprint",
      evidence: { latestRunId: "run-2" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "wake_owner" },
    });

    expect(second.id).toBe(first.id);
    expect(second.attemptCount).toBe(2);
    expect(second.evidence).toMatchObject({ latestRunId: "run-2" });
    expect(await svc.getActiveForIssue(companyId, sourceIssueId)).toMatchObject({ id: first.id });
    expect(await svc.getActiveForIssue(randomUUID(), sourceIssueId)).toBeNull();
  });

  it("enforces maxAttempts once and removes every automatic recovery path", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const svc = issueRecoveryActionService(db);
    const base = {
      companyId,
      sourceIssueId,
      kind: "active_run_watchdog" as const,
      ownerType: "agent" as const,
      ownerAgentId: managerId,
      returnOwnerAgentId: managerId,
      cause: "process_lost",
      fingerprint: "run-process-lost",
      nextAction: "Resume the same run.",
      wakePolicy: { kind: "resume_native_run", runId: "run-1" },
      monitorPolicy: { kind: "watch_run", runId: "run-1" },
      maxAttempts: 3,
    };

    const first = await svc.upsertSourceScoped(base);
    const second = await svc.upsertSourceScoped(base);
    const exhausted = await svc.upsertSourceScoped(base);
    const replay = await svc.upsertSourceScoped(base);

    expect(first.attemptCount).toBe(1);
    expect(second.attemptCount).toBe(2);
    expect(exhausted).toMatchObject({
      id: first.id,
      status: "escalated",
      ownerType: "board",
      ownerAgentId: null,
      returnOwnerAgentId: managerId,
      attemptCount: 3,
      maxAttempts: 3,
      wakePolicy: null,
      monitorPolicy: null,
      outcome: "escalated",
      evidence: {
        recoveryBudget: {
          state: "exhausted",
          attemptsUsed: 3,
          maxAttempts: 3,
        },
      },
    });
    expect(replay).toEqual(exhausted);
  });

  it("preserves legacy recovery ownership when new evidence is folded into an active action", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    const svc = issueRecoveryActionService(db);
    const legacy = await svc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "process_lost",
      fingerprint: "legacy-recovery",
      evidence: { latestRunId: "run-1" },
      nextAction: "Repair the execution path.",
      wakePolicy: { type: "bounded_recovery_owner", ownerAgentId: managerId, attempt: 1, maxAttempts: 5 },
      attemptCount: 1,
      maxAttempts: 5,
    });

    const updated = await svc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "board",
      ownerAgentId: null,
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "process_lost",
      fingerprint: "legacy-recovery",
      evidence: { latestRunId: "run-2" },
      evidenceOnCreate: { routingPolicy: "board_escalation_no_takeover_v1" },
      nextAction: "Board decision required.",
      wakePolicy: { type: "board_escalation" },
      preserveExistingOwner: true,
    });

    expect(updated).toMatchObject({
      id: legacy.id,
      ownerType: "agent",
      ownerAgentId: managerId,
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      attemptCount: 2,
      maxAttempts: 5,
      nextAction: "Repair the execution path.",
      evidence: expect.objectContaining({ latestRunId: "run-2" }),
      wakePolicy: expect.objectContaining({ type: "bounded_recovery_owner" }),
    });
    expect(updated.evidence).not.toHaveProperty("routingPolicy");
  });

  it("escalates stranded assigned work into a source action instead of a recovery issue", async () => {
    const { companyId, coderId, sourceIssue } = await seedCompany();
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const latestRun = {
      id: randomUUID(),
      agentId: coderId,
      status: "failed",
      error: "adapter failed",
      errorCode: "adapter_failed",
      contextSnapshot: { retryReason: "issue_continuation_needed" },
      livenessState: "needs_followup",
    } as const;

    await Promise.all([
      recovery.escalateStrandedAssignedIssue({
        issue: sourceIssue,
        previousStatus: "in_progress",
        latestRun,
        comment: "Automatic continuation recovery failed.",
      }),
      recovery.escalateStrandedAssignedIssue({
        issue: sourceIssue,
        previousStatus: "in_progress",
        latestRun,
        comment: "Automatic continuation recovery failed.",
      }),
    ]);

    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({
      companyId,
      kind: "stranded_assigned_issue",
      status: "active",
      ownerType: "board",
      ownerAgentId: null,
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "stranded_assigned_issue",
      attemptCount: 2,
      evidence: expect.objectContaining({
        routingPolicy: "board_escalation_no_takeover_v1",
      }),
    });

    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
    expect(updatedIssue).toMatchObject({
      status: "blocked",
    });
    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveryIssues).toHaveLength(0);
    expect(updatedIssue?.assigneeAgentId).toBe(coderId);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  // Model the production payload: `requestedRef` keeps the operator spelling,
  // and the fingerprint carries the canonical remote ref. Two equivalent
  // spellings of one remote branch share `identityRef`, so they share one
  // fingerprint. A different branch gets a different `identityRef`.
  const makeUnresolvedBaseRefRun = (agentId: string, issueId: string) =>
    (requestedRef: string, identityRef: string) =>
      ({
        id: randomUUID(),
        agentId,
        status: "failed",
        error: `Configured workspace base ref "${requestedRef}" did not resolve to a commit on origin after an authenticated fetch.`,
        errorCode: "configuration_incomplete",
        contextSnapshot: { issueId },
        livenessState: "needs_followup",
        resultJson: {
          configurationIncomplete: {
            reason: "workspace_base_ref_unresolved",
            requestedRef,
            attemptedRefs: [identityRef],
            fingerprint: `workspace_base_ref:${identityRef}`,
          },
        },
      }) as const;

  it("bounds configuration-incomplete recovery by the unresolved base ref fingerprint", async () => {
    const { coderId, sourceIssue } = await seedCompany();
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const makeRun = makeUnresolvedBaseRefRun(coderId, sourceIssue.id);

    // Two reconciliations with the same unresolved ref reuse one active action.
    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: makeRun("fix/foo", "origin/fix/foo"),
      recoveryCause: "configuration_incomplete",
    });
    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: makeRun("fix/foo", "origin/fix/foo"),
      recoveryCause: "configuration_incomplete",
    });

    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      cause: "configuration_incomplete",
      status: "active",
      attemptCount: 2,
    });
    // The fingerprint carries the canonical remote ref, so the same branch stays
    // one action and a different branch would make a distinct fingerprint.
    expect(actions[0]?.fingerprint).toBe(
      `source_scoped_recovery:${sourceIssue.companyId}:${sourceIssue.id}:configuration_incomplete:workspace_base_ref:origin/fix/foo`,
    );
  });

  it("keeps equivalent spellings of one unresolved base ref under one recovery identity", async () => {
    const { coderId, sourceIssue } = await seedCompany();
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const makeRun = makeUnresolvedBaseRefRun(coderId, sourceIssue.id);

    // The operator retries the same remote branch under two spellings. Both map
    // to the canonical `origin/fix/foo` identity, so recovery must not reset the
    // attempt count or post a second notice.
    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: makeRun("fix/foo", "origin/fix/foo"),
      recoveryCause: "configuration_incomplete",
    });
    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: makeRun("origin/fix/foo", "origin/fix/foo"),
      recoveryCause: "configuration_incomplete",
    });

    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    // One identity, one active action, the attempt count advances.
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      cause: "configuration_incomplete",
      status: "active",
      attemptCount: 2,
    });
    expect(actions[0]?.fingerprint).toBe(
      `source_scoped_recovery:${sourceIssue.companyId}:${sourceIssue.id}:configuration_incomplete:workspace_base_ref:origin/fix/foo`,
    );

    // The operator gets one notice, bound to the one action.
    const notices = await db
      .select({ metadata: issueComments.metadata })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, sourceIssue.id),
          eq(issueComments.authorType, "system"),
        ),
      );
    expect(
      notices.filter((row) =>
        noticeMetadataReferencesRecoveryAction(row.metadata, actions[0]!.id),
      ),
    ).toHaveLength(1);
  });

  it("gives a distinct recovery identity and a new operator notice when the unresolved base ref changes", async () => {
    const { coderId, sourceIssue } = await seedCompany();
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const makeRun = makeUnresolvedBaseRefRun(coderId, sourceIssue.id);

    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: makeRun("fix/foo", "origin/fix/foo"),
      recoveryCause: "configuration_incomplete",
    });
    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: makeRun("fix/bar", "origin/fix/bar"),
      recoveryCause: "configuration_incomplete",
    });

    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    // The prior ref keeps its own record and the new ref gets a fresh identity.
    expect(actions).toHaveLength(2);
    const priorAction = actions.find((row) =>
      row.fingerprint.endsWith("workspace_base_ref:origin/fix/foo"),
    );
    const newAction = actions.find((row) =>
      row.fingerprint.endsWith("workspace_base_ref:origin/fix/bar"),
    );
    expect(priorAction?.status).toBe("cancelled");
    expect(priorAction?.outcome).toBe("cancelled");
    expect(newAction?.status).toBe("active");
    expect(newAction?.attemptCount).toBe(1);
    expect(newAction?.id).not.toBe(priorAction?.id);

    // The operator gets one notice per distinct ref, each bound to its action.
    const systemComments = await db
      .select({ metadata: issueComments.metadata })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, sourceIssue.id),
          eq(issueComments.authorType, "system"),
        ),
      );
    expect(
      systemComments.some((row) =>
        noticeMetadataReferencesRecoveryAction(row.metadata, priorAction!.id),
      ),
    ).toBe(true);
    expect(
      systemComments.some((row) =>
        noticeMetadataReferencesRecoveryAction(row.metadata, newAction!.id),
      ),
    ).toBe(true);
  });

  it.each([
    ["process_lost", undefined],
    ["adapter_failed", "successful_run_missing_state"],
    ["codex_output_inactivity_monitor", undefined],
    ["workspace_validation_failed", "workspace_validation_failed"],
    ["adapter_failed", undefined],
  ] as const)(
    "routes %s recovery through the cause-keyed playbook",
    async (errorCode, explicitCause) => {
      const { coderId, sourceIssue } = await seedCompany();
      const enqueueWakeup = vi.fn(async () => null);
      const recovery = recoveryService(db, { enqueueWakeup });
      const latestRun = {
        id: randomUUID(),
        agentId: coderId,
        status: errorCode === "adapter_failed" && explicitCause === "successful_run_missing_state"
          ? "succeeded"
          : "failed",
        error: `${errorCode} failure`,
        errorCode,
        contextSnapshot: { retryReason: "issue_continuation_needed" },
        livenessState: "needs_followup",
        resultJson: errorCode === "workspace_validation_failed"
          ? { workspaceValidation: { reason: "missing_workspace", fingerprint: "workspace:test" } }
          : null,
      } as const;

      await recovery.escalateStrandedAssignedIssue({
        issue: sourceIssue,
        previousStatus: "in_progress",
        latestRun,
        ...(explicitCause ? { recoveryCause: explicitCause } : {}),
      });

      const [action] = await db
        .select()
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
      expect(action).toMatchObject({
        ownerType: "board",
        ownerAgentId: null,
        previousOwnerAgentId: coderId,
        returnOwnerAgentId: coderId,
        evidence: expect.objectContaining({
          routingPolicy: "board_escalation_no_takeover_v1",
        }),
        wakePolicy: expect.objectContaining({
          type: "board_escalation",
          preservesSourceAssignee: true,
        }),
      });
      // myrmidon(L4): a succeeded run with `successful_run_missing_state` is
      // the auto-policy's scope (stranded-autopolicy.ts). With the seeded
      // coder having zero prior attempts today, it first tries one more
      // continuation retry through this same `enqueueWakeup`; this fixture's
      // mock declines every wake (`async () => null`), so the policy falls
      // back to the vendor's own board escalation unchanged — but the retry
      // is still attempted once before that fallback.
      if (errorCode === "adapter_failed" && explicitCause === "successful_run_missing_state") {
        expect(enqueueWakeup).toHaveBeenCalledTimes(1);
        expect(enqueueWakeup).toHaveBeenCalledWith(
          coderId,
          expect.objectContaining({
            contextSnapshot: expect.objectContaining({ source: "myrmidon.stranded_autopolicy_retry" }),
          }),
        );
      } else {
        expect(enqueueWakeup).not.toHaveBeenCalled();
      }
    },
  );

  describe("L4 stranded auto-policy", () => {
    // A `latestRun` fixture matching the shape the surrounding tests already
    // use for `escalateStrandedAssignedIssue` (see the `it.each` above):
    // `LatestIssueRun` only needs these fields in practice here. It also
    // seeds a real `heartbeat_runs` row for that id — the manager-handoff
    // branch logs `activity_log.run_id = latestRun.id`, and that column has
    // a live FK to `heartbeat_runs.id`, so an in-memory-only id 23503s.
    async function succeededRun(input: { companyId: string; agentId: string }) {
      const id = randomUUID();
      await seedHeartbeatRun({ companyId: input.companyId, agentId: input.agentId, runId: id, status: "succeeded" });
      return {
        id,
        agentId: input.agentId,
        status: "succeeded",
        error: null,
        errorCode: null,
        contextSnapshot: {},
        livenessState: null,
        resultJson: null,
      } as const;
    }

    async function seedStrandedAutoPolicyRetryRun(input: {
      companyId: string;
      agentId: string;
      issueId: string;
      createdAt?: Date;
    }) {
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId: input.companyId,
        agentId: input.agentId,
        invocationSource: "automation",
        status: "queued",
        startedAt: input.createdAt,
        createdAt: input.createdAt,
        contextSnapshot: { issueId: input.issueId, source: STRANDED_AUTO_POLICY_RETRY_SOURCE },
      });
    }

    // myrmidon(L4): the manager's decision on a handed-off issue, applied the
    // way the PATCH route applies any execution-stage decision
    // (`server/src/routes/issues.ts`): run the vendor's own transition as the
    // manager agent over the persisted row, merge the requested status with
    // the transition's patch, and persist through the issue service. The
    // route's access and wake plumbing is deliberately not part of this — the
    // outcome of the decision on the persisted issue is.
    async function decideAsManager(input: {
      issueId: string;
      managerId: string;
      status: "done" | "in_progress";
      comment: string;
    }) {
      const [row] = await db.select().from(issues).where(eq(issues.id, input.issueId));
      const policy = normalizeIssueExecutionPolicy(row!.executionPolicy);
      const transition = applyIssueExecutionPolicyTransition({
        issue: row!,
        policy,
        previousPolicy: policy,
        requestedStatus: input.status,
        requestedAssigneePatch: {},
        actor: { agentId: input.managerId, userId: null },
        commentBody: input.comment,
      });
      return issueService(db).update(input.issueId, {
        status: input.status,
        ...transition.patch,
      } as Partial<typeof issues.$inferInsert>);
    }

    // myrmidon(L4): a minimal stand-in for heartbeat.ts's real `enqueueWakeup`
    // that actually persists a `heartbeat_runs` row and (when the caller
    // passed one) an `agent_wakeup_requests` row tagged with the same
    // `idempotencyKey` — just enough real side effect for the retry branch's
    // own idempotency pre-check (`findExistingStrandedAutoPolicyRetryWake`)
    // to observe it on a later call, the same way it would observe the real
    // function's write.
    function fakeRetryWakeEnqueue(input: { companyId: string }) {
      return vi.fn(async (agentId: string, opts: any) => {
        const runId = randomUUID();
        await db.insert(heartbeatRuns).values({
          id: runId,
          companyId: input.companyId,
          agentId,
          invocationSource: "automation",
          status: "queued",
          contextSnapshot: opts?.contextSnapshot ?? {},
        });
        const idempotencyKey = opts?.idempotencyKey as string | undefined;
        if (idempotencyKey) {
          await db.insert(agentWakeupRequests).values({
            companyId: input.companyId,
            agentId,
            source: opts?.source ?? "automation",
            status: "queued",
            idempotencyKey,
            payload: opts?.payload ?? {},
            requestedByActorType: "system",
            requestedByActorId: null,
          });
        }
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        return run ?? null;
      });
    }

    it("countStrandedAutoPolicyAttemptsInWindow counts only this issue's tagged retries inside the window, against a live database", async () => {
      const { companyId, coderId, sourceIssueId } = await seedCompany();
      const now = new Date("2026-09-28T12:00:00.000Z");
      const insideWindow = new Date(now.getTime() - 60 * 60 * 1000);
      const outsideWindow = new Date(now.getTime() - 30 * 60 * 60 * 1000);
      await seedStrandedAutoPolicyRetryRun({ companyId, agentId: coderId, issueId: sourceIssueId, createdAt: insideWindow });
      await seedStrandedAutoPolicyRetryRun({ companyId, agentId: coderId, issueId: sourceIssueId, createdAt: outsideWindow });
      // A differently-sourced run for the same issue/agent must not count.
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId: coderId,
        invocationSource: "automation",
        status: "queued",
        startedAt: insideWindow,
        createdAt: insideWindow,
        contextSnapshot: { issueId: sourceIssueId, source: "issue_continuation_needed" },
      });

      const count = await countStrandedAutoPolicyAttemptsInWindow(db, {
        companyId,
        issueId: sourceIssueId,
        agentId: coderId,
        now,
      });
      expect(count).toBe(1);
    });

    it("findActiveManagerAgentId resolves the direct manager and stops once they are paused, against a live database", async () => {
      const { managerId, coderId } = await seedCompany();
      expect(await findActiveManagerAgentId(db, coderId)).toBe(managerId);

      await db.update(agents).set({ status: "paused" }).where(eq(agents.id, managerId));
      expect(await findActiveManagerAgentId(db, coderId)).toBeNull();
    });

    it("the retry wake's instruction actually reaches buildPaperclipWakePayload's rendered prompt", async () => {
      // Regression for a review finding: the instruction text was built but
      // spread under a bare `instruction` key that buildPaperclipWakePayload
      // never reads, so it never rendered into the agent's prompt even
      // though the queued wake carried the right `source` tag.
      const { companyId, coderId, sourceIssue } = await seedCompany();
      const enqueueWakeup = vi.fn(async () => null);
      const recovery = recoveryService(db, { enqueueWakeup });

      await recovery.escalateStrandedAssignedIssue({
        issue: sourceIssue,
        previousStatus: "in_progress",
        latestRun: await succeededRun({ companyId, agentId: coderId }),
        recoveryCause: "successful_run_missing_state",
      });

      expect(enqueueWakeup).toHaveBeenCalledTimes(1);
      const [, wakeOpts] = enqueueWakeup.mock.calls[0] as unknown as [
        string,
        { contextSnapshot?: Record<string, unknown> },
      ];
      const contextSnapshot = wakeOpts.contextSnapshot ?? {};
      expect(contextSnapshot).toMatchObject({
        source: STRANDED_AUTO_POLICY_RETRY_SOURCE,
        livenessContinuationState: "successful_run_missing_state",
        livenessContinuationAttempt: 1,
        livenessContinuationMaxAttempts: 2,
      });

      const payload = await buildPaperclipWakePayload({ db, companyId, contextSnapshot });
      expect(payload?.livenessContinuation).toMatchObject({ attempt: 1, maxAttempts: 2 });
      expect(payload?.livenessContinuation?.instruction).toContain("retry 1 of 2");
      expect(payload?.livenessContinuation?.instruction).toContain("Record exactly one of the following");
    });

    it("hands the issue to the direct manager once the daily retry cap is exhausted, end to end", async () => {
      const { companyId, managerId, coderId, sourceIssue } = await seedCompany();
      // Exhaust the default daily cap (2) with two prior tagged retry runs.
      await seedStrandedAutoPolicyRetryRun({ companyId, agentId: coderId, issueId: sourceIssue.id, createdAt: new Date() });
      await seedStrandedAutoPolicyRetryRun({ companyId, agentId: coderId, issueId: sourceIssue.id, createdAt: new Date() });
      const enqueueWakeup = vi.fn(async () => null);
      const recovery = recoveryService(db, { enqueueWakeup });

      const updated = await recovery.escalateStrandedAssignedIssue({
        issue: sourceIssue,
        previousStatus: "in_progress",
        latestRun: await succeededRun({ companyId, agentId: coderId }),
        recoveryCause: "stranded_assigned_issue",
      });

      expect(updated?.status).toBe("in_review");
      expect(updated?.assigneeAgentId).toBe(managerId);
      const [persisted] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
      expect(persisted?.status).toBe("in_review");
      expect(persisted?.assigneeAgentId).toBe(managerId);

      const comments = await db
        .select()
        .from(issueComments)
        .where(and(eq(issueComments.issueId, sourceIssue.id), eq(issueComments.authorType, "system")));
      expect(comments.some((row) => row.body.includes("moved this issue to review"))).toBe(true);
      // Review finding: the comment used to (falsely) claim the assignment
      // was unchanged and would resume once review cleared.
      expect(comments.some((row) => row.body.includes("closes the issue as done"))).toBe(true);
      expect(comments.some((row) => row.body.includes("unchanged"))).toBe(false);

      expect(enqueueWakeup).toHaveBeenCalledTimes(1);
      // Review finding: the manager's wake used to carry a generic
      // `issue_assigned` reason with no execution-stage context at all.
      expect(enqueueWakeup).toHaveBeenCalledWith(
        managerId,
        expect.objectContaining({
          reason: "execution_review_requested",
          payload: expect.objectContaining({
            executionStage: expect.objectContaining({
              wakeRole: "reviewer",
              allowedActions: ["approve", "request_changes"],
            }),
          }),
        }),
      );

      const activity = await db
        .select()
        .from(activityLog)
        .where(
          and(
            eq(activityLog.entityId, sourceIssue.id),
            eq(activityLog.action, "issue.stranded_autopolicy_reassigned_to_manager"),
          ),
        );
      expect(activity).toHaveLength(1);
    });

    // Senior review, round 2: the outcome of the manager's decision was not
    // pinned anywhere. Approving the only stage closes the issue as done (the
    // manager stays the assignee — no stage to return into); only requesting
    // changes sends it back to the original assignee.
    it("the manager approving the handed-off issue closes it as done and stays its assignee", async () => {
      const { companyId, managerId, coderId, sourceIssue } = await seedCompany();
      await seedStrandedAutoPolicyRetryRun({ companyId, agentId: coderId, issueId: sourceIssue.id, createdAt: new Date() });
      await seedStrandedAutoPolicyRetryRun({ companyId, agentId: coderId, issueId: sourceIssue.id, createdAt: new Date() });
      const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });
      const handedOff = await recovery.escalateStrandedAssignedIssue({
        issue: sourceIssue,
        previousStatus: "in_progress",
        latestRun: await succeededRun({ companyId, agentId: coderId }),
        recoveryCause: "stranded_assigned_issue",
      });
      expect(handedOff?.status).toBe("in_review");
      expect(handedOff?.assigneeAgentId).toBe(managerId);

      await decideAsManager({
        issueId: sourceIssue.id,
        managerId,
        status: "done",
        comment: "Checked the result; the work is complete.",
      });

      const [persisted] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
      expect(persisted?.status).toBe("done");
      expect(persisted?.assigneeAgentId).toBe(managerId);
      const state = persisted?.executionState as {
        status?: string;
        lastDecisionOutcome?: string;
        currentParticipant?: unknown;
      } | null;
      expect(state?.status).toBe("completed");
      expect(state?.lastDecisionOutcome).toBe("approved");
      expect(state?.currentParticipant).toBeNull();
    });

    it("the manager requesting changes sends the handed-off issue back to the original assignee and counts one round", async () => {
      const { companyId, managerId, coderId, sourceIssue } = await seedCompany();
      await seedStrandedAutoPolicyRetryRun({ companyId, agentId: coderId, issueId: sourceIssue.id, createdAt: new Date() });
      await seedStrandedAutoPolicyRetryRun({ companyId, agentId: coderId, issueId: sourceIssue.id, createdAt: new Date() });
      const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });
      const handedOff = await recovery.escalateStrandedAssignedIssue({
        issue: sourceIssue,
        previousStatus: "in_progress",
        latestRun: await succeededRun({ companyId, agentId: coderId }),
        recoveryCause: "stranded_assigned_issue",
      });
      expect(handedOff?.assigneeAgentId).toBe(managerId);

      await decideAsManager({
        issueId: sourceIssue.id,
        managerId,
        status: "in_progress",
        comment: "Not finished: the edge case still has no test.",
      });

      const [persisted] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
      expect(persisted?.status).toBe("in_progress");
      expect(persisted?.assigneeAgentId).toBe(coderId);
      const state = persisted?.executionState as {
        status?: string;
        lastDecisionOutcome?: string;
        changesRequestedCount?: number;
      } | null;
      expect(state?.status).toBe("changes_requested");
      expect(state?.lastDecisionOutcome).toBe("changes_requested");
      expect(state?.changesRequestedCount).toBe(1);
    });

    it("falls back to the vendor's own board escalation once the cap is exhausted with no manager", async () => {
      const { companyId, coderId, sourceIssue } = await seedCompany();
      await db.update(agents).set({ reportsTo: null }).where(eq(agents.id, coderId));
      await seedStrandedAutoPolicyRetryRun({ companyId, agentId: coderId, issueId: sourceIssue.id, createdAt: new Date() });
      await seedStrandedAutoPolicyRetryRun({ companyId, agentId: coderId, issueId: sourceIssue.id, createdAt: new Date() });
      const enqueueWakeup = vi.fn(async () => null);
      const recovery = recoveryService(db, { enqueueWakeup });

      await recovery.escalateStrandedAssignedIssue({
        issue: sourceIssue,
        previousStatus: "in_progress",
        latestRun: await succeededRun({ companyId, agentId: coderId }),
        recoveryCause: "stranded_assigned_issue",
      });

      const [persisted] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
      // Unchanged vendor behavior: the source assignee is preserved and the
      // issue is parked `blocked` behind a board-owned recovery action,
      // never reassigned to anyone.
      expect(persisted?.status).toBe("blocked");
      expect(persisted?.assigneeAgentId).toBe(coderId);
      const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
      expect(action).toMatchObject({
        ownerType: "board",
        wakePolicy: expect.objectContaining({ type: "board_escalation" }),
      });
    });

    it("does not apply the L4 auto-policy to a todo-status escalation with a succeeded last run", async () => {
      // Third-round review finding: `stranded_assigned_issue` is the generic
      // catch-all `resolveStrandedRecoveryCause` returns for ANY call here
      // that passes no explicit cause, including pre-existing, unrelated
      // escalation reasons for a `todo` issue — the re-dispatch-failure path
      // (`wasTodoHandedBackDuringOrAfterLatestRun` + `didAutomaticRecoveryFail`)
      // and the "assignee not invokable"/"over budget" catch-all just above
      // it in `reconcileStrandedAssignedIssues` — both reachable with a
      // succeeded latest run. Without a scope check on
      // `previousStatus`/`issue.status`, those dispatch failures would
      // wrongly get an agent retry-wake or a manager `in_review` handoff
      // instead of the vendor's own `blocked` board escalation the "no live
      // execution path" notice describes. The assignee here is invokable
      // and has an active manager with retries available, so if the scope
      // check were missing, L4 would engage (retry) instead of escalating.
      const { companyId, coderId, sourceIssue } = await seedCompany();
      await db.update(issues).set({ status: "todo" }).where(eq(issues.id, sourceIssue.id));
      const enqueueWakeup = vi.fn(async () => null);
      const recovery = recoveryService(db, { enqueueWakeup });

      const updated = await recovery.escalateStrandedAssignedIssue({
        issue: { ...sourceIssue, status: "todo" },
        previousStatus: "todo",
        latestRun: await succeededRun({ companyId, agentId: coderId }),
        notice: {
          body:
            "Paperclip automatically retried dispatch for this assigned `todo` issue after a lost wake/run, " +
            "but it still has no live execution path. " +
            "Moving it to `blocked` so it is visible for intervention.",
          title: "No live execution path",
          tone: "danger",
        },
      });

      expect(enqueueWakeup).not.toHaveBeenCalled();
      expect(updated?.status).toBe("blocked");
      const [persisted] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
      expect(persisted?.status).toBe("blocked");
      expect(persisted?.assigneeAgentId).toBe(coderId);
      const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
      expect(action?.ownerType).toBe("board");
    });

    it("does not crash the caller when the guarded wake throws for a non-invokable or over-budget assignee, and falls back to the vendor's own board escalation", async () => {
      // Review finding: heartbeat.ts's real `enqueueWakeup` *throws* (not a
      // falsy return) when the target agent turns out not to be invokable or
      // is over its invocation budget. A succeeded run whose assignee was
      // paused or terminated right after finishing is a realistic, in-scope
      // L4 case (`reconcileStrandedAssignedIssues`'s own "assignee not
      // invokable" and "over budget" branches reach this function with a
      // succeeded latest run and the default `stranded_assigned_issue`
      // cause), and was previously left unguarded here.
      const { companyId, coderId, sourceIssue } = await seedCompany();
      const enqueueWakeup = vi.fn(async () => {
        throw Object.assign(new Error("Agent is not invokable: paused"), { status: 409 });
      });
      const recovery = recoveryService(db, { enqueueWakeup });

      const updated = await recovery.escalateStrandedAssignedIssue({
        issue: sourceIssue,
        previousStatus: "in_progress",
        latestRun: await succeededRun({ companyId, agentId: coderId }),
        recoveryCause: "stranded_assigned_issue",
      });

      expect(enqueueWakeup).toHaveBeenCalledTimes(1);
      expect(updated?.status).toBe("blocked");
      const [persisted] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
      expect(persisted?.status).toBe("blocked");
      expect(persisted?.assigneeAgentId).toBe(coderId);
      const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
      expect(action?.ownerType).toBe("board");
    });

    it("reprocessing the same successful run through the retry branch is idempotent: a second call does not queue a second continuation wake", async () => {
      // Review finding: the retry branch had no guard against two calls
      // (e.g. two sweep ticks racing, or the sweep and a direct heartbeat.ts
      // caller) reaching it for the same stranded issue with an identical
      // stale `latestRun` snapshot — each would independently decide
      // "retry" and could each queue their own continuation wake.
      const { companyId, coderId, sourceIssue } = await seedCompany();
      const enqueueWakeup = fakeRetryWakeEnqueue({ companyId });
      const recovery = recoveryService(db, { enqueueWakeup });
      const latestRun = await succeededRun({ companyId, agentId: coderId });

      await recovery.escalateStrandedAssignedIssue({
        issue: sourceIssue,
        previousStatus: "in_progress",
        latestRun,
        recoveryCause: "stranded_assigned_issue",
      });
      expect(enqueueWakeup).toHaveBeenCalledTimes(1);

      // A later sweep tick (or a racing direct caller) can reprocess the
      // same issue against the same stale `latestRun` snapshot before the
      // queued continuation run has itself started — it must stand down
      // instead of queuing a second continuation wake for the exact same
      // successful run.
      const second = await recovery.escalateStrandedAssignedIssue({
        issue: sourceIssue,
        previousStatus: "in_progress",
        latestRun,
        recoveryCause: "stranded_assigned_issue",
      });
      expect(enqueueWakeup).toHaveBeenCalledTimes(1);

      const wakes = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.companyId, companyId));
      expect(wakes).toHaveLength(1);

      // Third-round review finding: the duplicate-detected call used to fall
      // through into the vendor's own board escalation below (setting the
      // issue `blocked` and posting a board-escalation comment) instead of
      // standing down as a true no-op — re-triggering the very owner-card
      // escalation this policy exists to eliminate on every redundant sweep
      // tick. It must leave the issue exactly as the first call did.
      expect(second?.status).toBe("in_progress");
      const [persisted] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
      expect(persisted?.status).toBe("in_progress");
      expect(persisted?.assigneeAgentId).toBe(coderId);
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id))).toHaveLength(0);
    });

    it("keeps the manager handoff committed even when the reviewer wake itself throws", async () => {
      // Review finding: the manager-review wake is dispatched after the
      // issue is already durably `in_review` with the comment already
      // posted; an unguarded throw there (e.g. the manager itself becoming
      // non-invokable or over budget in that narrow window) must not undo
      // or fail that already-committed handoff.
      const { companyId, managerId, coderId, sourceIssue } = await seedCompany();
      await seedStrandedAutoPolicyRetryRun({ companyId, agentId: coderId, issueId: sourceIssue.id, createdAt: new Date() });
      await seedStrandedAutoPolicyRetryRun({ companyId, agentId: coderId, issueId: sourceIssue.id, createdAt: new Date() });
      const enqueueWakeup = vi.fn(async (agentId: string) => {
        if (agentId === managerId) {
          throw Object.assign(new Error("Agent is not invokable: paused"), { status: 409 });
        }
        return null;
      });
      const recovery = recoveryService(db, { enqueueWakeup });

      const updated = await recovery.escalateStrandedAssignedIssue({
        issue: sourceIssue,
        previousStatus: "in_progress",
        latestRun: await succeededRun({ companyId, agentId: coderId }),
        recoveryCause: "stranded_assigned_issue",
      });

      expect(updated?.status).toBe("in_review");
      expect(updated?.assigneeAgentId).toBe(managerId);
      const [persisted] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
      expect(persisted?.status).toBe("in_review");
      expect(persisted?.assigneeAgentId).toBe(managerId);
      const comments = await db
        .select()
        .from(issueComments)
        .where(and(eq(issueComments.issueId, sourceIssue.id), eq(issueComments.authorType, "system")));
      expect(comments.some((row) => row.body.includes("moved this issue to review"))).toBe(true);
    });

    it("two racing manager-handoff calls for the same exhausted issue do not double the comment, the wake or the activity log entry", async () => {
      const { companyId, managerId, coderId, sourceIssue } = await seedCompany();
      await seedStrandedAutoPolicyRetryRun({ companyId, agentId: coderId, issueId: sourceIssue.id, createdAt: new Date() });
      await seedStrandedAutoPolicyRetryRun({ companyId, agentId: coderId, issueId: sourceIssue.id, createdAt: new Date() });
      const enqueueWakeup = vi.fn(async () => null);
      const recovery = recoveryService(db, { enqueueWakeup });
      const latestRun = await succeededRun({ companyId, agentId: coderId });

      // Both calls carry the same stale issue snapshot, simulating two
      // callers (e.g. the sweep and a direct heartbeat.ts caller) that both
      // read the issue before either wrote — the row lock in the
      // reassign-to-manager branch must serialize them so only the first
      // actually hands the issue off; the second must not repeat it.
      await Promise.all([
        recovery.escalateStrandedAssignedIssue({
          issue: sourceIssue,
          previousStatus: "in_progress",
          latestRun,
          recoveryCause: "stranded_assigned_issue",
        }),
        recovery.escalateStrandedAssignedIssue({
          issue: sourceIssue,
          previousStatus: "in_progress",
          latestRun,
          recoveryCause: "stranded_assigned_issue",
        }),
      ]);

      const managerWakeCalls = (enqueueWakeup.mock.calls as unknown as Array<[string, unknown]>).filter(
        ([agentId]) => agentId === managerId,
      );
      expect(managerWakeCalls).toHaveLength(1);

      const comments = await db
        .select()
        .from(issueComments)
        .where(and(eq(issueComments.issueId, sourceIssue.id), eq(issueComments.authorType, "system")));
      expect(comments.filter((row) => row.body.includes("moved this issue to review"))).toHaveLength(1);

      const activity = await db
        .select()
        .from(activityLog)
        .where(
          and(
            eq(activityLog.entityId, sourceIssue.id),
            eq(activityLog.action, "issue.stranded_autopolicy_reassigned_to_manager"),
          ),
        );
      expect(activity).toHaveLength(1);

      // Third-round review finding: the losing call used to fall through
      // into the vendor's own board-escalation `blocked` update after the
      // winning call had already committed `in_review` — silently reverting
      // a handoff that had already succeeded. No board-escalation action
      // should exist, and the issue must stay exactly where the winner left
      // it.
      const [persisted] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
      expect(persisted?.status).toBe("in_review");
      expect(persisted?.assigneeAgentId).toBe(managerId);
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id))).toHaveLength(0);
    });

    it("does not overwrite an owner-configured execution policy when handing off to the manager", async () => {
      // Review finding #1: an issue whose owner already configured a review
      // stage (e.g. requiring a human approval) before this stranding must
      // not have that policy silently replaced by a brand-new single-stage
      // manager-review policy. Its stages have not started yet — the
      // policy only runs on a transition to in_review/done — so
      // executionState is still null, exactly the pre-started shape a real
      // owner-configured issue would have.
      const { companyId, coderId, sourceIssue } = await seedCompany();
      const ownerApprovalUserId = randomUUID();
      const ownerExecutionPolicy = {
        mode: "normal",
        commentRequired: true,
        stages: [
          {
            id: randomUUID(),
            type: "approval",
            approvalsNeeded: 1,
            participants: [{ id: randomUUID(), type: "user", agentId: null, userId: ownerApprovalUserId }],
          },
        ],
      };
      await db
        .update(issues)
        .set({ executionPolicy: ownerExecutionPolicy })
        .where(eq(issues.id, sourceIssue.id));
      await seedStrandedAutoPolicyRetryRun({ companyId, agentId: coderId, issueId: sourceIssue.id, createdAt: new Date() });
      await seedStrandedAutoPolicyRetryRun({ companyId, agentId: coderId, issueId: sourceIssue.id, createdAt: new Date() });
      const enqueueWakeup = vi.fn(async () => null);
      const recovery = recoveryService(db, { enqueueWakeup });

      const [issueWithPolicy] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
      const updated = await recovery.escalateStrandedAssignedIssue({
        issue: issueWithPolicy!,
        previousStatus: "in_progress",
        latestRun: await succeededRun({ companyId, agentId: coderId }),
        recoveryCause: "stranded_assigned_issue",
      });

      // Vendor's own board escalation, not a manager handoff: the assignee
      // and the owner's approval policy are both untouched, a human can
      // still not be bypassed.
      expect(updated?.status).toBe("blocked");
      const [persisted] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
      expect(persisted?.status).toBe("blocked");
      expect(persisted?.assigneeAgentId).toBe(coderId);
      expect(persisted?.executionPolicy).toEqual(ownerExecutionPolicy);
      expect(persisted?.executionState).toBeNull();
      const activity = await db
        .select()
        .from(activityLog)
        .where(
          and(
            eq(activityLog.entityId, sourceIssue.id),
            eq(activityLog.action, "issue.stranded_autopolicy_reassigned_to_manager"),
          ),
        );
      expect(activity).toHaveLength(0);
    });

    it("does not replace a stage-less execution policy that carries the trust boundary when handing off to the manager", async () => {
      // Senior review, round 2: a policy is not only its stages. This one has
      // none, yet it holds the task's trust preset and boundary and its
      // assignment policy; the handoff builds a brand-new single-stage policy,
      // so on this issue it would drop all of that and the manager (and, after
      // a changes request, the original assignee) would run under the standard
      // preset.
      const { companyId, coderId, sourceIssue } = await seedCompany();
      const trustPolicy = {
        mode: "normal",
        commentRequired: true,
        stages: [],
        authorizationPolicy: {
          trustPreset: "low_trust_review",
          trustBoundary: {
            mode: "low_trust_review",
            allowedAgentIds: [coderId],
            allowedToolClasses: ["git.read", "tests.local"],
          },
          assignmentPolicy: { mode: "protected" },
        },
      };
      await db
        .update(issues)
        .set({ executionPolicy: trustPolicy })
        .where(eq(issues.id, sourceIssue.id));
      await seedStrandedAutoPolicyRetryRun({ companyId, agentId: coderId, issueId: sourceIssue.id, createdAt: new Date() });
      await seedStrandedAutoPolicyRetryRun({ companyId, agentId: coderId, issueId: sourceIssue.id, createdAt: new Date() });
      const enqueueWakeup = vi.fn(async () => null);
      const recovery = recoveryService(db, { enqueueWakeup });

      const [issueWithPolicy] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
      const updated = await recovery.escalateStrandedAssignedIssue({
        issue: issueWithPolicy!,
        previousStatus: "in_progress",
        latestRun: await succeededRun({ companyId, agentId: coderId }),
        recoveryCause: "stranded_assigned_issue",
      });

      // Vendor's own board escalation, no handoff: the policy is byte-for-byte
      // what the owner configured and the issue is still with its assignee.
      expect(updated?.status).toBe("blocked");
      const [persisted] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
      expect(persisted?.status).toBe("blocked");
      expect(persisted?.assigneeAgentId).toBe(coderId);
      expect(persisted?.executionPolicy).toEqual(trustPolicy);
      expect(persisted?.executionState).toBeNull();
      expect(enqueueWakeup).not.toHaveBeenCalled();
      const activity = await db
        .select()
        .from(activityLog)
        .where(
          and(
            eq(activityLog.entityId, sourceIssue.id),
            eq(activityLog.action, "issue.stranded_autopolicy_reassigned_to_manager"),
          ),
        );
      expect(activity).toHaveLength(0);
    });

    it("does not hand off to the manager an issue whose idle execution state still holds a cleared monitor, and keeps the monitor's history", async () => {
      // Senior review, round 3: after a monitor is cleared the vendor drops it
      // from a stage-less policy (the policy column is null) but the state
      // keeps `{ status: "idle", monitor: {...} }`. The handoff builds its
      // transition from an empty state, so it would rebuild the monitor from
      // the issue's columns and lose the recorded clear reason and time.
      const { companyId, coderId, sourceIssue } = await seedCompany();
      const idleStateWithClearedMonitor = {
        status: "idle",
        currentStageId: null,
        currentStageIndex: null,
        currentStageType: null,
        currentParticipant: null,
        returnAssignee: null,
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: {
          status: "cleared",
          nextCheckAt: null,
          lastTriggeredAt: null,
          attemptCount: 1,
          notes: "waiting for the external build",
          scheduledBy: "assignee",
          clearedAt: "2026-09-20T10:00:00.000Z",
          clearReason: "manual",
        },
      };
      await db
        .update(issues)
        .set({ executionPolicy: null, executionState: idleStateWithClearedMonitor })
        .where(eq(issues.id, sourceIssue.id));
      await seedStrandedAutoPolicyRetryRun({ companyId, agentId: coderId, issueId: sourceIssue.id, createdAt: new Date() });
      await seedStrandedAutoPolicyRetryRun({ companyId, agentId: coderId, issueId: sourceIssue.id, createdAt: new Date() });
      const enqueueWakeup = vi.fn(async () => null);
      const recovery = recoveryService(db, { enqueueWakeup });

      const [issueWithState] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
      const updated = await recovery.escalateStrandedAssignedIssue({
        issue: issueWithState!,
        previousStatus: "in_progress",
        latestRun: await succeededRun({ companyId, agentId: coderId }),
        recoveryCause: "stranded_assigned_issue",
      });

      // Vendor's own board escalation, no handoff: the state (and with it the
      // monitor's status and clear reason) is exactly what was stored.
      expect(updated?.status).toBe("blocked");
      const [persisted] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
      expect(persisted?.status).toBe("blocked");
      expect(persisted?.assigneeAgentId).toBe(coderId);
      expect(persisted?.executionPolicy).toBeNull();
      expect(persisted?.executionState).toEqual(idleStateWithClearedMonitor);
      const persistedMonitor = (persisted?.executionState as { monitor?: { status?: string; clearReason?: string } } | null)?.monitor;
      expect(persistedMonitor?.status).toBe("cleared");
      expect(persistedMonitor?.clearReason).toBe("manual");
      expect(enqueueWakeup).not.toHaveBeenCalled();
      const activity = await db
        .select()
        .from(activityLog)
        .where(
          and(
            eq(activityLog.entityId, sourceIssue.id),
            eq(activityLog.action, "issue.stranded_autopolicy_reassigned_to_manager"),
          ),
        );
      expect(activity).toHaveLength(0);
    });

    it("does not hand off to the manager a second time after an earlier handoff sent the issue back with changes requested", async () => {
      // Review finding #2: without this guard, every later stranding on the
      // same issue re-triggers a manager handoff (the retry-attempt window
      // is per source run, not per handoff), building a brand-new
      // single-stage policy each time and silently resetting the
      // changes-requested round counter that is supposed to escalate to a
      // human — an unbounded agent<->manager ping-pong.
      const { companyId, managerId, coderId, sourceIssue } = await seedCompany();
      await seedStrandedAutoPolicyRetryRun({ companyId, agentId: coderId, issueId: sourceIssue.id, createdAt: new Date() });
      await seedStrandedAutoPolicyRetryRun({ companyId, agentId: coderId, issueId: sourceIssue.id, createdAt: new Date() });
      const firstEnqueueWakeup = vi.fn(async () => null);
      const recovery = recoveryService(db, { enqueueWakeup: firstEnqueueWakeup });

      const firstHandoff = await recovery.escalateStrandedAssignedIssue({
        issue: sourceIssue,
        previousStatus: "in_progress",
        latestRun: await succeededRun({ companyId, agentId: coderId }),
        recoveryCause: "stranded_assigned_issue",
      });
      expect(firstHandoff?.status).toBe("in_review");
      expect(firstHandoff?.assigneeAgentId).toBe(managerId);

      // The manager requests changes: back to the original assignee,
      // in_progress, same policy, changesRequestedCount now 1 — the decision
      // the manager's PATCH persists (`applyIssueExecutionStageTransition`'s
      // changes-requested branch), applied through the issue service.
      await decideAsManager({
        issueId: sourceIssue.id,
        managerId,
        status: "in_progress",
        comment: "Please add a test for the edge case.",
      });
      const [backWithCoder] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
      expect(backWithCoder?.status).toBe("in_progress");
      expect(backWithCoder?.assigneeAgentId).toBe(coderId);
      expect((backWithCoder?.executionState as { changesRequestedCount?: number } | null)?.changesRequestedCount).toBe(1);

      // The coder runs again, still without a final disposition — a second
      // stranding. The retry cap is exhausted again (two fresh tagged
      // retries), and the manager is still active, so without the guard
      // this would hand the issue to the manager a second time.
      await seedStrandedAutoPolicyRetryRun({ companyId, agentId: coderId, issueId: sourceIssue.id, createdAt: new Date() });
      await seedStrandedAutoPolicyRetryRun({ companyId, agentId: coderId, issueId: sourceIssue.id, createdAt: new Date() });
      const secondEnqueueWakeup = vi.fn(async () => null);
      const secondRecovery = recoveryService(db, { enqueueWakeup: secondEnqueueWakeup });

      const secondHandoffAttempt = await secondRecovery.escalateStrandedAssignedIssue({
        issue: backWithCoder!,
        previousStatus: "in_progress",
        latestRun: await succeededRun({ companyId, agentId: coderId }),
        recoveryCause: "stranded_assigned_issue",
      });

      // Vendor's own board escalation this time, not a second handoff: the
      // policy and its round counter are exactly as the manager's decision
      // left them, and only the one earlier handoff was ever logged.
      expect(secondHandoffAttempt?.status).toBe("blocked");
      expect(secondEnqueueWakeup).not.toHaveBeenCalled();
      const [persisted] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
      expect(persisted?.status).toBe("blocked");
      expect(persisted?.assigneeAgentId).toBe(coderId);
      expect((persisted?.executionState as { changesRequestedCount?: number } | null)?.changesRequestedCount).toBe(1);
      const activity = await db
        .select()
        .from(activityLog)
        .where(
          and(
            eq(activityLog.entityId, sourceIssue.id),
            eq(activityLog.action, "issue.stranded_autopolicy_reassigned_to_manager"),
          ),
        );
      expect(activity).toHaveLength(1);
    });

    it("does not hand a paused assignee's work to the manager or spend a retry, and keeps the vendor's own handling", async () => {
      // Review finding #4: pausing is not stranding. An auto-retry wake here
      // would just throw (paused is not invokable), and (worse, once the
      // retry cap is exhausted and the manager is active) a manager handoff
      // would move the paused agent's work under review over something that
      // is not actually stuck. L4 does nothing of its own for a paused
      // assignee; the vendor's handling of a non-invokable assignee (which
      // its own suite pins, and which still parks the issue behind a board
      // card) is unchanged.
      const { companyId, coderId, sourceIssue } = await seedCompany();
      await db.update(agents).set({ status: "paused" }).where(eq(agents.id, coderId));
      await seedStrandedAutoPolicyRetryRun({ companyId, agentId: coderId, issueId: sourceIssue.id, createdAt: new Date() });
      await seedStrandedAutoPolicyRetryRun({ companyId, agentId: coderId, issueId: sourceIssue.id, createdAt: new Date() });
      const enqueueWakeup = vi.fn(async () => null);
      const recovery = recoveryService(db, { enqueueWakeup });

      await recovery.escalateStrandedAssignedIssue({
        issue: sourceIssue,
        previousStatus: "in_progress",
        latestRun: await succeededRun({ companyId, agentId: coderId }),
        recoveryCause: "stranded_assigned_issue",
      });

      expect(enqueueWakeup).not.toHaveBeenCalled();
      const [persisted] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
      // Never `in_review` under the manager: the source assignee is kept and
      // no execution policy was installed.
      expect(persisted?.status).not.toBe("in_review");
      expect(persisted?.assigneeAgentId).toBe(coderId);
      expect(persisted?.executionPolicy).toBeNull();
      expect(persisted?.executionState).toBeNull();
      for (const action of [
        "issue.stranded_autopolicy_reassigned_to_manager",
        "issue.stranded_autopolicy_retried",
      ]) {
        const activity = await db
          .select()
          .from(activityLog)
          .where(and(eq(activityLog.entityId, sourceIssue.id), eq(activityLog.action, action)));
        expect(activity).toHaveLength(0);
      }
      // The vendor's own board escalation is unchanged for a non-invokable
      // assignee: parked `blocked` behind a board-owned recovery action.
      expect(persisted?.status).toBe("blocked");
      const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
      expect(action).toMatchObject({
        ownerType: "board",
        wakePolicy: expect.objectContaining({ type: "board_escalation" }),
      });
    });
  });

  it("stands down while the latest run was cancelled by a board operator", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "cancelled",
      error: "Cancelled by a board operator",
      errorCode: "cancelled",
      resultJson: { cancelledByActorType: "user", cancelledByUserId: "board-user" },
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.operatorCancelExempted).toBe(1);
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("stands down after an operator interrupt cancellation", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "cancelled",
      error: "Interrupted by board comment",
      errorCode: "operator_interrupted",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.operatorCancelExempted).toBe(1);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("still recovers system-cancelled runs with no operator attribution", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "cancelled",
      error: "Cancelled because the workspace lease expired",
      errorCode: "cancelled",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.operatorCancelExempted).toBe(0);
    expect(result.escalated).toBe(1);
    expect(enqueueWakeup).not.toHaveBeenCalled();
    expect(await db.select().from(issueRecoveryActions)).toEqual([expect.objectContaining({
      cause: "legacy_execution_requires_reconciliation", ownerType: "board", returnOwnerAgentId: coderId,
    })]);
  });

  it("schedules a provider-quota monitor for the original assignee without creating recovery work", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      error: "You've hit your usage limit for GPT-5. Try again at 12:00 AM (UTC).",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.providerQuotaMonitored).toBe(1);
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "in_progress",
      assigneeAgentId: coderId,
      monitorScheduledBy: "assignee",
      monitorNotes: "Provider usage quota reached; retry the original assignee at the provider reset time.",
    });
    expect(updatedIssue?.monitorNextCheckAt).toBeInstanceOf(Date);
    expect(updatedIssue?.executionPolicy).toMatchObject({
      monitor: {
        serviceName: "AI provider quota",
        externalRef: runId,
        maxAttempts: null,
        recoveryPolicy: "wake_owner",
      },
    });
    const [updatedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(updatedRun).toMatchObject({ errorCode: "provider_quota" });
    expect(updatedRun?.resultJson).toMatchObject({ errorFamily: "provider_quota" });
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();

    const secondResult = await recovery.reconcileStrandedAssignedIssues();
    expect(secondResult).toMatchObject({ providerQuotaMonitored: 0, skipped: 1 });
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
  });

  it("schedules another provider-quota monitor after a prior quota monitor fired", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    await db.update(issues).set({ monitorAttemptCount: 1 }).where(eq(issues.id, sourceIssueId));
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      error: "Provider quota exceeded for this model.",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T21:00:00.000Z"),
      finishedAt: new Date("2026-07-15T21:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.providerQuotaMonitored).toBe(1);
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue?.executionPolicy).toMatchObject({
      monitor: {
        maxAttempts: null,
        externalRef: runId,
      },
    });
  });

  it("skips provider-quota monitor scheduling for todo issues without aborting reconciliation", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, sourceIssueId));
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      error: "Provider quota exceeded for this model.",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ providerQuotaMonitored: 0, skipped: 1 });
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "todo",
      assigneeAgentId: coderId,
      monitorNextCheckAt: null,
    });
    const [updatedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(updatedRun?.errorCode).toBe("adapter_failed");
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("does not create takeover recovery when a quota monitor cannot be scheduled", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, sourceIssueId));
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      error: "Provider quota exceeded for this model.",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ providerQuotaMonitored: 0, skipped: 1 });
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "in_review",
      assigneeAgentId: coderId,
      monitorNextCheckAt: null,
    });
    const [updatedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(updatedRun?.errorCode).toBe("adapter_failed");
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("schedules a quota monitor for a cross-agent active review participant", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    const stageId = randomUUID();
    await db.update(issues).set({
      status: "in_review",
      assigneeAgentId: coderId,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: stageId,
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: randomUUID(), type: "agent", agentId: managerId, userId: null }],
        }],
      },
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: managerId, userId: null },
        returnAssignee: { type: "agent", agentId: coderId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    }).where(eq(issues.id, sourceIssueId));
    const [reviewIssueBeforeRecovery] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(reviewIssueBeforeRecovery).toMatchObject({
      assigneeAgentId: coderId,
      executionState: {
        currentParticipant: { type: "agent", agentId: managerId },
        returnAssignee: { type: "agent", agentId: coderId },
      },
    });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: managerId,
      invocationSource: "automation",
      status: "failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      error: "Provider quota exceeded for this model.",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ providerQuotaMonitored: 1, reviewParticipantRequeued: 0 });
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "in_review",
      assigneeAgentId: coderId,
      monitorNextCheckAt: expect.any(Date),
      monitorNotes: "Provider usage quota reached; retry the active review participant after the default recovery backoff.",
    });
    const [updatedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(updatedRun?.errorCode).toBe("provider_quota");
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("does not restamp an in_review quota monitor when the assignee has a newer terminal run", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    const stageId = randomUUID();
    await db.update(issues).set({
      status: "in_review",
      assigneeAgentId: coderId,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: stageId,
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: randomUUID(), type: "agent", agentId: managerId, userId: null }],
        }],
      },
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: managerId, userId: null },
        returnAssignee: { type: "agent", agentId: coderId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    }).where(eq(issues.id, sourceIssueId));
    const participantRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: participantRunId,
      companyId,
      agentId: managerId,
      invocationSource: "automation",
      status: "failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      error: "Provider quota exceeded for this model.",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const firstResult = await recovery.reconcileStrandedAssignedIssues();

    expect(firstResult).toMatchObject({ providerQuotaMonitored: 1 });
    const [monitoredIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    const firstNextCheckAt = monitoredIssue?.monitorNextCheckAt;
    expect(firstNextCheckAt).toBeInstanceOf(Date);
    expect(monitoredIssue?.executionPolicy).toMatchObject({
      monitor: {
        serviceName: "AI provider quota",
        externalRef: participantRunId,
      },
    });

    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: coderId,
      invocationSource: "automation",
      status: "failed",
      error: "Stale assignee wake fired after the issue entered review.",
      errorCode: "issue_assignee_changed",
      startedAt: new Date("2026-07-15T20:02:00.000Z"),
      finishedAt: new Date("2026-07-15T20:03:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });

    const secondResult = await recovery.reconcileStrandedAssignedIssues();

    expect(secondResult).toMatchObject({ providerQuotaMonitored: 0, skipped: 1 });
    const [unchangedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(unchangedIssue?.monitorNextCheckAt?.getTime()).toBe(firstNextCheckAt?.getTime());
    expect(unchangedIssue?.executionPolicy).toMatchObject({
      monitor: {
        serviceName: "AI provider quota",
        externalRef: participantRunId,
      },
    });
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("classifies review recovery from the active participant run instead of a newer assignee run", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    const stageId = randomUUID();
    await db.update(issues).set({
      status: "in_review",
      assigneeAgentId: coderId,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: stageId,
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: randomUUID(), type: "agent", agentId: managerId, userId: null }],
        }],
      },
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: managerId, userId: null },
        returnAssignee: { type: "agent", agentId: coderId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    }).where(eq(issues.id, sourceIssueId));
    const participantRunId = randomUUID();
    const assigneeRunId = randomUUID();
    await db.insert(heartbeatRuns).values([{
      id: participantRunId,
      companyId,
      agentId: managerId,
      invocationSource: "automation",
      status: "failed",
      error: "review process exited unexpectedly",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    }, {
      id: assigneeRunId,
      companyId,
      agentId: coderId,
      invocationSource: "automation",
      status: "failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      error: "You've hit your usage limit. Try again at 11:00 PM (UTC)",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:02:00.000Z"),
      finishedAt: new Date("2026-07-15T20:03:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    }]);
    const enqueueWakeup = vi.fn(async () => ({ id: randomUUID() } as never));
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ providerQuotaMonitored: 0, reviewParticipantRequeued: 0, escalated: 1 });
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "in_review",
      assigneeAgentId: coderId,
      monitorNextCheckAt: null,
    });
    const [assigneeRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, assigneeRunId));
    expect(assigneeRun?.errorCode).toBe("adapter_failed");
    expect(enqueueWakeup).not.toHaveBeenCalled();
    expect(await db.select().from(issueRecoveryActions)).toEqual([expect.objectContaining({
      cause: "legacy_execution_requires_reconciliation", ownerType: "board", returnOwnerAgentId: coderId,
      evidence: expect.objectContaining({ runId: participantRunId }),
    })]);
  });

  it("blocks a cross-agent review participant with incomplete configuration", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    const stageId = randomUUID();
    await db.update(issues).set({
      status: "in_review",
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: stageId,
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: randomUUID(), type: "agent", agentId: managerId, userId: null }],
        }],
      },
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: managerId, userId: null },
        returnAssignee: { type: "agent", agentId: coderId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    }).where(eq(issues.id, sourceIssueId));
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: managerId,
      invocationSource: "automation",
      status: "failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      error: "model_not_found: requested review model does not exist",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => ({ id: randomUUID() } as never));
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ escalated: 1, reviewParticipantRequeued: 0 });
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "blocked",
      assigneeAgentId: coderId,
    });
    const [updatedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(updatedRun?.errorCode).toBe("configuration_incomplete");
    const [action] = await db.select().from(issueRecoveryActions);
    expect(action).toMatchObject({
      sourceIssueId,
      ownerType: "board",
      ownerAgentId: null,
      previousOwnerAgentId: coderId,
      cause: "configuration_incomplete",
      recoveryIssueId: null,
    });
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("uses the default quota backoff when the provider does not state a reset time", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      error: "Provider quota exceeded for this model.",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.providerQuotaMonitored).toBe(1);
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "in_progress",
      assigneeAgentId: coderId,
      monitorNotes: "Provider usage quota reached; retry the original assignee after the default recovery backoff.",
    });
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
  });

  it("classifies model lookup failures as configuration incomplete without waking a recovery owner", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      error: "model_not_found: requested model does not exist",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ escalated: 1, skipped: 0 });
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue?.status).toBe("blocked");
    const [updatedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(updatedRun?.errorCode).toBe("configuration_incomplete");
    const [action] = await db.select().from(issueRecoveryActions);
    expect(action).toMatchObject({
      sourceIssueId,
      cause: "configuration_incomplete",
      recoveryIssueId: null,
    });
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("does not classify stale configuration failures from a non-assignee run", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: managerId,
      invocationSource: "manual",
      status: "failed",
      error: "model_not_found: previous assignee model does not exist",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ escalated: 0, skipped: 1 });
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "in_progress",
      assigneeAgentId: coderId,
    });
    const [updatedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(updatedRun?.errorCode).toBe("adapter_failed");
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("reuses the same source-scoped action when latest run IDs change while the cause stays the same", async () => {
    const { companyId, managerId, coderId, sourceIssue } = await seedCompany();
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const firstLatestRun = {
      id: randomUUID(),
      agentId: coderId,
      status: "failed",
      error: "adapter failed",
      errorCode: "adapter_failed",
      contextSnapshot: { retryReason: "issue_continuation_needed" },
      livenessState: "needs_followup",
    } as const;
    const secondLatestRun = {
      ...firstLatestRun,
      id: randomUUID(),
    };

    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: firstLatestRun,
      comment: "Automatic continuation recovery failed.",
    });
    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: secondLatestRun,
      comment: "Automatic continuation recovery failed.",
    });

    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({
      companyId,
      kind: "stranded_assigned_issue",
      status: "active",
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "stranded_assigned_issue",
      attemptCount: 2,
    });
    expect(actionRows[0]?.evidence).toMatchObject({ latestRunId: secondLatestRun.id });
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("deduplicates workspace-incoherence recovery actions by the typed workspace fingerprint", async () => {
    const { companyId, coderId, sourceIssue } = await seedCompany();
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const workspaceFingerprint = `workspace_incoherence:v1:sha256:${"a".repeat(64)}`;
    const workspaceValidation = {
      reason: "git_worktree_branch_incoherence",
      fingerprint: workspaceFingerprint,
      sourceIssueId: sourceIssue.id,
      sourceIdentifier: sourceIssue.identifier,
      executionWorkspaceId: "execution-workspace-1",
      expectedBranch: "PAP-1-expected",
      actualBranch: "PAP-1-publish",
      cleanliness: "dirty",
      provenance: {
        expectedBranchExists: true,
        actualBranchExists: true,
        expectedHeadSha: "1111111111111111111111111111111111111111",
        actualHeadSha: "2222222222222222222222222222222222222222",
        sameHead: false,
      },
      safeRepair: {
        eligible: false,
        attempted: false,
        succeeded: false,
        reason: "worktree is not clean",
      },
    };
    const firstLatestRun = {
      id: randomUUID(),
      agentId: coderId,
      status: "failed",
      error: "workspace branch mismatch",
      errorCode: "workspace_validation_failed",
      contextSnapshot: {},
      livenessState: "failed",
      resultJson: { workspaceValidation },
    } as const;
    const secondLatestRun = {
      ...firstLatestRun,
      id: randomUUID(),
    };

    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: firstLatestRun,
      comment: "Workspace failed validation.",
      recoveryCause: "workspace_validation_failed",
    });
    // Prove dedupe uses the structured recovery-action reference rather than
    // depending only on the legacy body marker.
    await db
      .update(issueComments)
      .set({ body: "Workspace recovery was already escalated." })
      .where(eq(issueComments.issueId, sourceIssue.id));
    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: secondLatestRun,
      comment: "Workspace failed validation.",
      recoveryCause: "workspace_validation_failed",
    });

    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({
      companyId,
      kind: "workspace_validation",
      cause: "workspace_validation_failed",
      status: "active",
      attemptCount: 2,
      fingerprint: expect.stringContaining(workspaceFingerprint),
      evidence: expect.objectContaining({
        latestRunId: secondLatestRun.id,
        latestRunErrorCode: "workspace_validation_failed",
        workspaceValidation: expect.objectContaining({
          reason: "git_worktree_branch_incoherence",
          fingerprint: workspaceFingerprint,
          sourceIssueId: sourceIssue.id,
          executionWorkspaceId: "execution-workspace-1",
          expectedBranch: "PAP-1-expected",
          actualBranch: "PAP-1-publish",
          cleanliness: "dirty",
        }),
      }),
      nextAction: expect.stringContaining("git worktree branch incoherence"),
      wakePolicy: expect.objectContaining({
        type: "board_escalation",
        reason: "workspace_validation_failed",
        preservesSourceAssignee: true,
      }),
    });

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, sourceIssue.id));
    const escalationComments = comments.filter((comment) =>
      noticeMetadataReferencesRecoveryAction(comment.metadata, actionRows[0]!.id),
    );
    expect(escalationComments).toHaveLength(1);
    expect(escalationComments[0]?.presentation).toMatchObject({
      kind: "system_notice",
      tone: "danger",
      title: "Workspace validation failed",
    });
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("keeps the source issue blocked when source-scoped wakeup is claimed synchronously", async () => {
    const { companyId, managerId, coderId, sourceIssue } = await seedCompany();
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, managerId));
    const enqueueWakeup = vi.fn(async () => {
      await db
        .update(issues)
        .set({ status: "in_progress" })
        .where(eq(issues.id, sourceIssue.id));
      return null;
    });
    const recovery = recoveryService(db, { enqueueWakeup });
    const firstLatestRun = {
      id: randomUUID(),
      agentId: coderId,
      status: "failed",
      error: "adapter failed",
      errorCode: "adapter_failed",
      contextSnapshot: { retryReason: "issue_continuation_needed" },
      livenessState: "needs_followup",
    } as const;

    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: firstLatestRun,
      comment: "Automatic continuation recovery failed.",
    });

    const [afterFirst] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
    expect(afterFirst?.status).toBe("blocked");
    expect(afterFirst?.assigneeAgentId).toBe(coderId);

    const secondLatestRun = {
      ...firstLatestRun,
      id: randomUUID(),
    };
    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: secondLatestRun,
      comment: "Automatic continuation recovery failed.",
    });

    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({
      companyId,
      kind: "stranded_assigned_issue",
      status: "active",
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "stranded_assigned_issue",
      attemptCount: 2,
    });
    const [afterSecond] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
    expect(afterSecond?.status).toBe("blocked");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, sourceIssue.id));
    expect(comments).toHaveLength(1);
    // Dedupe for structured notices is metadata-based: the short body no longer
    // carries the `Recovery action: \`id\`` marker line.
    expect(comments[0]?.body).not.toContain("Recovery action:");
    expect(noticeMetadataReferencesRecoveryAction(comments[0]?.metadata, actionRows[0]!.id)).toBe(true);
    expect(comments[0]?.presentation).toMatchObject({ kind: "system_notice", tone: "danger" });
  });

  it("does not create nested recovery artifacts when issue-backed fallback work itself fails", async () => {
    const { companyId, managerId, sourceIssueId, prefix } = await seedCompany();
    const recoveryIssueId = randomUUID();
    await db.insert(issues).values({
      id: recoveryIssueId,
      companyId,
      title: "Recover stalled issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: managerId,
      parentId: sourceIssueId,
      issueNumber: 2,
      identifier: `${prefix}-2`,
      originKind: "stranded_issue_recovery",
      originId: sourceIssueId,
      originFingerprint: `stranded_issue_recovery:${sourceIssueId}`,
    });
    const [recoveryIssue] = await db.select().from(issues).where(eq(issues.id, recoveryIssueId));
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

    await recovery.escalateStrandedAssignedIssue({
      issue: recoveryIssue!,
      previousStatus: "in_progress",
      latestRun: {
        id: randomUUID(),
        agentId: managerId,
        status: "failed",
        error: "adapter failed",
        errorCode: "adapter_failed",
        contextSnapshot: { retryReason: "issue_continuation_needed" },
        livenessState: "needs_followup",
      },
    });

    const actionRows = await db.select().from(issueRecoveryActions);
    expect(actionRows).toHaveLength(0);
    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveryIssues).toHaveLength(1);
    expect(recoveryIssues[0]?.status).toBe("blocked");
  });

  it("exposes active recovery actions on the issue read API", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "successful_run_missing_issue_disposition",
      fingerprint: "missing-disposition:fingerprint",
      evidence: { sourceRunId: "run-1" },
      nextAction: "Choose a valid issue disposition.",
      wakePolicy: { type: "wake_owner" },
    });
    const app = createApp();

    const detail = await request(app).get(`/api/issues/${sourceIssueId}`).expect(200);
    expect(detail.body.activeRecoveryAction).toMatchObject({
      id: action.id,
      sourceIssueId,
      kind: "missing_disposition",
      ownerAgentId: managerId,
    });

    const list = await request(app).get(`/api/issues/${sourceIssueId}/recovery-actions`).expect(200);
    expect(list.body.active).toMatchObject({ id: action.id });
    expect(list.body.actions).toHaveLength(1);
  });

  it("projects recovery action metadata into the structured wake payload", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    const action = await issueRecoveryActionService(db).upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "workspace_validation",
      ownerType: "agent",
      ownerAgentId: managerId,
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "workspace_validation_failed",
      fingerprint: "workspace:wake-payload",
      evidence: {
        failureSummary: "Worktree branch does not match the pinned branch.",
        routingFallbackReason: null,
      },
      nextAction: "Repair the worktree, then return the issue to the coder.",
      wakePolicy: { type: "wake_owner" },
      maxAttempts: 3,
    });

    const payload = await buildPaperclipWakePayload({
      db,
      companyId,
      contextSnapshot: {
        issueId: sourceIssueId,
        wakeReason: "source_scoped_recovery_action",
        recoveryActionId: action.id,
        recoveryCause: action.cause,
      },
    });

    expect(payload?.recovery).toEqual({
      cause: "workspace_validation_failed",
      failureSummary: "Worktree branch does not match the pinned branch.",
      originalAssignee: { id: coderId, name: "Coder" },
      attemptCount: 1,
      maxAttempts: 3,
      nextAction: "Repair the worktree, then return the issue to the coder.",
      routingFallbackReason: null,
    });
  });

  it("accepts new verified evidence after an automatic no-replay disposition without reopening on duplicate requests", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    const runId = randomUUID();
    await seedHeartbeatRun({ companyId, agentId: coderId, runId, issueId: sourceIssueId, status: "failed" });
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, sourceIssueId));
    const [action] = await db.insert(issueRecoveryActions).values({
      companyId, sourceIssueId, kind: "active_run_watchdog", status: "resolved", outcome: "blocked",
      ownerType: "board", returnOwnerAgentId: coderId, cause: "uncertain_external_action", fingerprint: runId,
      nextAction: "Preserve recorded work without replay.",
      evidence: { runId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } },
    }).returning();
    const app = createApp();
    const body = { actionId: action!.id, outcome: "restored", sourceIssueStatus: "todo",
      executionReconciliation: { runId, providerStopped: true, actionOutcome: "not_performed",
        outcomeEvidence: "Provider receipts confirm the action was never submitted; the stopped process has no remaining effects." } };
    // A retry without new evidence cannot clear the hold or reopen the task.
    await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send({ ...body, executionReconciliation: undefined }).expect(200);
    expect((await db.select().from(issues).where(eq(issues.id, sourceIssueId)))[0]!.status).toBe("blocked");
    const resolved = await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(200);
    expect(resolved.body.issue.status).toBe("todo");
    const [recorded] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action!.id));
    expect(recorded!.evidence).not.toHaveProperty("automaticRecovery");
    expect(recorded!.evidence).toMatchObject({ executionReconciliation: { runId }, continuationDelivery: "pending" });
    await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(200);
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action!.id)))[0]).toEqual(recorded);
  });

  async function seedReconciledDelivery() {
    const fixture = await seedCompany();
    const { companyId, coderId, sourceIssueId } = fixture;
    const responsibleUserId = randomUUID();
    await db.insert(authUsers).values({
      id: responsibleUserId,
      name: "Recovery operator",
      email: `${responsibleUserId}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db
      .update(companies)
      .set({ defaultResponsibleUserId: responsibleUserId })
      .where(eq(companies.id, companyId));
    await db
      .update(agents)
      .set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } })
      .where(eq(agents.id, coderId));
    const previousRunId = randomUUID();
    await seedHeartbeatRun({
      companyId,
      agentId: coderId,
      runId: previousRunId,
      issueId: sourceIssueId,
      status: "failed",
    });
    // Occupy the agent's only dispatch slot, independently of this issue. These
    // tests exercise real wake admission, but cannot launch a provider process.
    await seedHeartbeatRun({
      companyId,
      agentId: coderId,
      runId: randomUUID(),
      status: "running",
    });
    const [action] = await db
      .insert(issueRecoveryActions)
      .values({
        companyId,
        sourceIssueId,
        kind: "active_run_watchdog",
        status: "resolved",
        outcome: "restored",
        ownerType: "board",
        returnOwnerAgentId: coderId,
        cause: "uncertain_external_action",
        fingerprint: previousRunId,
        nextAction: "Continue from the verified reconciliation.",
        evidence: {
          runId: previousRunId,
          continuationDelivery: "pending",
          executionReconciliation: {
            runId: previousRunId,
            providerStopped: true,
            actionOutcome: "not_performed",
            outcomeEvidence: "Verified absent provider effect.",
          },
        },
      })
      .returning();
    return {
      ...fixture,
      previousRunId,
      action: action!,
      heartbeat: heartbeatService(db, { runtimeEnv: {} }),
    };
  }

  it("delivers a reconciled execution once across concurrent sweeps without a deferred duplicate", async () => {
    const { action, heartbeat } = await seedReconciledDelivery();
    let entered = 0;
    let release!: () => void;
    const bothEntered = new Promise<void>((resolve) => {
      release = resolve;
    });
    const wake: typeof heartbeat.wakeup = async (...args) => {
      entered += 1;
      if (entered === 2) release();
      await bothEntered;
      return heartbeat.wakeup(...args);
    };
    await Promise.all([
      deliverReconciledExecutions(db, wake),
      deliverReconciledExecutions(db, wake),
    ]);
    const wakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        eq(
          agentWakeupRequests.idempotencyKey,
          `execution-reconciliation:${action.id}`,
        ),
      );
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ status: "queued" });
    const [receipt] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(receipt!.evidence).toMatchObject({
      continuationDelivery: "delivered",
      continuationRunId: wakes[0]!.runId,
    });
  });

  it("reconciles a lost wake acknowledgement after the exact successor has already finished", async () => {
    const { action, heartbeat, companyId, previousRunId } =
      await seedReconciledDelivery();
    let successorId: string | undefined;
    await deliverReconciledExecutions(db, async (...args) => {
      const run = await heartbeat.wakeup(...args);
      expect(run).not.toBeNull();
      successorId = run!.id;
      expect(run!.retryOfRunId).toBe(previousRunId);
      throw new Error("fixture lost post-commit wake acknowledgement");
    });
    expect(successorId).toBeDefined();
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, successorId!));
    await deliverReconciledExecutions(db, heartbeat.wakeup);
    const wakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        eq(
          agentWakeupRequests.idempotencyKey,
          `execution-reconciliation:${action.id}`,
        ),
      );
    expect(wakes).toHaveLength(1);
    const [successor] = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.id, successorId!),
        ),
      );
    expect(successor).toMatchObject({
      status: "succeeded",
      retryOfRunId: previousRunId,
    });
    const [receipt] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(receipt!.evidence).toMatchObject({
      continuationDelivery: "delivered",
      continuationRunId: successorId,
    });
  });

  it.each(["owner", "status", "decision"] as const)(
    "rechecks the current reconciliation %s after the sweep read",
    async (changed) => {
      const { action, heartbeat, sourceIssueId, managerId } =
        await seedReconciledDelivery();
      await deliverReconciledExecutions(db, async (...args) => {
        if (changed === "owner")
          await db
            .update(issues)
            .set({ assigneeAgentId: managerId })
            .where(eq(issues.id, sourceIssueId));
        if (changed === "status")
          await db
            .update(issues)
            .set({ status: "done" })
            .where(eq(issues.id, sourceIssueId));
        if (changed === "decision")
          await db
            .update(issueRecoveryActions)
            .set({
              evidence: {
                ...action.evidence,
                executionReconciliation: {
                  ...(action.evidence.executionReconciliation as object),
                  runId: randomUUID(),
                },
              },
            })
            .where(eq(issueRecoveryActions.id, action.id));
        return heartbeat.wakeup(...args);
      });
      expect(
        await db
          .select()
          .from(agentWakeupRequests)
          .where(
            eq(
              agentWakeupRequests.idempotencyKey,
              `execution-reconciliation:${action.id}`,
            ),
          ),
      ).toHaveLength(0);
      const [receipt] = await db
        .select()
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.id, action.id));
      expect(receipt!.evidence.continuationDelivery).toBe("pending");
    },
  );

  it("keeps reconciliation pending behind unrelated issue work without creating a second deferred outbox", async () => {
    const { action, heartbeat, sourceIssueId, companyId, coderId } =
      await seedReconciledDelivery();
    const occupiedRunId = randomUUID();
    await seedHeartbeatRun({
      companyId,
      agentId: coderId,
      runId: occupiedRunId,
      issueId: sourceIssueId,
      status: "queued",
    });
    await deliverReconciledExecutions(db, heartbeat.wakeup);
    await deliverReconciledExecutions(db, heartbeat.wakeup);
    expect(
      await db
        .select()
        .from(agentWakeupRequests)
        .where(
          eq(
            agentWakeupRequests.idempotencyKey,
            `execution-reconciliation:${action.id}`,
          ),
        ),
    ).toHaveLength(0);
    const [occupied] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, occupiedRunId));
    expect(occupied!.contextSnapshot).toEqual({ issueId: sourceIssueId });
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, occupiedRunId));
    await deliverReconciledExecutions(db, heartbeat.wakeup);
    const wakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        eq(
          agentWakeupRequests.idempotencyKey,
          `execution-reconciliation:${action.id}`,
        ),
      );
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.runId).not.toBe(occupiedRunId);
  });

  it("does not overwrite a newer reconciliation decision after a prior wake commits", async () => {
    const { action, heartbeat } = await seedReconciledDelivery();
    const newerEvidence = {
      ...action.evidence,
      continuationDelivery: "invalidated",
      operatorNote: "Do not continue after new evidence.",
    };
    await deliverReconciledExecutions(db, async (...args) => {
      const run = await heartbeat.wakeup(...args);
      expect(run).not.toBeNull();
      await db
        .update(issueRecoveryActions)
        .set({ evidence: newerEvidence })
        .where(eq(issueRecoveryActions.id, action.id));
      return run;
    });
    const [receipt] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(receipt!.evidence).toEqual(newerEvidence);
  });

  it("resolves an active recovery action and removes it from active projections", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "successful_run_missing_issue_disposition",
      fingerprint: "missing-disposition:fingerprint",
      evidence: { sourceRunId: "run-1" },
      nextAction: "Choose a valid issue disposition.",
      wakePolicy: { type: "wake_owner" },
    });
    const app = createApp();

    const resolved = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "done",
        resolutionNote: "Operator confirmed the source issue is complete.",
      })
      .expect(200);

    expect(resolved.body.issue).toMatchObject({
      id: sourceIssueId,
      status: "done",
      activeRecoveryAction: null,
    });
    expect(resolved.body.recoveryAction).toMatchObject({
      id: action.id,
      status: "resolved",
      outcome: "owner_completed",
      resolutionNote: "Operator confirmed the source issue is complete.",
    });
    expect(resolved.body.recoveryAction.resolvedAt).toBeTruthy();
    expect(await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId)).toBeNull();
    expect(
      await db
        .select()
        .from(issueInboxArchives)
        .where(eq(issueInboxArchives.issueId, sourceIssueId)),
    ).toHaveLength(1);

    const detail = await request(app).get(`/api/issues/${sourceIssueId}`).expect(200);
    expect(detail.body.activeRecoveryAction).toBeNull();

    const activityRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, sourceIssueId));
    expect(activityRows.map((row) => row.action)).toEqual(
      expect.arrayContaining(["issue.updated", "issue.recovery_action_resolved"]),
    );
  });

  it("hands restored work back to the recorded return owner and records the outcome", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "blocked", assigneeAgentId: coderId })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "workspace_validation",
      ownerType: "agent",
      ownerAgentId: managerId,
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "workspace_validation_failed",
      fingerprint: "workspace:fingerprint",
      evidence: { latestRunId: "run-1" },
      nextAction: "Repair the workspace and hand the issue back.",
      wakePolicy: { type: "wake_owner" },
    });

    const enqueueRecoveryActionWakeup = vi.fn(async () => null);
    const resolved = await request(createApp(undefined, {
      recoveryActionEnqueueWakeup: enqueueRecoveryActionWakeup,
    }))
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "todo",
        resolutionNote: "Workspace repaired.",
      })
      .expect(200);

    expect(resolved.body.issue).toMatchObject({
      id: sourceIssueId,
      status: "todo",
      assigneeAgentId: coderId,
      activeRecoveryAction: null,
    });
    expect(resolved.body.recoveryAction).toMatchObject({
      id: action.id,
      status: "resolved",
      outcome: "handed_back",
    });
    expect(enqueueRecoveryActionWakeup).toHaveBeenCalledWith(
      coderId,
      expect.objectContaining({
        reason: "issue_recovery_action_restored",
        payload: expect.objectContaining({ issueId: sourceIssueId, recoveryActionId: action.id }),
      }),
    );
  });

  it("does not enqueue a restored wake when todo status and assignee are unchanged", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "todo", assigneeAgentId: coderId })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "workspace_validation",
      ownerType: "agent",
      ownerAgentId: managerId,
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "workspace_validation_failed",
      fingerprint: "workspace:already-restored",
      evidence: { latestRunId: "run-1" },
      nextAction: "Confirm the workspace remains healthy.",
      wakePolicy: { type: "wake_owner" },
    });

    const enqueueRecoveryActionWakeup = vi.fn(async () => null);
    await request(createApp(undefined, {
      recoveryActionEnqueueWakeup: enqueueRecoveryActionWakeup,
    }))
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "todo",
        resolutionNote: "Workspace was already restored.",
      })
      .expect(200);

    expect(enqueueRecoveryActionWakeup).not.toHaveBeenCalled();
  });

  it("resolves an active recovery action by returning the source issue to todo", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "blocked", assigneeAgentId: null, assigneeUserId: "board-user" })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:try-again",
      evidence: { latestIssueStatus: "blocked" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    const resolved = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "todo",
        resolutionNote: "Try the source issue again.",
      })
      .expect(200);

    expect(resolved.body.issue).toMatchObject({
      id: sourceIssueId,
      status: "todo",
      activeRecoveryAction: null,
    });
    expect(resolved.body.recoveryAction).toMatchObject({
      id: action.id,
      status: "resolved",
      outcome: "restored",
      resolutionNote: "Try the source issue again.",
    });
    expect(await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId)).toBeNull();
  });

  it("marks a recovery action stale when a blocked source issue is manually moved to todo", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "blocked", assigneeAgentId: null, assigneeUserId: "board-user" })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:manual-restore",
      evidence: { latestIssueStatus: "blocked" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    const patched = await request(app)
      .patch(`/api/issues/${sourceIssueId}`)
      .send({ status: "todo" })
      .expect(200);

    expect(patched.body).toMatchObject({
      id: sourceIssueId,
      status: "todo",
      activeRecoveryAction: null,
    });

    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({
      status: "cancelled",
      outcome: "cancelled",
      resolutionNote: "Recovery action became stale because the source issue was manually moved from blocked to todo.",
    });
    expect(actionRow?.resolvedAt).toBeTruthy();
    expect(await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId)).toBeNull();

    const detail = await request(app).get(`/api/issues/${sourceIssueId}`).expect(200);
    expect(detail.body.activeRecoveryAction).toBeNull();

    const activityRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, sourceIssueId));
    expect(activityRows.map((row) => row.action)).toEqual(
      expect.arrayContaining(["issue.updated", "issue.recovery_action_resolved"]),
    );
    expect(activityRows.find((row) => row.action === "issue.recovery_action_resolved")?.details).toMatchObject({
      source: "source_revalidation",
      trigger: "issue_update",
    });
  });

  it("folds stale recovery during read projection after the source issue reaches done", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:done-projection",
      evidence: { latestIssueStatus: "in_progress" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, sourceIssueId));
    const app = createApp();

    const detail = await request(app).get(`/api/issues/${sourceIssueId}`).expect(200);

    expect(detail.body).toMatchObject({
      id: sourceIssueId,
      status: "done",
      activeRecoveryAction: null,
    });
    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({
      status: "cancelled",
      outcome: "cancelled",
      resolutionNote: "Recovery action became stale because the source issue reached done.",
    });
    expect(actionRow?.resolvedAt).toBeTruthy();

    const activityRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, sourceIssueId));
    expect(activityRows.find((row) => row.action === "issue.recovery_action_resolved")?.details).toMatchObject({
      source: "source_revalidation",
      trigger: "read_projection",
      recoveryActionId: action.id,
    });
  });

  it("keeps active recovery visible when a plain comment does not create a live path", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ assigneeAgentId: null, assigneeUserId: "board-user" })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:plain-comment",
      evidence: { latestIssueStatus: "in_progress" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    await request(app)
      .post(`/api/issues/${sourceIssueId}/comments`)
      .send({ body: "I am looking at this, but not changing the disposition." })
      .expect(201);

    expect(await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId)).toMatchObject({
      id: action.id,
      status: "active",
    });
    const detail = await request(app).get(`/api/issues/${sourceIssueId}`).expect(200);
    expect(detail.body.activeRecoveryAction).toMatchObject({ id: action.id });
  });

  it("folds stale recovery when a structured resume comment restores todo dispatch", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "blocked", assigneeAgentId: null, assigneeUserId: "board-user" })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:resume-comment",
      evidence: { latestIssueStatus: "blocked" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    await request(app)
      .post(`/api/issues/${sourceIssueId}/comments`)
      .send({ body: "Resume this now.", resume: true })
      .expect(201);

    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(sourceIssue?.status).toBe("todo");
    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({
      status: "cancelled",
      outcome: "cancelled",
      resolutionNote: "Recovery action became stale because the source issue was manually moved from blocked to todo.",
    });
    expect(await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId)).toBeNull();

    const activityRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, sourceIssueId));
    expect(activityRows.find((row) => row.action === "issue.recovery_action_resolved")?.details).toMatchObject({
      source: "source_revalidation",
      trigger: "comment",
      recoveryActionId: action.id,
    });
  });

  it("rejects peer-agent source issue updates that would hide another owner's recovery action", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "blocked", assigneeAgentId: null, assigneeUserId: "board-user" })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:peer-status-update",
      evidence: { latestIssueStatus: "blocked" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp({
      type: "agent",
      agentId: coderId,
      companyId,
      runId: randomUUID(),
      source: "agent_jwt",
    });

    await request(app)
      .patch(`/api/issues/${sourceIssueId}`)
      .send({ status: "todo" })
      .expect(403);

    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(sourceIssue?.status).toBe("blocked");
    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({
      status: "active",
      outcome: null,
      resolvedAt: null,
    });
  });

  it("rejects peer-agent recovery action resolution on a board-owned source issue", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "blocked", assigneeAgentId: null, assigneeUserId: "board-user" })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:peer-resolution",
      evidence: { latestIssueStatus: "blocked" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp({
      type: "agent",
      agentId: coderId,
      companyId,
      runId: randomUUID(),
      source: "agent_jwt",
    });

    await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "done",
        resolutionNote: "Peer agent should not be able to clear this recovery.",
      })
      .expect(403);

    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(sourceIssue?.status).toBe("blocked");
    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({
      status: "active",
      outcome: null,
      resolvedAt: null,
    });
  });

  it("keeps the named recovery owner from completing a board-owned source issue", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "blocked", assigneeAgentId: null, assigneeUserId: "board-user" })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:owner-resolution",
      evidence: { latestIssueStatus: "blocked" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    const runId = randomUUID();
    const app = createApp({
      type: "agent",
      agentId: managerId,
      companyId,
      runId,
      source: "agent_jwt",
    });
    await seedHeartbeatRun({
      companyId,
      agentId: managerId,
      runId,
      issueId: sourceIssueId,
    });

    const resolved = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "done",
        resolutionNote: "Recovery owner verified the work was intentionally completed.",
      })
      .expect(403);

    expect(resolved.body.details?.code).toBe("recovery_source_authority_required");
    const [sourceAfter, actionAfter] = await Promise.all([
      db.select().from(issues).where(eq(issues.id, sourceIssueId)).then((rows) => rows[0]),
      db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id)).then((rows) => rows[0]),
    ]);
    expect(sourceAfter).toMatchObject({ status: "blocked", assigneeUserId: "board-user" });
    expect(actionAfter).toMatchObject({ status: "active", outcome: null });
  });

  it("rejects blocked recovery resolution when the source issue has no first-class blockers", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:blocked-without-blocker",
      evidence: { latestIssueStatus: "in_progress" },
      nextAction: "Choose a disposition with a live continuation path.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    const rejected = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "blocked",
        sourceIssueStatus: "blocked",
      })
      .expect(422);

    expect(rejected.body.error).toContain("requires an unresolved first-class blocker");

    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(sourceIssue?.status).toBe("in_progress");

    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({
      status: "active",
      outcome: null,
      resolvedAt: null,
    });
  });

  it("allows blocked recovery resolution when the source issue has an unresolved first-class blocker", async () => {
    const { companyId, managerId, sourceIssueId, prefix } = await seedCompany();
    const blockerIssueId = randomUUID();
    await db.insert(issues).values({
      id: blockerIssueId,
      companyId,
      title: "Unblock recovery disposition",
      status: "todo",
      priority: "medium",
      assigneeAgentId: managerId,
      issueNumber: 2,
      identifier: `${prefix}-2`,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: sourceIssueId,
      type: "blocks",
    });
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:blocked-with-blocker",
      evidence: { latestIssueStatus: "in_progress" },
      nextAction: "Wait for the blocker before continuing.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    const resolved = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "blocked",
        sourceIssueStatus: "blocked",
        resolutionNote: "The source issue is explicitly blocked by a follow-up.",
      })
      .expect(200);

    expect(resolved.body.issue).toMatchObject({
      id: sourceIssueId,
      status: "blocked",
      activeRecoveryAction: null,
    });
    expect(resolved.body.recoveryAction).toMatchObject({
      id: action.id,
      status: "resolved",
      outcome: "blocked",
      resolutionNote: "The source issue is explicitly blocked by a follow-up.",
    });
    expect(await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId)).toBeNull();
  });

  it("rejects false-positive recovery resolution without an explicit source issue status", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:fingerprint",
      evidence: { latestIssueStatus: "in_progress" },
      nextAction: "Confirm whether the issue is actually stranded.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "false_positive",
        resolutionNote: "The source issue still has a live execution path.",
      })
      .expect(400);

    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(sourceIssue?.status).toBe("in_progress");

    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({
      status: "active",
      outcome: null,
      resolutionNote: null,
    });
  });

  it("allows false-positive recovery resolution to restore a blocked source issue in the same request", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:false-positive-unblock",
      evidence: { latestIssueStatus: "blocked" },
      nextAction: "Confirm whether the issue is actually stranded.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    const resolved = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "false_positive",
        sourceIssueStatus: "in_review",
        resolutionNote: "Recovery signal was stale; return to review.",
      })
      .expect(200);

    expect(resolved.body.issue).toMatchObject({
      id: sourceIssueId,
      status: "in_review",
      activeRecoveryAction: null,
    });
    expect(resolved.body.recoveryAction).toMatchObject({
      id: action.id,
      status: "resolved",
      outcome: "false_positive",
      resolutionNote: "Recovery signal was stale; return to review.",
    });
  });

  it("enforces company scope when resolving recovery actions", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "successful_run_missing_issue_disposition",
      fingerprint: "missing-disposition:fingerprint",
      evidence: { sourceRunId: "run-1" },
      nextAction: "Choose a valid issue disposition.",
      wakePolicy: { type: "wake_owner" },
    });
    const app = createApp({
      type: "agent",
      agentId: randomUUID(),
      companyId: randomUUID(),
      runId: randomUUID(),
      source: "agent_jwt",
    });

    await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "done",
      })
      .expect(404);

    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow?.status).toBe("active");
  });
});
