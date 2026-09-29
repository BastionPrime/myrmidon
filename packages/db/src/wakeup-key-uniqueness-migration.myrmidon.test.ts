// myrmidon(WAKE-KEYS-UNIQUE): companion test for migration
// 0282_wakeup_key_partial_unique_indexes.sql. The migrated test database
// already carries both indexes, so the test drops them first: the seeded
// duplicates have to model the pre-migration table the repair has to fix.
// See docs/myrmidon/DIVERGENCE.md.
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

const PAUSE_RESUME_INDEX = "agent_wakeup_requests_pause_resume_idempotency_uq";
const STRANDED_RETRY_INDEX =
  "agent_wakeup_requests_stranded_autopolicy_retry_idempotency_uq";

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function migrationStatements(): Promise<string[]> {
  const migrationSql = await readFile(
    fileURLToPath(
      new URL(
        "./migrations/0282_wakeup_key_partial_unique_indexes.sql",
        import.meta.url,
      ),
    ),
    "utf8",
  );
  return migrationSql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

d("wake key partial unique indexes migration", () => {
  it("repairs the duplicates a seeded board already holds, then refuses the next one", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("pap0282-wake-keys-");
    cleanups.push(() => dbh.cleanup());
    const sql = postgres(dbh.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => {
      await sql.end();
    });

    const company = randomUUID();
    const agent = randomUUID();
    const issue = randomUUID();
    await sql`INSERT INTO companies (id,name,issue_prefix) VALUES (${company},'Fixture',${company.slice(0, 8)})`;
    await sql`INSERT INTO agents (id,company_id,name) VALUES (${agent},${company},'Agent')`;

    // The pre-migration table: both key families hold a run-backed row and a
    // second row that raced it (the duplicate wake the release queue saw).
    await sql.unsafe(`DROP INDEX IF EXISTS "${PAUSE_RESUME_INDEX}"`);
    await sql.unsafe(`DROP INDEX IF EXISTS "${STRANDED_RETRY_INDEX}"`);
    const pauseKey = `pause_resume:${issue}`;
    const strandedKey = `myrmidon.stranded_autopolicy_retry:${issue}:${randomUUID()}`;
    const runningRun = randomUUID();
    const strandedRun = randomUUID();
    await sql`
      INSERT INTO agent_wakeup_requests (company_id,agent_id,source,status,idempotency_key,run_id)
      VALUES
        (${company},${agent},'automation','running',${pauseKey},${runningRun}),
        (${company},${agent},'automation','queued',${pauseKey},NULL),
        (${company},${agent},'automation','succeeded',${strandedKey},${strandedRun}),
        (${company},${agent},'automation','running',${strandedKey},${randomUUID()})
    `;

    const statements = await migrationStatements();
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) await sql.unsafe(statement);

    // The run-backed row keeps the canonical key. The queued duplicate is
    // retired (skipped, so it leaves the predicate) and the second running row
    // is re-keyed outside the namespace with its execution history intact.
    const rows = await sql<
      { idempotency_key: string; status: string; run_id: string | null }[]
    >`
      SELECT idempotency_key, status, run_id
      FROM agent_wakeup_requests
      WHERE company_id = ${company}
    `;
    expect(rows).toHaveLength(4);
    const keyed = (key: string) =>
      rows
        .filter((row) => row.idempotency_key === key)
        .map((row) => [row.status, row.run_id] as const)
        .sort();
    expect(keyed(pauseKey)).toEqual([
      ["running", runningRun],
      ["skipped", null],
    ]);
    expect(keyed(strandedKey)).toEqual([["succeeded", strandedRun]]);
    const rekeyed = rows.filter((row) =>
      row.idempotency_key.startsWith("historical-duplicate-wake:"),
    );
    expect(rekeyed).toHaveLength(1);
    expect(rekeyed[0]?.status).toBe("running");
    expect(rekeyed[0]?.run_id).not.toBe(strandedRun);

    const indexes = await sql`SELECT indexname FROM pg_indexes WHERE indexname IN (${PAUSE_RESUME_INDEX}, ${STRANDED_RETRY_INDEX})`;
    expect(indexes.map((row) => row.indexname).sort()).toEqual(
      [PAUSE_RESUME_INDEX, STRANDED_RETRY_INDEX].sort(),
    );

    // The window the two callers' snapshots left open is now closed...
    await expect(
      sql`INSERT INTO agent_wakeup_requests (company_id,agent_id,source,status,idempotency_key)
          VALUES (${company},${agent},'automation','running',${pauseKey})`,
    ).rejects.toMatchObject({ code: "23505" });

    // ...while a terminal wake of the same key is still admitted, so a refused
    // or failed wake never blocks the next legitimate one.
    await sql`INSERT INTO agent_wakeup_requests (company_id,agent_id,source,status,idempotency_key)
              VALUES (${company},${agent},'automation','skipped',${pauseKey})`;

    // Idempotency: re-applying the migration against an already migrated
    // database must be a no-op, not an error.
    for (const statement of statements) await sql.unsafe(statement);
  }, 240_000);
});