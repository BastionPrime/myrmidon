// myrmidon(D1): extracted from chat-channels.ts's
// enqueueInboundWakeupPublications so the keyset-cursor advancement rule can
// be unit tested without a database. See docs/myrmidon/DIVERGENCE.md.

/**
 * The inbound-wakeup notice sweep in
 * server/src/services/chat-channels.ts (enqueueInboundWakeupPublications) is
 * a bounded keyset scan over chat_actions ordered by (created_at, id), not a
 * strictly time-monotonic queue: a chat_actions row only becomes a candidate
 * once its coalesced owner (an agent_wakeup_requests row) reaches a
 * terminal-ish status, which can happen long after the action's own
 * created_at. The cursor therefore only ever advances to the last row an
 * actual page returned; a page with matches always makes forward progress
 * (whether or not it filled the requested page size), and a page with zero
 * matches leaves the cursor exactly where it was, so the next call resumes
 * from the same place instead of rescanning from the very first
 * chat_actions row.
 *
 * Because eligibility does not track created_at order, this alone is not
 * safe on its own: row A (createdAt T1) whose owner is still pending and row
 * B (createdAt T2 > T1) whose owner has already gone terminal can appear in
 * either order across calls. If B is swept first, the cursor advances past
 * T1, and A is then excluded by every future `(created_at, id) > cursor`
 * call — permanently, since the cursor here never moves backward. Pair this
 * function with shouldForceFullSweep, which tells the caller to
 * periodically ignore the stored cursor and scan from the very start, so a
 * row like A is picked up again within one sweep interval of its owner
 * going terminal instead of never.
 */
export function nextSweepCursor<Cursor>(
  current: Cursor | null,
  page: readonly Cursor[],
): Cursor | null {
  return page.at(-1) ?? current;
}

/**
 * Whether the next call of a keyset sweep using nextSweepCursor should
 * ignore its stored cursor and scan from the very start of the table
 * instead — the periodic safety net nextSweepCursor's own doc comment
 * requires.
 *
 * `lastFullSweepAt` is the caller's record of when it last used a null
 * (start-of-table) cursor — null if it never has. `intervalMs` bounds how
 * stale a straggler row can get: at most one interval after its owner goes
 * terminal, instead of forever. The caller is expected to update its
 * `lastFullSweepAt` to `now` on every call where this returns true,
 * regardless of what that call's page contained, so the interval is wall
 * clock time between attempts, not between successful full sweeps.
 */
export function shouldForceFullSweep(
  lastFullSweepAt: number | null,
  now: number,
  intervalMs: number,
): boolean {
  return lastFullSweepAt === null || now - lastFullSweepAt >= intervalMs;
}
