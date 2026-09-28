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
 * chat_actions row. The original code reset to the very start whenever a
 * page came back shorter than the page size — the common case, since a real
 * match is rare — turning every poll into a full-history rescan.
 */
export function nextSweepCursor<Cursor>(
  current: Cursor | null,
  page: readonly Cursor[],
): Cursor | null {
  return page.at(-1) ?? current;
}
