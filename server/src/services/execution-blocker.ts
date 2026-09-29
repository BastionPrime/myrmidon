import { and, desc, eq, gt, inArray, not, or, sql } from "drizzle-orm";
import { conversationRecoveryActionPredicate, getConversationOwnershipBlocker } from "./conversation-continuation.js";
import { z } from "zod";
import { heartbeatRuns, issueComments, issues, issueRecoveryActions, type Db } from "@paperclipai/db";
import { EXECUTION_RECONCILIATION_CAUSES, type ExecutionBlocker } from "@paperclipai/shared";
// myrmidon(L2): an explicitly authorized wake ignores a settled "do not
// replay" hold once its named run (if any) is verified to have released its
// execution claim; see settled-holds/explicit-wake-bypass.ts and
// docs/myrmidon/DIVERGENCE.md "L2".
import { explicitWakeBypassesSettledHold } from "../myrmidon/settled-holds/explicit-wake-bypass.js";

/** Resolved recovery bookkeeping can still carry an effective no-replay hold. */
export function executionBlockerPredicate() {
  return and(
    not(conversationRecoveryActionPredicate()!),
    inArray(issueRecoveryActions.cause, [...EXECUTION_RECONCILIATION_CAUSES]),
    or(inArray(issueRecoveryActions.status, ["active", "escalated"]),
      sql`${issueRecoveryActions.evidence}->'automaticRecovery'->>'replay' = 'blocked'`),
  );
}

export async function getExecutionBlocker(db: Db, companyId: string, issueId: string, options?: {
  conversationResetCommentId?: string | null;
  /** myrmidon(L2): true when the caller is checking an explicitly authorized wake. */
  explicitWake?: boolean;
}): Promise<ExecutionBlocker | null> {
  const [conversation] = await db.select({ agentId: issues.conversationAgentId,
    boundaryId: issues.conversationBoundaryCommentId }).from(issues).where(and(
    eq(issues.companyId, companyId), eq(issues.id, issueId),
  )).limit(1);
  // A persisted user /new is an ordered context command, not a retry of uncertain work.
  // The normal issue execution lock still serializes it behind any active turn.
  if (conversation?.agentId && options?.conversationResetCommentId) {
    const [command] = await db.select().from(issueComments).where(and(
      eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId),
      eq(issueComments.id, options.conversationResetCommentId),
    )).limit(1);
    if (command?.authorUserId && !command.deletedAt && command.body.trim() === "/new") return null;
  }
  const [boundary] = conversation?.agentId && conversation.boundaryId
    ? await db.select({ createdAt: issueComments.createdAt }).from(issueComments).where(and(
      eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId),
      eq(issueComments.id, conversation.boundaryId),
    )).limit(1) : [];

  const ownership = await getConversationOwnershipBlocker(db, companyId, issueId);
  if (ownership) return { ...ownership, recoveryActionId: null };
  const matching = db.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, companyId),
    eq(issueRecoveryActions.sourceIssueId, issueId),
    executionBlockerPredicate(),
    boundary ? gt(issueRecoveryActions.createdAt, boundary.createdAt) : undefined,
  )).orderBy(desc(issueRecoveryActions.updatedAt), desc(issueRecoveryActions.id));
  // myrmidon(L2): an explicit wake reads every matching action, not only the
  // newest, so an older hold that is not safe to bypass still blocks it.
  const candidates = options?.explicitWake ? await matching : await matching.limit(1);
  const [first] = candidates;
  if (!first) return null;
  let action = first;
  // myrmidon(L2): an explicitly authorized wake ignores a settled "do not
  // replay" hold once its named run (if any) is verified to have released
  // its execution claim. The caller decides `explicitWake` (settled-holds/
  // explicit-wake-gate.ts), which already applies
  // MYRMIDON_SETTLED_HOLDS_BLOCK_EXPLICIT_WAKES. It passes only when every
  // matching action is bypassable: the wake's admission supersedes exactly
  // those, so what remains here would block the run's own claim and lose
  // the wake there.
  if (options?.explicitWake) {
    let blocking: typeof first | null = null;
    for (const candidate of candidates) {
      if (!(await explicitWakeBypassesSettledHold(db, companyId, candidate))) { blocking = candidate; break; }
    }
    if (!blocking) return null;
    action = blocking;
  }
  const parsedRunId = z.string().guid().safeParse(action.evidence.runId ?? action.evidence.sourceRunId);
  const runId = parsedRunId.success ? parsedRunId.data : null;
  const [run] = runId ? await db.select({ agentId: heartbeatRuns.agentId }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId),
  )).limit(1) : [];

  return {
    recoveryActionId: action.id,
    runId,
    // A stopped reviewer can differ from the task owner who receives the work back.
    agentId: run?.agentId ?? null,
    cause: action.cause,
    nextAction: action.nextAction,
  };
}
