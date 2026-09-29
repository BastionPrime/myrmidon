// myrmidon(L2): decides whether a settled "do not replay" recovery
// disposition still blocks an explicitly authorized wake. See
// wake-classification.ts, explicit-wake-gate.ts and
// docs/myrmidon/DIVERGENCE.md "L2".
import { and, eq } from "drizzle-orm";
import { heartbeatRuns, nativeRunFinalizations, issueRecoveryActions, type Db } from "@paperclipai/db";
import { z } from "zod";

type RecoveryAction = typeof issueRecoveryActions.$inferSelect;

/**
 * A run this old must have already stopped one way or another before any
 * recovery bookkeeping about it exists at all; a run still in one of these
 * states is not settled, whatever its recovery action says.
 */
const TERMINAL_RUN_STATUSES = new Set(["failed", "timed_out", "interrupted", "cancelled"]);

/**
 * True when `action` — a recovery action `getExecutionBlocker` already found
 * via the vendor's `executionBlockerPredicate` — is a *settled* (resolved/
 * cancelled) closed "do not replay" disposition
 * (`evidence.automaticRecovery.replay === "blocked"`) whose named run, if
 * any, has already released its execution claim, so an explicitly
 * authorized wake (the caller's `explicitWake` check) may proceed without
 * replaying it.
 *
 * A genuinely still-open action (`status` "active"/"escalated") never
 * bypasses: that branch of the vendor predicate always means recovery is
 * actively working this, regardless of wake classification.
 *
 * When the disposition names a run (`evidence.runId`/`sourceRunId`), this
 * re-checks the *live* state of that run's native finalization coordinator
 * (`nativeRunFinalizations`) — the same signal
 * `settleUnrecoverableExecutions` (execution-recovery-resolution.ts) itself
 * already requires, at write time, before ever recording this disposition:
 * no lease owner, no result, no successor run, phase `terminal_failure`.
 * Re-checking live rather than trusting the stored evidence means a later
 * event that reopens the coordinator (a resume, a fresh attempt) still
 * blocks, even though the evidence blob itself does not change.
 *
 * A run with no coordinator row (non-native runtime; the reconciler that
 * writes `nativeRunFinalizations` never tracked it) has nothing further to
 * verify beyond its own terminal status — there is no local process or
 * environment lease of ours to still be holding it open.
 */
export async function explicitWakeBypassesSettledHold(
  db: Db,
  companyId: string,
  action: RecoveryAction,
): Promise<boolean> {
  if (action.status !== "resolved" && action.status !== "cancelled") return false;
  const automaticRecovery = (action.evidence.automaticRecovery ?? {}) as Record<string, unknown>;
  if (automaticRecovery.replay !== "blocked") return false;

  const parsedRunId = z.string().guid().safeParse(action.evidence.runId ?? action.evidence.sourceRunId);
  if (!parsedRunId.success) return true;
  const runId = parsedRunId.data;

  const [run] = await db
    .select({ status: heartbeatRuns.status })
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId)))
    .limit(1);
  // The referenced run row is gone (purged historical data): nothing left
  // to verify.
  if (!run) return true;
  if (!TERMINAL_RUN_STATUSES.has(run.status)) return false;

  const [coordinator] = await db
    .select({
      phase: nativeRunFinalizations.phase,
      leaseOwner: nativeRunFinalizations.leaseOwner,
      resultId: nativeRunFinalizations.resultId,
      failureDetail: nativeRunFinalizations.failureDetail,
    })
    .from(nativeRunFinalizations)
    .where(and(eq(nativeRunFinalizations.companyId, companyId), eq(nativeRunFinalizations.runId, runId)))
    .limit(1);
  if (!coordinator) return true;

  const failureDetail = (coordinator.failureDetail ?? {}) as Record<string, unknown>;
  return (
    coordinator.phase === "terminal_failure" &&
    !coordinator.leaseOwner &&
    !coordinator.resultId &&
    !failureDetail.successorRunId
  );
}
