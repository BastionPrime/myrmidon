// myrmidon(L2, round 1 fix): supersedes a settled "do not replay" hold that
// an explicitly authorized wake carrying no message of its own (assignment,
// manual wakeup, approval decision, subtree resume) bypassed, atomically
// with the successor run the caller is about to create under
// `successorRunId`. Mirrors the vendor's own resolution shape for a
// verified successor (explicit-native-continuation.ts's
// `explicit_user_continuation`, native-safe-replacement.ts's
// `verified_safe_replacement`): without this, the hold never records its
// own end, and it keeps blocking every later *automatic* continuation of
// that successor as if it were still open — a scheduled retry
// (scheduleBoundedRetryForRun), a resource-wait continuation
// (recovery/service.ts's `issue_continuation_needed`), release-time wake
// promotion (wake-queue's postgres adapter), a pause-resume wake
// (pause-drain.ts) — none of which re-derive "explicit" the way the
// original bypassed wake did. See wake-classification.ts,
// explicit-wake-bypass.ts and docs/myrmidon/DIVERGENCE.md "L2".
import { and, eq } from "drizzle-orm";
import { issueRecoveryActions, type Db } from "@paperclipai/db";
import { executionBlockerPredicate } from "../../services/execution-blocker.js";
import { explicitWakeBypassesSettledHold } from "./explicit-wake-bypass.js";
import { persistActivity } from "../../services/activity-log.js";

export interface SupersedeExplicitWakeSettledHoldInput {
  db: Db;
  companyId: string;
  issueId: string;
  /** The run id the caller has already reserved for the successor it is
   * about to insert, in this same transaction, as this wake's admission. */
  successorRunId: string;
  /** Always "user": the caller only reaches this once `isExplicitWake` has
   * already required it (wake-classification.ts). Typed here, not widened,
   * so a future caller cannot pass an unauthorized actor by accident. */
  requestedByActorType: "user";
  requestedByActorId: string;
}

/**
 * Locks and resolves every recovery action for `issueId` that a settled
 * no-replay hold currently matches (`executionBlockerPredicate`) and that
 * `explicitWakeBypassesSettledHold` verifies has actually released its named
 * run's execution claim. A genuinely still-open action (status
 * "active"/"escalated", or a settled one whose named run has not actually
 * released its claim yet) is left untouched: it was never eligible to
 * bypass in the first place, and the caller's own `getExecutionBlocker`
 * call would have reported it as still blocking, not bypassed. Call only
 * once the caller has confirmed that this exact wake is proceeding past
 * such a hold (`getExecutionBlocker`'s `explicitWake` option returned null,
 * which it does only when every matching action is bypassable, so nothing
 * this leaves standing can meet the successor run at its claim).
 * A no-op (returns null) when nothing here still needs resolving — a wake
 * that bypassed only because there was no hold at all in the first place.
 */
export async function supersedeExplicitWakeSettledHold(
  input: SupersedeExplicitWakeSettledHoldInput,
): Promise<{ recoveryActionIds: string[] } | null> {
  const { db, companyId, issueId, successorRunId, requestedByActorType, requestedByActorId } = input;
  const actions = await db.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, companyId),
    eq(issueRecoveryActions.sourceIssueId, issueId),
    executionBlockerPredicate(),
  )).for("update");
  if (!actions.length) return null;

  const recordedAt = new Date();
  const supersededIds: string[] = [];
  for (const action of actions) {
    if (!(await explicitWakeBypassesSettledHold(db, companyId, action))) continue;
    const automaticRecovery = (action.evidence.automaticRecovery ?? {}) as Record<string, unknown>;
    const [updated] = await db.update(issueRecoveryActions).set({
      status: "resolved",
      outcome: "handed_back",
      resolvedAt: recordedAt,
      updatedAt: recordedAt,
      nextAction: "An explicitly authorized wake continues in a fresh run. Prior action outcomes remain recorded.",
      resolutionNote: "An explicitly authorized wake (not a replay of the stopped run) verified the prior run had released its execution claim.",
      wakePolicy: null,
      monitorPolicy: null,
      evidence: {
        ...action.evidence,
        explicitWakeSuperseded: { successorRunId, requestedByActorType, requestedByActorId, recordedAt: recordedAt.toISOString() },
        automaticRecovery: { ...automaticRecovery, replay: "explicit_wake_superseded", successorRunId },
      },
    }).where(and(eq(issueRecoveryActions.id, action.id), eq(issueRecoveryActions.companyId, companyId)))
      .returning({ id: issueRecoveryActions.id });
    if (updated) supersededIds.push(updated.id);
  }
  if (!supersededIds.length) return null;

  // Row only, no live event: this runs inside the caller's still-uncommitted
  // admission transaction, so publishing here would announce a hold
  // resolution that a rollback could still undo. The vendor analog
  // (explicit-native-continuation.ts) persists the same way.
  await persistActivity(db, {
    companyId,
    actorType: requestedByActorType,
    actorId: requestedByActorId,
    action: "issue.execution_recovery_settled",
    entityType: "issue",
    entityId: issueId,
    details: { continuation: "explicit_wake_superseded", successorRunId, recoveryActionIds: supersededIds },
  });
  return { recoveryActionIds: supersededIds };
}
