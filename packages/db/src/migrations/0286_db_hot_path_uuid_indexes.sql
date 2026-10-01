-- myrmidon(D2): the board DB hot path compared uuid columns as text —
-- `issue_comments.id::text = payload->>'commentId'`,
-- `agent_wakeup_requests.id::text = coalesce(payload->>'coalescedIntoWakeupRequestId', id::text)`,
-- `heartbeat_runs.id::text = evidence->>'runId'`. A text-cast column cannot use
-- its primary-key index, so every chat and recovery sweep scanned the whole
-- table; on production that added up to roughly 60 billion rows read by
-- sequential scan since 22.09 and drove the database to 270-470% CPU.
--
-- The predicates now compare uuid-typed, guarded values
-- (server/src/myrmidon/db-hot-path/json-uuid.ts), so the primary-key indexes
-- serve them again and no new index is required for those lookups. The one
-- expression-index need that remains — the
-- `heartbeat_runs.context_snapshot->>'issueId'` join to chat_conversations —
-- is already covered by the vendor expression index
-- `heartbeat_runs_company_ctx_issue_created_idx` (migration 0209). See
-- docs/myrmidon/DIVERGENCE.md.
--
-- myrmidon(D2): the operator created three ad-hoc expression indexes
-- (`myr_hotfix_*`) on production with CREATE INDEX CONCURRENTLY to stop the
-- bleeding. They live outside the migration history (schema drift) and are no
-- longer needed once the predicates are typed, so this migration drops them.
DROP INDEX IF EXISTS "myr_hotfix_issue_comments_id_text";--> statement-breakpoint
DROP INDEX IF EXISTS "myr_hotfix_wakeup_id_text";--> statement-breakpoint
DROP INDEX IF EXISTS "myr_hotfix_heartbeat_runs_id_text";