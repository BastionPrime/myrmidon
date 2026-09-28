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
 * Setting: MYRMIDON_INFRA_INTERRUPT_CODES, docs/myrmidon/SETTINGS.md.
 */

import { executionFailureRetryCount } from "../services/execution-recovery-attempt.js";

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
 * True when a run terminated by an infrastructure interruption should skip
 * the vendor's reconciliation hold: legacyExecutionNeedsReconciliation
 * (legacy-execution-recovery.ts) and the stranded-assigned-issue escalation
 * (services/recovery/service.ts) both call this with the same run shape.
 */
export function shouldSkipReconciliationForInfraInterrupt(
  run: RetryBudgetRun & { errorCode?: string | null },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    isInfraInterruptErrorCode(run.errorCode, env) &&
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
  run: RetryBudgetRun & { errorCode?: string | null },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (run.errorCode === REASSIGNMENT_INTERRUPT_ERROR_CODE) return false;
  return shouldSkipReconciliationForInfraInterrupt(run, env);
}
