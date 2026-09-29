// myrmidon(D1): behavioral test for inboundCommentCandidateIds' generated
// SQL against a real Postgres engine. See docs/myrmidon/DIVERGENCE.md.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { inboundCommentCandidateIds } from "./inbound-comment-candidates.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("inboundCommentCandidateIds", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-inbound-comment-candidates-");
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
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function candidatesFor(contextSnapshot: Record<string, unknown>): Promise<string[]> {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "running",
      contextSnapshot,
    });
    const [row] = await db
      .select({ candidates: inboundCommentCandidateIds(heartbeatRuns.contextSnapshot) })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    return (row?.candidates as unknown as string[]) ?? [];
  }

  it("collects wakeCommentId and commentId", async () => {
    const wakeCommentId = randomUUID();
    const commentId = randomUUID();
    const candidates = await candidatesFor({ wakeCommentId, commentId });

    expect(new Set(candidates)).toEqual(new Set([wakeCommentId, commentId]));
  });

  it("collects every entry of wakeCommentIds", async () => {
    const wakeCommentIds = [randomUUID(), randomUUID(), randomUUID()];
    const candidates = await candidatesFor({ wakeCommentIds });

    expect(new Set(candidates)).toEqual(new Set(wakeCommentIds));
  });

  it("combines all three sources and drops nulls", async () => {
    const wakeCommentId = randomUUID();
    const commentId = randomUUID();
    const wakeCommentIds = [randomUUID(), randomUUID()];
    const candidates = await candidatesFor({ wakeCommentId, commentId, wakeCommentIds });

    expect(new Set(candidates)).toEqual(
      new Set([wakeCommentId, commentId, ...wakeCommentIds]),
    );
  });

  it("returns an empty set when context_snapshot names no comment", async () => {
    const candidates = await candidatesFor({ source: "chat:telegram" });

    expect(candidates).toEqual([]);
  });

  it("does not throw when wakeCommentIds is a JSON null instead of an array", async () => {
    const commentId = randomUUID();
    const candidates = await candidatesFor({
      commentId,
      wakeCommentIds: null,
    });

    expect(candidates).toEqual([commentId]);
  });

  it("does not throw when wakeCommentIds is a scalar instead of an array", async () => {
    const wakeCommentId = randomUUID();
    // A legacy/malformed context_snapshot: wakeCommentIds as a bare string
    // rather than an array. jsonb_array_elements_text() would throw on this
    // without the jsonb_typeof guard, aborting the whole sweep query.
    const candidates = await candidatesFor({
      wakeCommentId,
      wakeCommentIds: "not-an-array",
    });

    expect(candidates).toEqual([wakeCommentId]);
  });

  it("does not throw when wakeCommentIds is an object instead of an array", async () => {
    const commentId = randomUUID();
    const candidates = await candidatesFor({
      commentId,
      wakeCommentIds: { unexpected: "shape" },
    });

    expect(candidates).toEqual([commentId]);
  });
});
