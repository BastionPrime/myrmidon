// myrmidon(D1): companion index for the inbound-wakeup notice sweep's
// periodic full rescan (server/src/services/chat-channels.ts,
// enqueueInboundWakeupPublications) and its sweep-cursor keyset scan. See
// docs/myrmidon/DIVERGENCE.md.
import { describe, expect, it, afterEach } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

d("chat_actions inbound-wakeup sweep index migration", () => {
  it("applies the migration and the planner uses the new index", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("pap0281-idx-");
    cleanups.push(() => dbh.cleanup());
    const sql = postgres(dbh.connectionString, { max: 1 });
    cleanups.push(async () => {
      await sql.end();
    });

    const idx = await sql`SELECT indexname FROM pg_indexes WHERE tablename = 'chat_actions'`;
    const names = idx.map((r) => r.indexname as string);
    expect(names).toContain("chat_actions_inbound_wakeup_sweep_idx");

    // Same shape as enqueueInboundWakeupPublications' WHERE + ORDER BY:
    // equality on kind/status, then a keyset predicate and sort on
    // (created_at, id). An empty table plans a single index scan once
    // sequential scans are disabled, which is enough to prove the planner
    // has a usable index for this filter/order.
    await sql.unsafe("SET enable_seqscan = off");
    const plan = await sql.unsafe(
      `EXPLAIN SELECT 1 FROM chat_actions
       WHERE kind = 'inbound_wakeup'
         AND status IN ('processed', 'failed')
         AND (created_at, id) > (now(), '00000000-0000-0000-0000-000000000000'::uuid)
       ORDER BY created_at, id`,
    );
    const planText = plan.map((r) => Object.values(r)[0]).join("\n");
    expect(planText).toContain("chat_actions_inbound_wakeup_sweep_idx");

    // Idempotency: re-applying the migration statement against an already
    // migrated database must be a no-op, not an error.
    await sql.unsafe(
      `CREATE INDEX IF NOT EXISTS "chat_actions_inbound_wakeup_sweep_idx" ON "chat_actions" USING btree ("kind","status","created_at","id")`,
    );
  }, 90_000);
});
