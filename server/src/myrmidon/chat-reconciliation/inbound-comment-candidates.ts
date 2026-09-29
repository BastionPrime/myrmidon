// myrmidon(D1): query-fragment helper used from a single call site in
// server/src/services/chat-run-publications.ts (enqueueChatRunMilestones).
// See docs/myrmidon/DIVERGENCE.md.
import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/**
 * The set of comment ids that would count as "the inbound message this run
 * replied to" — read once per run's context_snapshot, instead of once per
 * chat_message_links row a correlated EXISTS considers.
 *
 * context_snapshot can be very large (seen up to several hundred KB on a
 * production-shaped copy of the database). Writing the three lookups
 * (wakeCommentId, commentId, wakeCommentIds[]) directly inside an EXISTS's
 * filter, as the historical code did, makes Postgres re-extract and
 * re-detoast that jsonb column once per candidate row the inner index scan
 * considers, not once per outer run — the dominant cost of the run-milestone
 * reconciliation sweep. `ARRAY(SELECT ...)`, referencing only the outer run's
 * own columns, gives the planner an uncorrelated-to-the-inner-scan subplan it
 * can hoist into a single per-row InitPlan instead. Measured on a
 * production-shaped snapshot (stand): the correlated EXISTS check this feeds
 * went from tens of milliseconds per candidate row to low single digits once
 * hoisted this way, and comparing the two forms across every
 * heartbeat_runs row with a context_snapshot found 0 mismatches.
 */
export function inboundCommentCandidateIds(contextSnapshot: AnyPgColumn): SQL {
  // myrmidon(D1): jsonb_array_elements_text() throws (instead of returning no
  // rows) when its argument is present but not a JSON array — an explicit
  // JSON null, a string, a number or an object. coalesce(x, '[]'::jsonb)
  // alone only substitutes on SQL NULL (key absent), so one legacy/malformed
  // context_snapshot.wakeCommentIds among the candidate rows this is
  // evaluated against would abort the whole sweep. Guard the shape first, the
  // same way heartbeat.ts's stranded-queue scan already does for the
  // equivalent field on agent_wakeup_requests.payload.
  const wakeCommentIds = sql`(case when jsonb_typeof(${contextSnapshot} -> 'wakeCommentIds') = 'array' then ${contextSnapshot} -> 'wakeCommentIds' else '[]'::jsonb end)`;
  return sql`array(
    select candidate.value
    from (
      select ${contextSnapshot} ->> 'wakeCommentId' as value
      union all
      select ${contextSnapshot} ->> 'commentId'
      union all
      select jsonb_array_elements_text(${wakeCommentIds})
    ) candidate
    where candidate.value is not null
  )`;
}
