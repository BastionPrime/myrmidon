/**
 * Infrastructure interruptions do not create an operator recovery hold (L1).
 *
 * A run that ends because of infrastructure (an agent pause, a lost process, a
 * server shutdown, or the issue being reassigned mid-run) is not evidence
 * against the agent or the provider: nothing about the work it did is in
 * question. The vendor's reconciliation gate (legacy-execution-recovery.ts)
 * and the stranded-assigned-issue sweep (services/recovery/service.ts) both
 * treat every terminal run the same way and ask a human to reconcile it. For
 * the error codes named here, that hold is skipped instead, mirroring the
 * existing maintenance-interrupt exception (myrmidon/maintenance/domain.ts,
 * MAINTENANCE_INTERRUPT_ERROR_CODE): the original executor gets a bounded
 * retry, and a reassigned issue is simply released for its new assignee to
 * pick up on its own.
 *
 * This relies on the retry (or the immediate continuation) being safe to
 * issue blindly, without knowing what the interrupted attempt already did.
 * That is only true for the run's own adapter, so every entry point here is
 * gated by adapterQualifiesForInfraInterruptRelief: a conversation adapter
 * (services/conversation-continuation.ts's CONVERSATION_ADAPTER_TYPES) hands
 * a fresh turn to the provider and lets it decide what remains, so a repeat
 * invocation is not a replay of the original action. A process/webhook-style
 * adapter (process, http, openclaw_gateway, …) has no such contract -- the
 * vendor's own CONVERSATION_ADAPTER_TYPES comment is explicit that retrying
 * one of those "can replay the action itself" -- so this exception leaves the
 * vendor's hold in place for them until they carry an idempotency key of
 * their own (see IDEMPOTENT_INFRA_INTERRUPT_ADAPTER_TYPES). An unclaimed or
 * unknown adapter type is treated the same as a non-qualifying one: this
 * exception never assumes a safety it cannot see.
 *
 * The exception also stays out of the way while the provider stop is only
 * requested, not confirmed (infraInterruptStopUnconfirmed): the next turn --
 * a resume, or a new assignee after a reassignment -- could otherwise
 * overlap the old turn that has not actually stopped.
 *
 * Setting: MYRMIDON_INFRA_INTERRUPT_CODES, docs/myrmidon/SETTINGS.md.
 */

import { executionFailureRetryCount } from "../services/execution-recovery-attempt.js";
import { CONVERSATION_ADAPTER_TYPES, claimedAdapterType } from "../services/conversation-continuation.js";

export const INFRA_INTERRUPT_CODES_ENV = "MYRMIDON_INFRA_INTERRUPT_CODES";

export const DEFAULT_INFRA_INTERRUPT_ERROR_CODES = [
  "agent_paused",
  "process_lost",
  "server_shutdown_interrupted",
  "issue_reassigned",
] as const;

/**
 * The error code a cancelled/failed run carries when the issue it belonged to
 * was reassigned to a different agent before or during the run. Retrying the
 * *original* executor here would be wrong: it is no longer this issue's
 * assignee. The new assignee is woken through the normal assignment path
 * instead, so this code only ever qualifies for hold suppression, never for
 * an explicit bounded retry of the run's own agent.
 */
export const REASSIGNMENT_INTERRUPT_ERROR_CODE = "issue_reassigned";

/**
 * Same retry budget the vendor's own reconciliation gate already enforces for
 * every other exception in legacyExecutionNeedsReconciliation
 * (legacy-execution-recovery.ts: `executionFailureRetryCount(run) >= 2`).
 * Reusing it keeps a paused/interrupted issue from retrying forever: once a
 * run has burned through the same budget an ordinary transient failure would,
 * an infrastructure interruption falls back to the vendor's hold-and-ask
 * behavior instead of skipping it again.
 */
export const DEFAULT_INFRA_INTERRUPT_RETRY_BUDGET = 2;

type RetryBudgetRun = Parameters<typeof executionFailureRetryCount>[0];

