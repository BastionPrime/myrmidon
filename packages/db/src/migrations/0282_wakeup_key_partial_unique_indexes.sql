-- myrmidon(WAKE-KEYS-UNIQUE): two wake keys were idempotent in name only.
--
-- `pause_resume:<issueId>` (server/src/myrmidon/pause-drain.ts) is enqueued
-- once per stranded issue right after an operator resumes a paused agent. Two
-- resumes that race — a repeated POST, or a resume racing the sweep it started
-- — both read the same "the issue has no live run" snapshot and both insert.
--
-- `myrmidon.stranded_autopolicy_retry:<issueId>:<sourceRunId>`
-- (server/src/myrmidon/stranded-autopolicy.ts) is enqueued by the stale-run
-- sweep, by the wake queue and by direct heartbeat.ts callers that all reach
-- escalateStrandedAssignedIssue with the same stale `latestRun` snapshot. The
-- caller-side existence check cannot see a row another transaction has not
-- committed yet.
--
-- In both cases the second wake starts a second run for work that is already
-- claimed: the duplicate wakes that pile up on a pause/resume cycle and on a
-- stranded retry. A partial unique index is the only check that closes the
-- window, because every caller decides from a snapshot it read before the
-- insert. The enqueue paths already treat a rejected wake as best-effort
-- (pause-drain.ts logs and continues), so the index turns a silent duplicate
-- into a logged miss.
--
-- The repair below has to run before the indexes exist: CREATE UNIQUE INDEX
-- fails on a table that already holds duplicates, and a production board holds
-- them today (the operator counts them before the rollout). Drizzle applies
-- migrations transactionally, so CONCURRENTLY is unavailable; writers cannot
-- observe the repaired table without the indexes, and the indexes cannot admit
-- a new duplicate before the repair commits.
--
-- Preserve the most meaningful run-backed wake as the canonical key holder.
-- Terminal and actively executing duplicates keep their status and run link;
-- they are re-keyed outside the canonical namespace with audit metadata. Only
-- duplicate work that has not acquired a run and is safe to retire is marked
-- skipped. In particular, claimed/running work is never falsely cancelled.
WITH ranked AS (
  SELECT
    "id",
    "idempotency_key" AS "original_idempotency_key",
    "status" AS "previous_status",
    "run_id" AS "linked_run_id",
    first_value("id") OVER (
      PARTITION BY "company_id", "idempotency_key"
      ORDER BY
        CASE
          WHEN "run_id" IS NOT NULL AND "status" IN ('succeeded', 'completed', 'coalesced') THEN 0
          WHEN "run_id" IS NOT NULL AND "status" IN ('running', 'claimed') THEN 1
          WHEN "run_id" IS NOT NULL THEN 2
          WHEN "status" IN ('running', 'claimed') THEN 3
          WHEN "status" IN ('queued', 'deferred_issue_execution', 'retrying', 'scheduled_retry') THEN 4
          ELSE 5
        END,
        "requested_at" ASC,
        "created_at" ASC,
        "id" ASC
    ) AS "retained_id",
    row_number() OVER (
      PARTITION BY "company_id", "idempotency_key"
      ORDER BY
        CASE
          WHEN "run_id" IS NOT NULL AND "status" IN ('succeeded', 'completed', 'coalesced') THEN 0
          WHEN "run_id" IS NOT NULL AND "status" IN ('running', 'claimed') THEN 1
          WHEN "run_id" IS NOT NULL THEN 2
          WHEN "status" IN ('running', 'claimed') THEN 3
          WHEN "status" IN ('queued', 'deferred_issue_execution', 'retrying', 'scheduled_retry') THEN 4
          ELSE 5
        END,
        "requested_at" ASC,
        "created_at" ASC,
        "id" ASC
    ) AS "ordinal"
  FROM "agent_wakeup_requests"
  WHERE (
      "idempotency_key" LIKE 'pause_resume:%'
      OR "idempotency_key" LIKE 'myrmidon.stranded_autopolicy_retry:%'
    )
    AND "status" NOT IN ('skipped', 'failed', 'cancelled')
), duplicates AS (
  SELECT * FROM ranked WHERE "ordinal" > 1
)
UPDATE "agent_wakeup_requests" AS wake
SET
  "idempotency_key" = CASE
    WHEN duplicates."linked_run_id" IS NULL
      AND duplicates."previous_status" IN ('queued', 'deferred_issue_execution', 'retrying', 'scheduled_retry')
      THEN duplicates."original_idempotency_key"
    ELSE 'historical-duplicate-wake:' || wake."id"::text
  END,
  "status" = CASE
    WHEN duplicates."linked_run_id" IS NULL
      AND duplicates."previous_status" IN ('queued', 'deferred_issue_execution', 'retrying', 'scheduled_retry')
      THEN 'skipped'
    ELSE wake."status"
  END,
  "finished_at" = CASE
    WHEN duplicates."linked_run_id" IS NULL
      AND duplicates."previous_status" IN ('queued', 'deferred_issue_execution', 'retrying', 'scheduled_retry')
      THEN COALESCE(wake."finished_at", now())
    ELSE wake."finished_at"
  END,
  "error" = CASE
    WHEN duplicates."linked_run_id" IS NULL
      AND duplicates."previous_status" IN ('queued', 'deferred_issue_execution', 'retrying', 'scheduled_retry')
      THEN concat_ws(
        E'\n',
        NULLIF(wake."error", ''),
        'Safely retired duplicate by migration 0282; retained wake request ' || duplicates."retained_id"::text
      )
    ELSE wake."error"
  END,
  "payload" = COALESCE(wake."payload", '{}'::jsonb) || jsonb_build_object(
    'migrationDedupe', jsonb_build_object(
      'migration', '0282_wakeup_key_partial_unique_indexes',
      'retainedWakeRequestId', duplicates."retained_id",
      'originalIdempotencyKey', duplicates."original_idempotency_key",
      'previousStatus', duplicates."previous_status",
      'linkedRunId', duplicates."linked_run_id",
      'resolution', CASE
        WHEN duplicates."linked_run_id" IS NULL
          AND duplicates."previous_status" IN ('queued', 'deferred_issue_execution', 'retrying', 'scheduled_retry')
          THEN 'retired_unstarted_duplicate'
        ELSE 'rekeyed_preserving_execution_history'
      END
    )
  ),
  "updated_at" = now()
FROM duplicates
WHERE wake."id" = duplicates."id";--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable. agent_wakeup_requests is a known large table; the duplicate repair above commits atomically with both indexes, so no writer can observe a duplicate whose key is already indexed.
CREATE UNIQUE INDEX IF NOT EXISTS "agent_wakeup_requests_pause_resume_idempotency_uq" ON "agent_wakeup_requests" USING btree ("company_id","idempotency_key") WHERE "agent_wakeup_requests"."idempotency_key" LIKE 'pause_resume:%' AND "agent_wakeup_requests"."status" NOT IN ('skipped', 'failed', 'cancelled');--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: same statement shape as the index above, in the same transaction; the stranded-retry key needs its own predicate because the two key families are independent.
CREATE UNIQUE INDEX IF NOT EXISTS "agent_wakeup_requests_stranded_autopolicy_retry_idempotency_uq" ON "agent_wakeup_requests" USING btree ("company_id","idempotency_key") WHERE "agent_wakeup_requests"."idempotency_key" LIKE 'myrmidon.stranded_autopolicy_retry:%' AND "agent_wakeup_requests"."status" NOT IN ('skipped', 'failed', 'cancelled');