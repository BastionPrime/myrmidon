// myrmidon(D1): companion index for the chat run-milestone reconciliation
// rewrite in server/src/services/chat-run-publications.ts. See
// docs/myrmidon/DIVERGENCE.md and docs/myrmidon/SETTINGS.md.
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

d("chat_message_links inbound-link index migration", () => {
  it("applies the migration and the planner uses the new index", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("pap0280-idx-");
    cleanups.push(() => dbh.cleanup());
    const sql = postgres(dbh.connectionString, { max: 1 });
    cleanups.push(async () => {
      await sql.end();
    });

    const idx = await sql`SELECT indexname FROM pg_indexes WHERE tablename = 'chat_message_links'`;
    const names = idx.map((r) => r.indexname as string);
    expect(names).toContain("chat_message_links_inbound_link_idx");

    // Without the index, this predicate — the same shape used by
    // enqueueChatRunMilestones' inbound-link EXISTS check — can only be
    // satisfied by a full scan. An empty table plans a single index scan once
    // sequential scans are disabled, which is enough to prove the planner has
    // a usable index for (company_id, conversation_id, direction, comment_id).
    await sql.unsafe("SET enable_seqscan = off");
    const plan = await sql.unsafe(
      `EXPLAIN SELECT 1 FROM chat_message_links
       WHERE company_id = '00000000-0000-0000-0000-000000000001'
         AND conversation_id = '00000000-0000-0000-0000-000000000002'
         AND direction = 'inbound'
         AND comment_id = '00000000-0000-0000-0000-000000000003'`,
    );
    const planText = plan.map((r) => Object.values(r)[0]).join("\n");
    expect(planText).toContain("chat_message_links_inbound_link_idx");

    // Idempotency: re-applying the migration statement against an already
    // migrated database must be a no-op, not an error.
    await sql.unsafe(
      `CREATE INDEX IF NOT EXISTS "chat_message_links_inbound_link_idx" ON "chat_message_links" USING btree ("company_id","conversation_id","direction","comment_id")`,
    );
  }, 90_000);
});
