import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { agents, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { HttpError } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { parseObject, readNonEmptyString } from "../modules/wake-queue/domain/values.js";
import {
  infraInterruptAttemptCount,
  INFRA_INTERRUPT_CONTEXT_ATTEMPT_KEY,
  isInfraInterruptErrorCode,
} from "./infra-interrupts.js";

/**
 * Operator pause drains instead of cancelling (L3).
 *
 * The vendor's pause always cancels every active run of the paused agent
 * with error code "agent_paused". Our legacy-execution reconciliation treats
 * an "agent_paused" cancellation the same as any other unreconciled provider
 * outcome: it locks the task behind a board decision within 15s
 * (`legacyExecutionNeedsReconciliation`, `settleUnrecoverableExecutions` in
 * `server/src/services/legacy-execution-recovery.ts` and
 * `execution-recovery-resolution.ts`). For us, pausing an agent means "stop
 * giving it new work", not "abort whatever it is doing" — a mass pause
 * (deploy, night, budget check) should not manufacture a wall of red cards.
 *
 * `MYRMIDON_PAUSE_DRAINS` (default on) makes the operator pause route
 * (`POST /api/agents/:id/pause`) let active runs finish on their own instead
 * of cancelling them. A request that explicitly asks for the old behavior
 * (`cancelActive: true` in the body, or `?force=1`) still cancels immediately,
 * same as the setting turned off. System-initiated pauses (budget exceeded,
 * company archived, agent offboarding/import) never call the agent pause
 * route; they keep calling their own cancellation paths directly
 * (`services/budgets.ts` cancelBudgetScopeWork, `services/companies.ts`
 * archive cascade) and are unaffected by this setting.
 *
 * This module also holds `isSkippableStartupRecoveryConflict` (part c): the
 * predicate `recoverActiveSessionGoals`/`recoverPendingSessionGoalActions`
 * use to skip a session goal whose `enqueueWakeup` call 409s — for an
 * unavailable agent or a budget hard-stop — instead of crashing server
 * startup for every other agent on the instance.
 */
export const PAUSE_DRAINS_ENV = "MYRMIDON_PAUSE_DRAINS";

const DISABLED_VALUES = new Set(["0", "false", "off", "no"]);

/** Unset, empty or anything but an explicit "off" value enables draining. */
export function readPauseDrainsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[PAUSE_DRAINS_ENV]?.trim().toLowerCase();
  if (!raw) return true;
  return !DISABLED_VALUES.has(raw);
}

/**
 * True if the pause request itself asked to cancel active runs right away
 * (`{cancelActive: true}` in the body, or `?force=1`/`?force=true`).
 * `forceQueryParam` takes whatever the router's `req.query.force` reads as
 * (string, array or absent) without depending on Express's query types.
 */
export function readCancelActiveRequested(input: { body?: unknown; forceQueryParam?: unknown }): boolean {
  if (parseObject(input.body).cancelActive === true) return true;
  const force = Array.isArray(input.forceQueryParam) ? input.forceQueryParam[0] : input.forceQueryParam;
  return force === "1" || force === "true";
}

/**
 * Whether an operator pause should cancel the agent's active runs now
 * instead of letting them drain. Pure decision, no I/O: the setting and the
 * request are both read by the caller (the pause route) beforehand.
 */
export function shouldCancelActiveRunsOnOperatorPause(options: {
  drainsEnabled: boolean;
  cancelActiveRequested: boolean;
}): boolean {
  return !options.drainsEnabled || options.cancelActiveRequested;
}

/**
 * True for the 409 that `enqueueWakeup` throws when the target agent cannot
 * be invoked right now (paused, terminated, pending approval, a broken
 * reporting chain — see `AgentInvokabilityBlockReason` in
 * `services/agent-invokability.ts`). Matches on the conflict's own details
 * shape (`{status, reason}`) rather than the reason list, so a new
 * invokability reason does not need a matching update here.
 */
