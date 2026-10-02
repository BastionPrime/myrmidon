import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { collectRows, gatewayKeyHash, loadRunWindows } from "./litellm-costs.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

describeEmbeddedPostgres("myrmidon(M2-A) run windows from the database", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-litellm-costs-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns a live run (no finishedAt) and attributes a row to it and its issue", async () => {
    const company = await db
      .insert(companies)
      .values({ name: `company-a ${randomUUID()}`, issuePrefix: `LC${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning()
      .then((rows) => rows[0]!);
    const agent = await db
      .insert(agents)
      .values({ companyId: company.id, name: "agent-a", role: "engineer", permissions: {}, adapterType: "process", adapterConfig: {}, runtimeConfig: {} })
      .returning()
      .then((rows) => rows[0]!);
    const issueId = randomUUID();
    const startedAt = new Date("2026-09-30T10:00:00Z");
    const live = await db
      .insert(heartbeatRuns)
      .values({
        companyId: company.id,
        agentId: agent.id,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "running",
        startedAt,
        finishedAt: null,
        contextSnapshot: { issueId },
      })
      .returning()
      .then((rows) => rows[0]!);

    const window = { from: new Date("2026-09-30T10:05:00Z"), to: new Date("2026-09-30T10:10:00Z") };
    const windows = await loadRunWindows(db, company.id, window);
    expect(windows.map((w) => w.runId)).toEqual([live.id]);
    expect(windows[0]!.finishedAt).toBeNull();

    const key = "sk-test-key-agent-a";
    const { rows } = collectRows(
      [
        {
          requestId: "req-live",
          apiKey: gatewayKeyHash(key),
          spend: 0.01,
          promptTokens: 10,
          completionTokens: 5,
          startTime: "2026-09-30T10:06:00Z",
          model: "openai/example-model",
          provider: "openai",
        },
      ],
      new Map([[gatewayKeyHash(key), agent.id]]),
      windows,
    );
    expect(rows[0]).toMatchObject({ heartbeatRunId: live.id, issueId });
  });
});
