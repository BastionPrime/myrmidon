// myrmidon(L2, round 3 fix): cancels a run of the woken agent that is still
// waiting in the queue (queued, or scheduled_retry) for an issue whose settled
// "do not replay" hold an explicitly authorized wake is about to bypass.
//
// Why this is needed. Such a wake is admitted only by the bypass
// (wake-classification.ts, explicit-wake-gate.ts). The waiting run is the
// vendor's, and its own claim is the vendor's plain check: it meets the hold
// and cancels itself as `execution_reconciliation_required` (run-dispatch's
// cancelStaleQueuedRun; a scheduled retry is promoted to queued first, which
// does not look at the hold, and is cancelled by the same claim). Merging the
// wake into that run, or parking it behind it, therefore loses the wake with
// the run. Deferring it without a durable wake (round 2) only recorded a
// skipped receipt that nothing ever turned into a run. So the admission
// retires the waiting run itself, in its own transaction under the issue lock,
// and creates the successor run in that same transaction
// (supersede-explicit-wake.ts).
//
// The write mirrors run-dispatch's `cancelStaleRunInTx` field for field (that
// function is private to the vendor's adapter and takes the issue and run
// locks itself, so it cannot be called from inside the admission transaction,
// which already holds the issue lock): same status, error code, result stop
// reason, wakeup-request outcome, execution-lock release and lifecycle event,
// and the same post-commit status effect for the caller to apply once the
// transaction has committed.
import { and, eq } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { deriveCommentId } from "../../modules/run-dispatch/domain/wake-context.js";
import type { PostCommitEffect } from "../../modules/run-dispatch/index.js";
import { getExecutionBlocker } from "../../services/execution-blocker.js";
import { appendHeartbeatRunEvent } from "../../services/heartbeat-run-events.js";
import { parseObject, readNonEmptyString } from "../../modules/wake-queue/domain/values.js";
import { INFRA_INTERRUPT_CONTEXT_ATTEMPT_KEY, infraInterruptAttemptCount } from "../infra-interrupts.js";

type HeartbeatRun = typeof heartbeatRuns.$inferSelect;

/** The only statuses in which a run has not started and can still be retired. */
const WAITING_STATUSES = ["queued", "scheduled_retry"] as const;
type WaitingStatus = (typeof WAITING_STATUSES)[number];

function isWaitingStatus(status: string): status is WaitingStatus {
  return (WAITING_STATUSES as readonly string[]).includes(status);
}

export type CancelWaitingRunOutcome =
  /** Not waiting (running, terminal), or no hold would cancel it at its claim: nothing was written. */
  | { outcome: "not_doomed" }
  /** The run left its waiting status while this decision was being made; nothing was written. */
  | { outcome: "lost_race" }
  | {
      outcome: "cancelled";
      /** The cancelled row as written. */
      run: HeartbeatRun;
      reason: string;
      errorCode: "execution_reconciliation_required";
      /** Apply after the caller's transaction has committed (never before). */
      postCommitEffects: PostCommitEffect[];
    };

const CANCEL_ERROR_CODE = "execution_reconciliation_required" as const;

function statusEffect(run: HeartbeatRun, previousStatus: string): PostCommitEffect {
  const context = parseObject(run.contextSnapshot);
  return {
    kind: "run_status_published",
    companyId: run.companyId,
    runId: run.id,
    agentId: run.agentId,
    status: run.status,
    invocationSource: run.invocationSource,
    triggerDetail: run.triggerDetail,
    error: run.error,
    errorCode: run.errorCode,
    contextSource: readNonEmptyString(context.source),
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    result: parseObject(run.resultJson),
    issueId: readNonEmptyString(context.issueId),
    previousStatus,
  };
}

/**
 * Cancels `run` when the hold that the wake bypasses would cancel it at its
 * own claim. Call it only inside the admission transaction, after the issue
 * row is locked, and only for a run of the woken agent on `issueId`.
 *
 * "Would cancel it at its claim" is decided with the vendor's own question
 * (run-dispatch's decideCurrentRunStaleness): a plain, non-explicit
 * `getExecutionBlocker` for this issue, with the waiting run's own comment id
 * (a `/new` command in that run's context clears the hold for that run, not
 * for the wake's). No hold, no cancellation: the run is then not doomed and
 * the caller keeps its ordinary handling.
 *
 * Only the hold this finds is affected, and only through the caller's later
 * `supersedeExplicitWakeSettledHold`, which resolves nothing that
 * `getExecutionBlocker`'s `explicitWake` check did not already pass as
 * bypassable. This function itself changes no hold.
 */