export function isAgentNotInvokableConflict(err: unknown): boolean {
  if (!(err instanceof HttpError) || err.status !== 409) return false;
  const details = err.details as { reason?: unknown; status?: unknown } | undefined;
  return typeof details?.reason === "string" && typeof details?.status === "string";
}

const BUDGET_BLOCK_SCOPE_TYPES = new Set(["company", "agent", "project"]);

/**
 * True for the other 409 `enqueueWakeup` throws before it even checks
 * invokability: a company/agent/project budget hard-stop
 * (`budgets.getInvocationBlock`). Its details shape (`{scopeType, scopeId}`)
 * has no `reason`/`status` string pair — the block's human-readable reason is
 * the HttpError *message*, not a details field — so
 * `isAgentNotInvokableConflict` never matches it. A company-wide budget pause
 * is independent of any individual agent's own status, so this fires even for
 * agents that are not themselves paused.
 */
export function isBudgetBlockConflict(err: unknown): boolean {
  if (!(err instanceof HttpError) || err.status !== 409) return false;
  const details = err.details as
    | { scopeType?: unknown; scopeId?: unknown; reason?: unknown; status?: unknown }
    | undefined;
  const scopeType = details?.scopeType;
  return (
    typeof scopeType === "string" &&
    BUDGET_BLOCK_SCOPE_TYPES.has(scopeType) &&
    typeof details?.scopeId === "string" &&
    typeof details?.reason !== "string" &&
    typeof details?.status !== "string"
  );
}

/**
 * True for any 409 that startup session-goal recovery should skip-and-log
 * instead of letting it crash the process: the agent cannot be invoked right
 * now, or a budget hard-stop blocks it. Both are transient, per-agent/
 * per-scope conditions un-fixable by a restart — not a reason to take the
 * whole server down. Covers the exact failure mode point (c) of this PR
 * closed for the invokability 409 ("server restarted 4 times on the 1.0.0
 * rollout"), reproduced with a budget-paused company instead of a paused
 * agent.
 */
export function isSkippableStartupRecoveryConflict(err: unknown): boolean {
  return isAgentNotInvokableConflict(err) || isBudgetBlockConflict(err);
}

const LIVE_HEARTBEAT_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
const WAKEABLE_ISSUE_STATUSES = ["todo", "in_progress"] as const;
const RESUME_WAKE_IDEMPOTENCY_PREFIX = "pause_resume";

export interface ResumeAgentAfterPauseDeps {
  db: Db;
  /** Existing queued-run promotion for one agent (heartbeat.ts). */
  startNextQueuedRunForAgent: (agentId: string) => Promise<unknown[]>;
  /** Existing wakeup admission path (heartbeat.ts); creates a queued run. */
  enqueueWakeup: (
    agentId: string,
    opts: {
      source?: "automation";
      triggerDetail?: "system";
      reason?: string;
      idempotencyKey?: string;
      requestedByActorType?: "system";
      requestedByActorId?: string;
      contextSnapshot?: Record<string, unknown>;
    },
  ) => Promise<unknown>;
}

export interface ResumeAgentAfterPauseResult {
  queuedRunsPromoted: number;
  strandedIssuesWoken: number;
}

/**
 * Called once, right after an operator resumes a paused agent (L3, part b).
 * A drained pause never cancelled anything, so nothing here retries a
 * failure — it only wakes work that pause-as-drain left sitting idle:
 *
 * 1. Runs the agent already had `queued` — promoted through the normal
 *    admission path, same as any other queued-run promotion.
 * 2. Issues assigned to the agent (`todo`/`in_progress`) that have no live
 *    heartbeat run at all — stranded because the agent could not be
 *    dispatched while paused, so nothing ever queued a run for them.
 *
 * Idempotent by construction, not by a stored dedup key: a queued run is
 * promoted through the same admission checks a scheduler tick would use, and
 * a stranded issue is only ever woken while it truly has no live run — once
 * that wake lands a `queued`/`running`/`scheduled_retry` heartbeat run, a
 * later call (a repeated resume, or one racing this one) sees the issue as
 * no longer stranded and leaves it alone. The idempotency key handed to
 * `enqueueWakeup` is for tracing only; it is not a uniqueness constraint the
 * database enforces for this prefix.
 */
