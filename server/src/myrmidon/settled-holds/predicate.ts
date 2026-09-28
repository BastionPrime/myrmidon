// myrmidon(L2): a predicate variant for getExecutionBlocker used when the
// wake being checked is explicitly authorized. See wake-classification.ts,
// docs/myrmidon/DIVERGENCE.md "L2" and docs/myrmidon/SETTINGS.md.
import { and, inArray, not } from "drizzle-orm";
import { issueRecoveryActions } from "@paperclipai/db";
import { EXECUTION_RECONCILIATION_CAUSES } from "@paperclipai/shared";
import { conversationRecoveryActionPredicate } from "../../services/conversation-continuation.js";

/**
 * Same shape as the vendor's `executionBlockerPredicate` in
 * `execution-blocker.ts`, minus the branch that also matches a *settled*
 * (resolved/cancelled) recovery action carrying a closed "do not replay"
 * disposition (`evidence.automaticRecovery.replay === "blocked"`). That
 * disposition exists to stop the heartbeat scheduler from automatically
 * re-running the exact stopped turn; it does not forbid a new, explicitly
 * authorized wake (a human/agent comment, an assignment, an on-demand or
 * manual wake, a resume from pause, or an interaction wake).
 */
export function explicitWakeExecutionBlockerPredicate() {
  return and(
    not(conversationRecoveryActionPredicate()!),
    inArray(issueRecoveryActions.cause, [...EXECUTION_RECONCILIATION_CAUSES]),
    inArray(issueRecoveryActions.status, ["active", "escalated"]),
  );
}
