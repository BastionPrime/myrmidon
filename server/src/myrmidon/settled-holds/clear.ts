// myrmidon(L2): clears a settled recovery action's "do not replay"
// disposition so a board operator can un-stick a task through the API
// instead of a raw evidence SQL edit. Called from the vendor's
// POST /issues/:id/recovery-actions/resolve for a closed (resolved/
// cancelled) action targeted by `actionId`; see
// docs/myrmidon/DIVERGENCE.md "L2".
import { eq } from "drizzle-orm";
import { issueRecoveryActions, type Db } from "@paperclipai/db";
import { persistActivity } from "../../services/activity-log.js";

type IssueRecoveryAction = typeof issueRecoveryActions.$inferSelect;

export interface ClearSettledReplayBlockActor {
  actorType: "agent" | "user";
  actorId: string;
}

/**
 * `action` must already be a closed (resolved/cancelled) recovery action
 * whose `evidence.automaticRecovery.replay` reads "blocked"; the caller
 * checks both that and that the actor is a board operator before calling
 * this. This function does not re-check either condition, so a repeat call
 * once `replay` already reads "cleared" only happens if the caller's own
 * guard is bypassed — the caller's guard, not this function, is what makes
 * a repeat `resolve` request a no-op.
 */
export async function clearSettledReplayBlock(input: {
  db: Db;
  companyId: string;
  action: IssueRecoveryAction;
  actor: ClearSettledReplayBlockActor;
  note: string | null;
}): Promise<IssueRecoveryAction> {
  const { db, companyId, action, actor, note } = input;
  const automaticRecovery = (action.evidence.automaticRecovery ?? {}) as Record<string, unknown>;
  const clearedAt = new Date();
  const evidence = {
    ...action.evidence,
    automaticRecovery: {
      ...automaticRecovery,
      replay: "cleared",
      replayClearedBy: actor.actorId,
      replayClearedByType: actor.actorType,
      replayClearedAt: clearedAt.toISOString(),
      replayClearedNote: note,
    },
  };
  const [updated] = await db
    .update(issueRecoveryActions)
    .set({ evidence, updatedAt: clearedAt })
    .where(eq(issueRecoveryActions.id, action.id))
    .returning();
  const cleared = updated ?? { ...action, evidence, updatedAt: clearedAt };
  await persistActivity(db, {
    companyId,
    actorType: actor.actorType,
    actorId: actor.actorId,
    action: "issue.execution_recovery_replay_cleared",
    entityType: "issue",
    entityId: action.sourceIssueId,
    details: {
      recoveryActionId: action.id,
      cause: action.cause,
      recoveryActionStatus: action.status,
      note,
    },
  });
  return cleared;
}
