import { and, eq } from "drizzle-orm";
import { issueThreadInteractions, type Db } from "@paperclipai/db";

/**
 * Pending interaction addressee wake (P2).
 *
 * Creating an issue-thread interaction (for example `request_confirmation`)
 * wakes its addressee agent with `wakeReason: interaction_pending`. The
 * addressee is often not the issue assignee, and the wake carries no comment
 * id, so the comment-wake bypass does not apply. Without this signal the
 * queued-run staleness gate cancels the addressee's run as
 * `issue_assignee_changed` and the interaction stays unanswered.
 *
 * The signal holds only while the interaction named by the run context is
 * still pending and addressed to the run's agent.
 */

const PENDING_INTERACTION_WAKE_REASON = "interaction_pending";
const PENDING_INTERACTION_WAKE_SOURCE = "issue.interaction.created";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidString(value: unknown): string | null {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value : null;
}

/** Context-only precheck: the run was woken because an interaction addressed to it was created. */
export function looksLikePendingInteractionAddresseeWake(context: Record<string, unknown>): boolean {
  return (
    context.wakeReason === PENDING_INTERACTION_WAKE_REASON &&
    context.source === PENDING_INTERACTION_WAKE_SOURCE &&
    uuidString(context.interactionId) !== null
  );
}

export async function isPendingInteractionAddresseeWake(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    agentId: string;
    contextSnapshot: Record<string, unknown>;
  },
): Promise<boolean> {
  if (!looksLikePendingInteractionAddresseeWake(input.contextSnapshot)) return false;
  const interactionId = uuidString(input.contextSnapshot.interactionId)!;
  const [interaction] = await db
    .select({ id: issueThreadInteractions.id })
    .from(issueThreadInteractions)
    .where(
      and(
        eq(issueThreadInteractions.id, interactionId),
        eq(issueThreadInteractions.companyId, input.companyId),
        eq(issueThreadInteractions.issueId, input.issueId),
        eq(issueThreadInteractions.status, "pending"),
        eq(issueThreadInteractions.addresseeAgentId, input.agentId),
      ),
    )
    .limit(1);
  return interaction !== undefined;
}