export async function resumeAgentAfterPause(
  deps: ResumeAgentAfterPauseDeps,
  agentId: string,
): Promise<ResumeAgentAfterPauseResult> {
  const agent = await deps.db
    .select({ companyId: agents.companyId })
    .from(agents)
    .where(eq(agents.id, agentId))
    .then((rows) => rows[0] ?? null);
  if (!agent) return { queuedRunsPromoted: 0, strandedIssuesWoken: 0 };
  const companyId = agent.companyId;

  const promoted = await deps.startNextQueuedRunForAgent(agentId);

  const [assigned, liveRuns] = await Promise.all([
    deps.db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.assigneeAgentId, agentId),
          inArray(issues.status, [...WAKEABLE_ISSUE_STATUSES]),
        ),
      ),
    deps.db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.agentId, agentId),
          inArray(heartbeatRuns.status, [...LIVE_HEARTBEAT_RUN_STATUSES]),
        ),
      ),
  ]);

  const liveIssueIds = new Set(
    liveRuns
      .map((run) => readNonEmptyString(parseObject(run.contextSnapshot).issueId))
      .filter((id): id is string => Boolean(id)),
  );

  let strandedIssuesWoken = 0;
  for (const issue of assigned) {
    if (liveIssueIds.has(issue.id)) continue;
    const idempotencyKey = `${RESUME_WAKE_IDEMPOTENCY_PREFIX}:${issue.id}`;
    // myrmidon(L1): carries the shared infra-interrupt retry budget forward
    // across this pause/resume cycle. This wake creates a brand-new
    // heartbeat run rather than a scheduled retry of the run the pause
    // cancelled, so heartbeat_runs.scheduledRetryAttempt (which defaults to
    // 0 on the new row) cannot carry the budget on its own -- read it off
    // the stranded run this issue is actually resuming from instead, and
    // carry it into the new run's contextSnapshot (infra-interrupts.ts's
    // infraInterruptAttemptCount reads it back from there). Once enough
    // cycles have gone by, the carried count reaches the shared budget and
    // shouldSkipReconciliationForInfraInterrupt stops suppressing the
    // vendor's hold.
    const priorRun = await deps.db
      .select({
        errorCode: heartbeatRuns.errorCode,
        scheduledRetryAttempt: heartbeatRuns.scheduledRetryAttempt,
        scheduledRetryReason: heartbeatRuns.scheduledRetryReason,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.agentId, agentId),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`,
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    const infraInterruptAttempt =
      priorRun && isInfraInterruptErrorCode(priorRun.errorCode)
        ? infraInterruptAttemptCount(priorRun) + 1
        : null;
    try {
      await deps.enqueueWakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "pause_resume",
        idempotencyKey,
        requestedByActorType: "system",
        requestedByActorId: "pause_resume",
        contextSnapshot: {
          issueId: issue.id,
          taskKey: issue.id,
          resumeIntent: true,
          ...(infraInterruptAttempt !== null
            ? { [INFRA_INTERRUPT_CONTEXT_ATTEMPT_KEY]: infraInterruptAttempt }
            : {}),
        },
      });
      strandedIssuesWoken += 1;
    } catch (err) {
      // Best-effort: one issue that a concurrent resume, wakeup coalescing or
      // an execution blocker rejects is not a reason to fail the others.
      logger.warn({ err, agentId, issueId: issue.id }, "pause-resume wake failed for a stranded assigned issue");
    }
  }

  return { queuedRunsPromoted: promoted.length, strandedIssuesWoken };
}
