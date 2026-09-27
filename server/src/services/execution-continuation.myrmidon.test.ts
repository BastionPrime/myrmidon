import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issueComments, issues } from "@paperclipai/db";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { buildExecutionContinuation } from "./execution-continuation.js";

// P3: a long task history must not grow the continuation without bound.
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("continuation history limit (P3)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const agentId = randomUUID();
  const issueId = randomUUID();
  const commentIds: string[] = [];
  const COMMENT_COUNT = 500;
  const originalRequest = "Original request: draft the release notes for agent-a.";
  const latestRequest = "Latest request: also add a migration section.";
  const previousLimit = process.env.MYRMIDON_CONTINUATION_HISTORY_LIMIT;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-continuation-limit-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "company-a", issuePrefix: "LIM" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "agent-a",
      role: "engineer",
      adapterType: "paperclip_runner",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Long task",
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    const start = Date.parse("2026-09-01T00:00:00Z");
    const rows = Array.from({ length: COMMENT_COUNT }, (_, index) => {
      const id = randomUUID();
      commentIds.push(id);
      const isFirst = index === 0;
      // The latest user request sits well before the newest 30 entries, followed by agent chatter.
      const isLatestRequest = index === 200;
      const isUser = isFirst || isLatestRequest;
      return {
        id,
        companyId,
        issueId,
        authorType: isUser ? ("user" as const) : ("agent" as const),
        authorUserId: isUser ? "user-a" : null,
        authorAgentId: isUser ? null : agentId,
        body: isFirst
          ? originalRequest
          : isLatestRequest
            ? latestRequest
            : `Progress note ${index}: ${"x".repeat(400)}`,
        createdAt: new Date(start + index * 60_000),
      };
    });
    await db.insert(issueComments).values(rows);
  }, 60_000);

  afterAll(async () => {
    await database?.cleanup();
  });

  afterEach(() => {
    if (previousLimit === undefined) delete process.env.MYRMIDON_CONTINUATION_HISTORY_LIMIT;
    else process.env.MYRMIDON_CONTINUATION_HISTORY_LIMIT = previousLimit;
  });

  const build = () =>
    buildExecutionContinuation({
      db,
      companyId,
      issueId,
      agentId,
      context: { wakeReason: "issue_commented", commentId: commentIds[200] },
      summary: null,
      exposeLowTrustRaw: false,
    });

  it("keeps at most the default 30 messages of 500, with the original and latest requests and an omission notice", async () => {
    delete process.env.MYRMIDON_CONTINUATION_HISTORY_LIMIT;
    const envelope = await build();

    expect(envelope.messages.length).toBeLessThanOrEqual(30);
    const bodies = envelope.messages.map((message) => message.body);
    expect(bodies).toContain(originalRequest);
    expect(bodies).toContain(latestRequest);
    expect(envelope.messages.at(-1)?.id).toBe(commentIds[COMMENT_COUNT - 1]);
    expect(envelope.objective).toBe(latestRequest);
    expect(envelope.coverage.throughCommentId).toBe(commentIds[COMMENT_COUNT - 1]);

    const limited = envelope as typeof envelope & {
      historyTruncation?: Record<string, { kept: number; dropped: number; total: number }>;
      truncationNotice?: string;
    };
    expect(limited.historyTruncation?.messages).toEqual({ kept: 30, dropped: 470, total: 500 });
    expect(limited.truncationNotice).toContain("messages 470 of 500");

    const prompt = renderPaperclipWakePrompt({ executionContinuation: envelope }, { resumedSession: false });
    expect(prompt).toContain("messages 470 of 500");
    expect(prompt).toContain(originalRequest);
    expect(prompt).toContain(latestRequest);
    expect(Buffer.byteLength(prompt)).toBeLessThan(131_072);
  });

  it("honors a custom limit", async () => {
    process.env.MYRMIDON_CONTINUATION_HISTORY_LIMIT = "10";
    const envelope = await build();
    expect(envelope.messages).toHaveLength(10);
    expect(envelope.messages.map((message) => message.body)).toEqual(
      expect.arrayContaining([originalRequest, latestRequest]),
    );
  });

  it("returns the full history when the limit is 0", async () => {
    process.env.MYRMIDON_CONTINUATION_HISTORY_LIMIT = "0";
    const envelope = await build();
    expect(envelope.messages).toHaveLength(COMMENT_COUNT);
    expect("truncationNotice" in envelope).toBe(false);
  });
});
