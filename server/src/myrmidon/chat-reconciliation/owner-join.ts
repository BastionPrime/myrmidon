// myrmidon(D1): query-fragment helpers used from a single call site in
// server/src/services/chat-channels.ts (enqueueInboundWakeupPublications).
// See docs/myrmidon/DIVERGENCE.md.
import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

// A JSON payload's coalescedIntoWakeupRequestId is always written from a real
// agent_wakeup_requests uuid (see modules/wake-queue/application/use-cases.ts),
// but the value round-trips through jsonb ->> text. Casting straight to uuid
// would throw the whole batch query out for one malformed/legacy payload;
// this shape check keeps the cast total by falling through to NULL instead.
const UUID_SHAPE =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

/**
 * The uuid-typed replacement for the historical
 * `chat_notice_owner.id::text = coalesce(payload->>'coalescedIntoWakeupRequestId', id::text)`
 * self-join on agent_wakeup_requests. Comparing as text defeats the uuid
 * primary key index on the owner side and forces Postgres to build a hash (or
 * sort-merge) join over the *entire* agent_wakeup_requests table on every
 * call; comparing as uuid lets it probe the owner's primary key index for
 * just the small set of already-filtered candidate rows instead. Verified
 * equivalent against a production-shaped snapshot: 0 mismatches comparing the
 * old text-cast join to this one across every agent_wakeup_requests row, and
 * 0 rows where coalescedIntoWakeupRequestId is present but not uuid-shaped.
 */
export function coalescedOwnerId(
  payload: AnyPgColumn,
  selfId: AnyPgColumn,
): SQL {
  const rawText = sql`(${payload} ->> 'coalescedIntoWakeupRequestId')`;
  const asUuidOrNull = sql`(case when ${rawText} ~ ${UUID_SHAPE} then ${rawText}::uuid end)`;
  return sql`coalesce(${asUuidOrNull}, ${selfId})`;
}
