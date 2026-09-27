import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import {
  crossIssueInfluenceRunContextError,
  readRunSourceIssueId,
} from "../services/cross-issue-influence-limit.js";

// Kept in sync with TERMINAL_HEARTBEAT_RUN_STATUSES in services/issues.ts. A copy
// avoids an import cycle between that service and this module.
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "interrupted", "failed", "cancelled", "timed_out"]);

/**
 * Refuses an agent checkout before the lock is written when the checking-out run
 * carries no task context.
 *
 * Every agent write route refuses a heartbeat run whose persisted
 * `contextSnapshot` names no source issue
 * (`cross_issue_influence_run_context_required`). Without this gate such a run
 * could still check an issue out: it would take the lock, move the issue to
 * `in_progress` and then be forbidden to write anything on it, leaving a blind
 * lock until the run terminates.
 *
 * The run is looked up the same way the write gate does it: persisted row scoped
 * by (id, companyId, agentId); the run header is never trusted on its own. The
 * per-run cross-issue counter is not charged, because a checkout is not a write.
 */
export async function assertRunHasTaskSourceContext(
  db: Pick<Db, "select">,
  input: { companyId: string; runId: string; agentId: string },
): Promise<string> {
  if (!isUuidLike(input.runId)) throw crossIssueInfluenceRunContextError();

  const run = await db
    .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.id, input.runId),
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
      ),
    )
    .then((rows: Array<{ contextSnapshot: unknown }>) => rows[0] ?? null);
  if (!run) throw crossIssueInfluenceRunContextError();

  const sourceIssueId = readRunSourceIssueId(run.contextSnapshot);
  if (!sourceIssueId) throw crossIssueInfluenceRunContextError();
  return sourceIssueId;
}

/**
 * Lifecycle of the run that holds an issue's checkout/execution lock, reported in
 * lock-conflict 409s so the blocked caller can tell what to expect:
 * - `running`  — a live owner; wait for it to terminate;
 * - `terminal` — the owner already ended; the stale-lock adoption path applies;
 * - `missing`  — the lock names no persisted run (or none at all).
 */
export type CheckoutRunStatus = "running" | "terminal" | "missing";

export async function checkoutRunStatusForIssue(
  dbOrTx: Pick<Db, "select">,
  issue: { checkoutRunId?: string | null; executionRunId?: string | null },
): Promise<CheckoutRunStatus> {
  const runId = issue.checkoutRunId ?? issue.executionRunId ?? null;
  if (!runId) return "missing";
  const run = await dbOrTx
    .select({ status: heartbeatRuns.status })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, runId))
    .then((rows: Array<{ status: string }>) => rows[0] ?? null);
  if (!run) return "missing";
  return TERMINAL_RUN_STATUSES.has(run.status) ? "terminal" : "running";
}