/**
 * contextSnapshot field carrying the infra-interrupt attempt count forward
 * across a pause/resume cycle (pause-drain.ts's resumeAgentAfterPause). A
 * resumed agent's stranded issue gets an entirely new heartbeat run, not a
 * scheduled continuation of the run the pause cancelled -- so
 * heartbeat_runs.scheduledRetryAttempt, which defaults to 0 on that new row,
 * cannot carry the shared budget by itself, and the budget could never
 * exhaust for a repeatedly paused-and-resumed issue. This mirrors the
 * vendor's own fix for the identical problem under a different retry reason
 * (failureRetriesBeforeWorkspaceWait / failureRetriesBeforeAiConnectionWait,
 * carried the same way in heartbeat.ts's scheduleBoundedRetryForRun): the
 * durable count is read off the run this issue is actually resuming from and
 * carried into the new run's contextSnapshot.
 */
export const INFRA_INTERRUPT_CONTEXT_ATTEMPT_KEY = "infraInterruptAttempt";

function readInfraInterruptContextAttempt(
  contextSnapshot: Record<string, unknown> | null | undefined,
): number {
  const value = contextSnapshot?.[INFRA_INTERRUPT_CONTEXT_ATTEMPT_KEY];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

/**
 * The infra-interrupt attempt count a run carries: whichever is higher of
 * the vendor's own scheduledRetryAttempt-based accounting
 * (executionFailureRetryCount) and the pause/resume carry-forward field
 * above. Used both to decide whether this run's own interruption is still
 * within the shared budget, and -- by resumeAgentAfterPause, reading the
 * *predecessor* run -- to compute the count the next run after it should
 * carry.
 */
export function infraInterruptAttemptCount(run: RetryBudgetRun): number {
  return Math.max(
    executionFailureRetryCount(run),
    readInfraInterruptContextAttempt(run.contextSnapshot),
  );
}

/** Parses a MYRMIDON_INFRA_INTERRUPT_CODES value into the set of configured codes. `undefined`/empty/"off" means "disabled" (vendor behavior). */
export function parseInfraInterruptCodes(raw: string | undefined): ReadonlySet<string> {
  if (raw === undefined) return new Set(DEFAULT_INFRA_INTERRUPT_ERROR_CODES);
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.toLowerCase() === "off") return new Set();
  return new Set(
    trimmed
      .split(",")
      .map((code) => code.trim())
      .filter((code) => code.length > 0),
  );
}

/** Reads MYRMIDON_INFRA_INTERRUPT_CODES from `env` (defaults to `process.env`). */
export function readInfraInterruptCodes(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  return parseInfraInterruptCodes(env[INFRA_INTERRUPT_CODES_ENV]);
}

/** True when `errorCode` is configured as an infrastructure interruption. */
export function isInfraInterruptErrorCode(
  errorCode: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!errorCode) return false;
  return readInfraInterruptCodes(env).has(errorCode);
}

/** True once a run has already used the shared infra-interrupt retry budget. */
export function infraInterruptRetryBudgetExhausted(
  run: RetryBudgetRun,
  maxAttempts: number = DEFAULT_INFRA_INTERRUPT_RETRY_BUDGET,
): boolean {
  return infraInterruptAttemptCount(run) >= maxAttempts;
}

/**
 * Adapters whose recovery is already keyed by an idempotency token, so a
 * blind retry of the run cannot replay its external action a second time.
 * Empty today -- track G4 (hermes_gateway's Idempotency-Key attach) is
 * expected to add hermes_gateway here once its wakeup carries one. Until
 * then, a non-conversation adapter keeps the vendor's hold for every
 * infra-interrupt code, not only the ones this PR happened to add tests for.
 */
export const IDEMPOTENT_INFRA_INTERRUPT_ADAPTER_TYPES: readonly string[] = [];

type AdapterClaimingRun = { runnerProfileJson?: Record<string, unknown> | null };

