// myrmidon(L2): a predicate variant for getExecutionBlocker used when the
// wake being checked is explicitly authorized. See wake-classification.ts,
// docs/myrmidon/DIVERGENCE.md "L2" and docs/myrmidon/SETTINGS.md.
import { and, inArray, not, or, sql } from "drizzle-orm";
import { issueRecoveryActions } from "@paperclipai/db";
import { EXECUTION_RECONCILIATION_CAUSES } from "@paperclipai/shared";
import { conversationRecoveryActionPredicate } from "../../services/conversation-continuation.js";

/**
 * Same shape as the vendor's `executionBlockerPredicate` in
 * `execution-blocker.ts`, except the branch that also matches a *settled*
 * (resolved/cancelled) recovery action carrying a closed "do not replay"
 * disposition (`evidence.automaticRecovery.replay === "blocked"`) only still
 * blocks when that disposition names a stopped run
 * (`evidence.runId`/`evidence.sourceRunId`).
 *
 * That disposition exists to stop the heartbeat scheduler from
 * automatically re-running the exact stopped turn, not to forbid a new,
 * explicitly authorized wake (a human/agent comment, an assignment, an
 * on-demand or manual wake, a resume from pause, or an interaction wake).
 * But when it names a run, that run's process and environment lease may
 * still be genuinely unverified — native/legacy continuation admission
 * (`explicit-native-continuation.ts`) or an operator clearing the
 * disposition through `resolve` (`settled-holds/clear.ts`) already prove
 * that safely; an unattended wake here must not skip that proof. Only a
 * disposition with no run to verify — nothing left to prove — is safe to
 * let straight through.
 */
export function explicitWakeExecutionBlockerPredicate() {
  return and(
    not(conversationRecoveryActionPredicate()!),
    inArray(issueRecoveryActions.cause, [...EXECUTION_RECONCILIATION_CAUSES]),
    or(
      inArray(issueRecoveryActions.status, ["active", "escalated"]),
      and(
        sql`${issueRecoveryActions.evidence}->'automaticRecovery'->>'replay' = 'blocked'`,
        or(
          sql`${issueRecoveryActions.evidence}->>'runId' is not null`,
          sql`${issueRecoveryActions.evidence}->>'sourceRunId' is not null`,
        ),
      ),
    ),
  );
}
