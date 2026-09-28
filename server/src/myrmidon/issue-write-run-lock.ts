/**
 * L5: the issue write lock (`issue_write_assignee_run_lock`, HTTP 409) used to
 * fire off the issue's own `status` field alone — any issue sitting at
 * `in_progress` blocked every other agent's write, even when the assignee had
 * no run actually going. A manager could not write to a subordinate's parent
 * task the moment its subtree touched `in_progress`, with nothing live behind
 * it, and the 409's "a run is live" copy was not true in that case.
 *
 * This only reports the lock as live when the assignee's checkout or
 * execution run is itself still non-terminal: `running`, `queued`, or
 * `scheduled_retry`. `queued` counts: a run waiting for an admission slot
 * (see run-admission.ts) still owns the issue, it just has not started yet.
 * `scheduled_retry` counts too: on a transient failure the vendor reuses the
 * *same* issue lock for the retry — it re-points `issues.executionRunId` at
 * the newly inserted `scheduled_retry` run while requiring the issue to stay
 * `in_progress` (server/src/services/heartbeat.ts, the retry-scheduling path
 * around the `AI_CONNECTION_BUSY_RETRY_REASON`/max-turn-continuation checks),
 * so the assignee's run is about to resume on this exact issue. This matches
 * the vendor's own non-terminal/active-run definition, used consistently
 * elsewhere in heartbeat.ts: `EXECUTION_PATH_HEARTBEAT_RUN_STATUSES` and
 * `CANCELLABLE_HEARTBEAT_RUN_STATUSES` are both
 * `["queued", "running", "scheduled_retry"]`, and the two queries that decide
 * whether an issue already has an active run use that same triple. A run in
 * a genuinely terminal state, or no run at all, no longer justifies the
 * lock.
 *
 * `tasks:manage_active_checkouts` (server/src/services/authorization.ts)
 * keeps overriding the lock entirely and is evaluated before this module is
 * ever reached — see docs/myrmidon/design/issue-write-lock.md for how to grant
 * it, and how this fits the rest of the write-lock decision.
 */

export const WRITE_LOCK_REQUIRES_LIVE_RUN_ENV =
  "MYRMIDON_WRITE_LOCK_REQUIRES_LIVE_RUN";

/**
 * Unset, empty, or anything other than "0"/"false" (case-insensitive) keeps
 * the fix enabled — CONVENTIONS.md §8: a defect fix defaults to on.
 */
export function isWriteLockLiveRunCheckEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env[WRITE_LOCK_REQUIRES_LIVE_RUN_ENV]?.trim().toLowerCase();
  return raw !== "0" && raw !== "false";
}

/**
 * Kept in sync by hand with the vendor's own non-terminal-run triple
 * (`EXECUTION_PATH_HEARTBEAT_RUN_STATUSES` /
 * `CANCELLABLE_HEARTBEAT_RUN_STATUSES` in server/src/services/heartbeat.ts,
 * both `["queued", "running", "scheduled_retry"]`) rather than importing it:
 * that file has no export for either constant, and this is a new-file-only
 * module (CONVENTIONS.md §4) that keeps its point of contact with vendor
 * code to the labeled call site in routes/issues.ts.
 */
const LIVE_RUN_STATUSES = new Set(["running", "queued", "scheduled_retry"]);

export interface IssueWriteRunLockRefs {
  checkoutRunId?: string | null;
  executionRunId?: string | null;
}

export interface HeartbeatRunLookup {
  getRun(runId: string): Promise<{ status?: string | null } | null>;
}

export interface IssueWriteRunLockResult {
  /** True when a checkout/execution run behind the issue is still live. */
  live: boolean;
  /** The live run's id; set only when `live` is true. */
  liveRunId: string | null;
}

/**
 * Looks up the run(s) named on the issue's lock refs and reports whether
 * either is still live. The execution run is checked first: once a run is
 * under way it is the one actually doing work, and it is more often set than
 * the checkout run at that point.
 */
export async function findLiveIssueWriteRunLock(
  heartbeat: HeartbeatRunLookup,
  issue: IssueWriteRunLockRefs,
): Promise<IssueWriteRunLockResult> {
  const candidateRunIds = [
    ...new Set(
      [issue.executionRunId, issue.checkoutRunId].filter(
        (id): id is string => Boolean(id),
      ),
    ),
  ];
  for (const runId of candidateRunIds) {
    const run = await heartbeat.getRun(runId);
    if (run?.status && LIVE_RUN_STATUSES.has(run.status)) {
      return { live: true, liveRunId: runId };
    }
  }
  return { live: false, liveRunId: null };
}

/**
 * Entry point for the write-lock call site. Honors
 * MYRMIDON_WRITE_LOCK_REQUIRES_LIVE_RUN: when explicitly disabled, this
 * unconditionally reports the lock as live (heartbeat is never consulted),
 * reproducing the pre-L5 status-only lock — the caller only reaches this
 * function once `issue.status === "in_progress"`, and that used to be
 * reason enough on its own to deny a different agent's write.
 */
export async function resolveIssueWriteAssigneeRunLock(
  heartbeat: HeartbeatRunLookup,
  issue: IssueWriteRunLockRefs,
  env: NodeJS.ProcessEnv = process.env,
): Promise<IssueWriteRunLockResult> {
  if (!isWriteLockLiveRunCheckEnabled(env)) {
    return {
      live: true,
      liveRunId: issue.executionRunId ?? issue.checkoutRunId ?? null,
    };
  }
  return findLiveIssueWriteRunLock(heartbeat, issue);
}
