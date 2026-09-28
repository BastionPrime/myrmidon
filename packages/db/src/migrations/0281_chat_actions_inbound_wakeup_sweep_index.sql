-- myrmidon(D1): chat_actions had no index covering (kind, status,
-- created_at, id). The inbound-wakeup notice sweep
-- (enqueueInboundWakeupPublications) filters on kind/status and
-- keyset-scans in (created_at, id) order, including a periodic full rescan
-- to recover rows whose eligibility resolves later than a sibling row's
-- (see sweep-cursor.ts); without this index every such scan fell back to a
-- sequential scan of the whole table.
CREATE INDEX IF NOT EXISTS "chat_actions_inbound_wakeup_sweep_idx" ON "chat_actions" USING btree ("kind","status","created_at","id");