export async function cancelWaitingRunDoomedByHold(
  tx: Db,
  input: { run: HeartbeatRun; issueId: string; now?: Date },
): Promise<CancelWaitingRunOutcome> {
  const { run, issueId } = input;
  if (!isWaitingStatus(run.status)) return { outcome: "not_doomed" };
  const expectedStatus = run.status;
  const now = input.now ?? new Date();

  const blocker = await getExecutionBlocker(tx, run.companyId, issueId, {
    conversationResetCommentId: deriveCommentId(parseObject(run.contextSnapshot)),
  });
  if (!blocker) return { outcome: "not_doomed" };

  const details = { issueId, recoveryActionId: blocker.recoveryActionId };
  const [row] = await tx
    .update(heartbeatRuns)
    .set({
      status: "cancelled",
      finishedAt: now,
      error: blocker.nextAction,
      errorCode: CANCEL_ERROR_CODE,
      resultJson: {
        ...parseObject(run.resultJson),
        stopReason: CANCEL_ERROR_CODE,
        executionWait: details,
        effectiveTimeoutSec: 0,
        timeoutConfigured: false,
        timeoutSource: "stale_queued_run_gate",
        timeoutFired: false,
      },
      updatedAt: now,
    })
    .where(
      and(
        eq(heartbeatRuns.id, run.id),
        eq(heartbeatRuns.companyId, run.companyId),
        eq(heartbeatRuns.status, expectedStatus),
      ),
    )
    .returning();
  // Something else moved the run off its waiting status first; that write
  // must not be overwritten.
  if (!row) return { outcome: "lost_race" };

  if (row.wakeupRequestId) {
    await tx
      .update(agentWakeupRequests)
      .set({ status: "skipped", finishedAt: now, error: blocker.nextAction, updatedAt: now })
      .where(
        and(
          eq(agentWakeupRequests.id, row.wakeupRequestId),
          eq(agentWakeupRequests.companyId, row.companyId),
        ),
      );
  }

  await tx
    .update(issues)
    .set({
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(issues.companyId, row.companyId),
        eq(issues.id, issueId),
        eq(issues.executionRunId, row.id),
      ),
    );

  await appendHeartbeatRunEvent(tx, {
    companyId: row.companyId,
    runId: row.id,
    agentId: row.agentId,
    eventType: "lifecycle",
    stream: "system",
    level: "warn",
    message: blocker.nextAction,
    payload: details,
  });

  return {
    outcome: "cancelled",
    run: row,
    reason: blocker.nextAction,
    errorCode: CANCEL_ERROR_CODE,
    postCommitEffects: [statusEffect(row, expectedStatus)],
  };
}

/**
 * Carries the retry budget of the cancelled waiting run into the successor's
 * context. A scheduled retry counts its own attempts on the run row
 * (`scheduledRetryAttempt`); the successor is a brand-new row that starts at
 * zero, so without this a person's wake would hand an issue that has been
 * burning its infrastructure-interruption budget a full one back. The count is
 * carried as it stands: the cancelled run never ran, so it is not one more
 * attempt. Same carrier as pause-drain.ts (INFRA_INTERRUPT_CONTEXT_ATTEMPT_KEY).
 * A budget the successor already carries is never lowered. Returns the value
 * now in the context, or null when there was nothing to carry.
 */
export function carryRetryBudgetToSuccessor(
  successorContext: Record<string, unknown>,
  cancelledRun: HeartbeatRun,
): number | null {
  const carried = infraInterruptAttemptCount({
    scheduledRetryAttempt: cancelledRun.scheduledRetryAttempt,
    scheduledRetryReason: cancelledRun.scheduledRetryReason,
    contextSnapshot: parseObject(cancelledRun.contextSnapshot),
  });
  if (carried <= 0) return null;
  const existing = successorContext[INFRA_INTERRUPT_CONTEXT_ATTEMPT_KEY];
  const value = typeof existing === "number" && Number.isInteger(existing) && existing > carried ? existing : carried;
  successorContext[INFRA_INTERRUPT_CONTEXT_ATTEMPT_KEY] = value;
  return value;
}
