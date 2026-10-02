// myrmidon(D2): EXPLAIN guard for the board DB hot-path rewrite. See
// docs/myrmidon/DIVERGENCE.md.
//
// The sweeps used to compare a uuid column against a JSON text field after
// casting the column to text (`issue_comments.id::text = payload->>'commentId'`,
// `heartbeat_runs.id::text = evidence->>'runId'`,
// `agent_wakeup_requests.id::text = ...`). A cast column cannot use its
// primary-key index, so Postgres fell back to scanning the whole table on
// every call (roughly 60 billion rows read by sequential scan on production
// since 22.09). The comparisons now go through jsonTextUuid() from
// ./json-uuid.js; this test pins the planner behaviour that unlocks it: the
// primary-key indexes serve the sweeps again, and no sweep sequentially scans
// issue_comments, agent_wakeup_requests or heartbeat_runs.
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  chatActions,
  chatConversations,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { jsonTextUuid } from "./json-uuid.js";

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

d("board DB hot-path uuid comparisons", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentId!: string;
  let issueId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("pap-d2-hotpath-");
    db = createDb(tempDb.connectionString);

    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Worker",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Hot path seed" });

    // Seed the three hot tables large enough for the planner to prefer an
    // index over a sequential scan when one is available.
    await db.execute(sql`
      INSERT INTO heartbeat_runs (id, company_id, agent_id, status, context_snapshot)
      SELECT gen_random_uuid(), ${companyId}::uuid, ${agentId}::uuid, 'succeeded',
             jsonb_build_object('issueId', ${issueId}::text)
      FROM generate_series(1, 3000)
    `);
    await db.execute(sql`
      INSERT INTO issue_comments (id, company_id, issue_id, body, author_type, deleted_at)
      SELECT gen_random_uuid(), ${companyId}::uuid, ${issueId}::uuid, 'body', 'user', now()
      FROM generate_series(1, 3000)
    `);
    await db.execute(sql`
      INSERT INTO agent_wakeup_requests (id, company_id, agent_id, source, status)
      SELECT gen_random_uuid(), ${companyId}::uuid, ${agentId}::uuid, 'automation', 'queued'
      FROM generate_series(1, 3000)
    `);
    await db.execute(sql`ANALYZE`);
  }, 180_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function explain(query: unknown): Promise<string> {
    const rows = (await db.execute(sql`EXPLAIN ${query as never}`)) as unknown as Array<
      Record<string, unknown>
    >;
    return rows.map((row) => Object.values(row)[0]).join("\n");
  }

  it("finds issue_comments by primary key, not a sequential scan", async () => {
    const plan = await explain(
      db
        .select({ id: issueComments.id })
        .from(issueComments)
        // Same shape as the chat bridge sweep's `removed_comment` probe.
        .where(eq(issueComments.id, jsonTextUuid(sql`${randomUUID()}`))),
    );
    expect(plan).toContain("issue_comments_pkey");
    expect(plan).not.toMatch(/Seq Scan on issue_comments/);
  });

  it("finds heartbeat_runs by primary key, not a sequential scan", async () => {
    const plan = await explain(
      db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        // Same shape as the issue_recovery_actions lookup's run-id join.
        .where(eq(heartbeatRuns.id, jsonTextUuid(sql`${randomUUID()}`))),
    );
    expect(plan).toContain("heartbeat_runs_pkey");
    expect(plan).not.toMatch(/Seq Scan on heartbeat_runs/);
  });

  it("finds agent_wakeup_requests by primary key, not a sequential scan", async () => {
    const plan = await explain(
      db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        // Same shape as the interrupted-queue recovery sweep's wakeup join.
        .where(eq(agentWakeupRequests.id, jsonTextUuid(sql`${randomUUID()}`))),
    );
    expect(plan).toContain("agent_wakeup_requests_pkey");
    expect(plan).not.toMatch(/Seq Scan on agent_wakeup_requests/);
  });

  it("keeps the chat bridge sweep's removed-comment probe indexed", async () => {
    const removedComment = alias(issueComments, "removed_comment");
    const plan = await explain(
      db
        .select({ id: chatActions.id, removedId: removedComment.id })
        .from(chatActions)
        .leftJoin(
          removedComment,
          and(
            eq(removedComment.companyId, chatActions.companyId),
            eq(removedComment.issueId, jsonTextUuid(sql`${chatActions.payload}->>'issueId'`)),
            eq(removedComment.id, jsonTextUuid(sql`${chatActions.payload}->>'commentId'`)),
            isNotNull(removedComment.deletedAt),
          ),
        )
        .where(
          and(
            eq(chatActions.kind, "inbound_wakeup"),
            inArray(chatActions.status, ["processed", "failed"]),
          ),
        ),
    );
    expect(plan).not.toMatch(/Seq Scan on issue_comments/);
  });

  it("keeps the heartbeat_runs <-> chat_conversations join indexed", async () => {
    await db.execute(sql`SET enable_seqscan = off`);
    try {
      const plan = await explain(
        db
          .select({ id: heartbeatRuns.id })
          .from(chatConversations)
          .innerJoin(
            heartbeatRuns,
            and(
              eq(heartbeatRuns.companyId, chatConversations.companyId),
              eq(heartbeatRuns.agentId, agentId),
              eq(sql<string>`${heartbeatRuns.contextSnapshot}->>'issueId'`, sql<string>`${chatConversations.issueId}::text`),
              inArray(heartbeatRuns.status, ["queued", "running"]),
            ),
          )
          .where(
            and(
              eq(chatConversations.companyId, companyId),
              eq(chatConversations.endpointId, randomUUID()),
              eq(chatConversations.externalThreadId, "thread"),
              inArray(chatConversations.state, ["active", "waiting"]),
            ),
          )
          .limit(1),
      );
      expect(plan).not.toMatch(/Seq Scan on heartbeat_runs/);
    } finally {
      await db.execute(sql`SET enable_seqscan = on`);
    }
  });

  it("serves the heartbeat_runs issue-id join from an expression index", async () => {
    const rows = (await db.execute(
      sql`SELECT indexname FROM pg_indexes WHERE tablename = 'heartbeat_runs'`,
    )) as unknown as Array<{ indexname: string }>;
    const names = rows.map((row) => row.indexname);
    expect(names).toContain("heartbeat_runs_company_ctx_issue_created_idx");
  });

  it("removes the operator's ad-hoc hotfix indexes", async () => {
    const rows = (await db.execute(
      sql`SELECT indexname FROM pg_indexes`,
    )) as unknown as Array<{ indexname: string }>;
    const names = rows.map((row) => row.indexname);
    expect(names).not.toContain("myr_hotfix_issue_comments_id_text");
    expect(names).not.toContain("myr_hotfix_wakeup_id_text");
    expect(names).not.toContain("myr_hotfix_heartbeat_runs_id_text");
  });
});