/**
 * True when this run's own claimed adapter (claimedAdapterType,
 * services/conversation-continuation.ts -- a pure read of
 * runnerProfileJson.adapterDispatch, the value the server persists when it
 * claims the run) can safely take a blind retry or immediate continuation:
 * either it is a conversation adapter, which hands the provider a fresh turn
 * instead of replaying whatever the interrupted attempt already did, or it
 * carries its own idempotency key (IDEMPOTENT_INFRA_INTERRUPT_ADAPTER_TYPES).
 * An unclaimed/unknown adapter type is conservative: false, the vendor hold
 * stays in place, exactly as for a known non-qualifying adapter.
 */
export function adapterQualifiesForInfraInterruptRelief(run: AdapterClaimingRun): boolean {
  const adapterType = claimedAdapterType({ runnerProfileJson: run.runnerProfileJson ?? null });
  if (!adapterType) return false;
  return (
    (CONVERSATION_ADAPTER_TYPES as readonly string[]).includes(adapterType) ||
    IDEMPOTENT_INFRA_INTERRUPT_ADAPTER_TYPES.includes(adapterType)
  );
}

/**
 * True when the run's provider stop was requested but never confirmed:
 * heartbeat.ts writes `resultJson.executionCancellation.state = "requested"`
 * when it cancels a run through the adapter's execution control, and only
 * moves it to "acknowledged" once the provider is proven stopped
 * (acknowledgeRemoteStop, or the adapter's own settlement). While it is still
 * "requested" the old turn may be running, so the vendor's hold is the only
 * thing keeping a next turn from overlapping it. An absent state is not
 * "requested": cancelling without adapter control either writes
 * "acknowledged" (a process this server holds, killed and awaited) or writes
 * nothing (no process handle to stop), so absence carries no "stop is still
 * pending" signal to act on. Reads the field defensively: `resultJson` may be
 * null, or arrive as an unparsed value from a narrow projection.
 */
export function infraInterruptStopUnconfirmed(run: { resultJson?: unknown }): boolean {
  const resultJson = run.resultJson;
  if (!resultJson || typeof resultJson !== "object") return false;
  const cancellation = (resultJson as Record<string, unknown>).executionCancellation;
  if (!cancellation || typeof cancellation !== "object") return false;
  return (cancellation as Record<string, unknown>).state === "requested";
}

/**
 * True when a run terminated by an infrastructure interruption should skip
 * the vendor's reconciliation hold: legacyExecutionNeedsReconciliation
 * (legacy-execution-recovery.ts) and the stranded-assigned-issue escalation
 * (services/recovery/service.ts) both call this with the same run shape.
 * Gated by adapterQualifiesForInfraInterruptRelief -- see the module comment
 * above for why a non-conversation adapter never qualifies here -- and by
 * infraInterruptStopUnconfirmed: a run whose provider stop is still only
 * requested keeps the vendor's hold.
 */
export function shouldSkipReconciliationForInfraInterrupt(
  run: RetryBudgetRun &
    AdapterClaimingRun & { errorCode?: string | null; resultJson?: unknown },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    isInfraInterruptErrorCode(run.errorCode, env) &&
    adapterQualifiesForInfraInterruptRelief(run) &&
    !infraInterruptStopUnconfirmed(run) &&
    !infraInterruptRetryBudgetExhausted(run, DEFAULT_INFRA_INTERRUPT_RETRY_BUDGET)
  );
}

/**
 * True when the *original executor* of an infra-interrupted run should get a
 * bounded retry instead of an immediate operator escalation. Reassignment is
 * excluded on purpose (see REASSIGNMENT_INTERRUPT_ERROR_CODE): the run's own
 * agent is no longer this issue's assignee, so scheduling it a retry would
 * wake the wrong agent. That case only ever qualifies for hold suppression
 * above, never for this.
 */
export function shouldRetryOriginalExecutorForInfraInterrupt(
  run: RetryBudgetRun &
    AdapterClaimingRun & { errorCode?: string | null; resultJson?: unknown },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (run.errorCode === REASSIGNMENT_INTERRUPT_ERROR_CODE) return false;
  return shouldSkipReconciliationForInfraInterrupt(run, env);
}
