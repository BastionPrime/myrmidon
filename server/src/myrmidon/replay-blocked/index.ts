// N1: tasks held by an automatic "do not replay" recovery disposition.
// Read-only list for the board UI. Resolving uses the vendor
// POST /issues/:id/recovery-actions/resolve; a board operator can also just
// clear the hold there (L2, settled-holds/clear.ts) instead of restoring a
// verified outcome. Either way, a row drops out of this list once
// evidence.automaticRecovery.replay no longer reads "blocked" — the query
// below checks that directly, so clearing the hold needs no change here.

import { Router } from "express";
import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { heartbeatRuns, issueRecoveryActions, issues, type Db } from "@paperclipai/db";
import { assertBoard, assertCompanyAccess } from "../../routes/authz.js";
import { executionBlockerPredicate } from "../../services/execution-blocker.js";

export interface ReplayBlockedIssue {
  issueId: string;
  recoveryActionId: string;
  /** The stopped run that must be reconciled. */
  runId: string | null;
  /** Agent that owned the stopped run; resolving needs the assignee to match it. */
  runAgentId: string | null;
  assigneeAgentId: string | null;
  cause: string;
  nextAction: string | null;
}

export async function listReplayBlockedIssues(db: Db, companyId: string): Promise<ReplayBlockedIssue[]> {
  const rows = await db
    .select({
      issueId: issueRecoveryActions.sourceIssueId,
      recoveryActionId: issueRecoveryActions.id,
      cause: issueRecoveryActions.cause,
      nextAction: issueRecoveryActions.nextAction,
      evidence: issueRecoveryActions.evidence,
      assigneeAgentId: issues.assigneeAgentId,
    })
    .from(issueRecoveryActions)
    .innerJoin(issues, eq(issues.id, issueRecoveryActions.sourceIssueId))
    .where(
      and(
        eq(issueRecoveryActions.companyId, companyId),
        executionBlockerPredicate(),
        // Active recovery actions already have the vendor recovery card; only the
        // settled no-replay hold is invisible.
        sql`${issueRecoveryActions.evidence}->'automaticRecovery'->>'replay' = 'blocked'`,
        notInArray(issueRecoveryActions.status, ["active", "escalated"]),
        notInArray(issues.status, ["done", "cancelled"]),
      ),
    )
    .orderBy(desc(issueRecoveryActions.updatedAt), desc(issueRecoveryActions.id));

  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) if (!latest.has(row.issueId)) latest.set(row.issueId, row);

  const runIdOf = (evidence: Record<string, unknown>) => {
    const value = evidence.runId ?? evidence.sourceRunId;
    return typeof value === "string" ? value : null;
  };
  const runIds = [...latest.values()].map((row) => runIdOf(row.evidence)).filter((id): id is string => !!id);
  const runAgents = new Map(
    runIds.length
      ? (
          await db
            .select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId })
            .from(heartbeatRuns)
            .where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.id, runIds)))
        ).map((run) => [run.id, run.agentId] as const)
      : [],
  );

  return [...latest.values()].map((row) => {
    const runId = runIdOf(row.evidence);
    return {
      issueId: row.issueId,
      recoveryActionId: row.recoveryActionId,
      runId,
      runAgentId: runId ? (runAgents.get(runId) ?? null) : null,
      assigneeAgentId: row.assigneeAgentId,
      cause: row.cause,
      nextAction: row.nextAction,
    };
  });
}

/** GET /api/myrmidon/companies/:companyId/replay-blocked-issues — board only. */
export function myrmidonReplayBlockedRoutes(db: Db) {
  const router = Router();
  router.get("/myrmidon/companies/:companyId/replay-blocked-issues", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    res.json({ issues: await listReplayBlockedIssues(db, companyId) });
  });
  return router;
}
