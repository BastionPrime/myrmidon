// myrmidon(STALE-BLOCK): sweep behavior against an embedded Postgres. The four
// switch cases the ticket names: a closed (done) blocker, a cancelled blocker,
// a past due date — all unblocked — and a live blocker, left untouched.

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  issueComments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { createStaleBlockSweep, type StaleBlockSweepDeps } from "./sweep.js";
import { readStaleBlockSignals, resetStaleBlockSignals } from "./attention.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const NOW = new Date("2026-10-03T12:00:00.000Z");

describeEmbeddedPostgres("stale block sweep", () => {
  // myrmidon(STALE-BLOCK): the unblock path goes through the full issue update
  // service with embedded PostgreSQL; under a loaded CI box 15 s is not
  // enough, so this suite uses the same headroom as run-stall's.
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-stale-block-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    resetStaleBlockSignals();
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /**
   * One blocked task with one blocker task of the given status, or with a
   * reasonRef instead of a blocked-by edge. Neutral English fixtures only.
   */
  async function seed(input: {
    blockerStatus?: string;
    withRelation?: boolean;
    unblockDescriptor?: Record<string, unknown> | null;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const blockerIssueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: companyId.replace(/-/g, "").slice(0, 8).toUpperCase(),
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "agent-a",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `SB${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      title: "Task a",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: agentId,
      unblockDescriptor: (input.unblockDescriptor ?? {
        owner: { agentId },
        action: "finish the blocker first",
      }) as any,
      blockedTransitionAt: new Date("2026-09-30T08:00:00.000Z"),
    });
    if (input.blockerStatus !== undefined) {
      await db.insert(issues).values({
        id: blockerIssueId,
        companyId,
        identifier: `BL${blockerIssueId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        title: "Blocker a",
        status: input.blockerStatus,
        priority: "medium",
      });
    }
    if (input.withRelation && input.blockerStatus !== undefined) {
      await db.insert(issueRelations).values({
        companyId,
        issueId: blockerIssueId,
        relatedIssueId: issueId,
        type: "blocks",
      });
    }
    return { companyId, agentId, issueId, blockerIssueId };
  }

  function deps(overrides: Partial<StaleBlockSweepDeps> = {}): StaleBlockSweepDeps {
    return {
      db,
      isEventStillSet: vi.fn(async () => true),
      logActivity: vi.fn(async () => undefined),
      env: { MYRMIDON_STALE_BLOCK_ENABLED: "1", MYRMIDON_STALE_BLOCK_INTERVAL_SEC: "0" } as NodeJS.ProcessEnv,
      now: () => NOW,
      ...overrides,
    };
  }

  function sweepWith(overrides: Partial<StaleBlockSweepDeps> = {}) {
    const injected = deps(overrides);
    return { injected, sweep: createStaleBlockSweep(injected) };
  }

  it("is off by default and the pass is skipped", async () => {
    const seeded = await seed({ blockerStatus: "done", withRelation: true });
    const injected = deps({ env: {} as NodeJS.ProcessEnv });
    const sweep = createStaleBlockSweep(injected);
    const result = await sweep.sweep();
    expect(result.skippedPass).toBe(true);
    expect(result.scanned).toBe(0);
    const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(issue!.status).toBe("blocked");
  });

  it("unblocks a task whose blocker is done: edge removed, in_progress, system comment", async () => {
    const seeded = await seed({ blockerStatus: "done", withRelation: true });
    const { sweep } = sweepWith();

    const result = await sweep.sweep();

    expect(result).toMatchObject({ scanned: 1, unblocked: 1, skippedLive: 0, failed: 0 });
    const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(issue!.status).toBe("in_progress");
    expect(issue!.unblockDescriptor).toBeNull();

    const relations = await db
      .select()
      .from(issueRelations)
      .where(and(eq(issueRelations.companyId, seeded.companyId), eq(issueRelations.relatedIssueId, seeded.issueId)));
    expect(relations).toHaveLength(0);

    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, seeded.issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]!.authorType).toBe("system");
    expect(comments[0]!.body).toContain("the blocking task is done");
    expect(comments[0]!.body).toContain("in_progress");
  });

  it("unblocks a task whose blocker is cancelled (the silent dead block)", async () => {
    const seeded = await seed({ blockerStatus: "cancelled", withRelation: true });
    const { sweep } = sweepWith();

    const result = await sweep.sweep();

    expect(result).toMatchObject({ scanned: 1, unblocked: 1, skippedLive: 0, failed: 0 });
    const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(issue!.status).toBe("in_progress");
    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, seeded.issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain("the blocking task is cancelled");
  });

  it("unblocks a task whose reasonRef due date passed", async () => {
    const seeded = await seed({
      blockerStatus: undefined,
      unblockDescriptor: {
        owner: "board",
        action: "wait until the freeze ends",
        reasonRef: { kind: "date", dueAt: "2026-10-01T00:00:00.000Z" },
      },
    });
    const { sweep } = sweepWith();

    const result = await sweep.sweep();

    expect(result).toMatchObject({ scanned: 1, unblocked: 1, skippedLive: 0, failed: 0 });
    const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(issue!.status).toBe("in_progress");
    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, seeded.issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain("the due date passed");
  });

  it("leaves a live blocker completely untouched", async () => {
    const seeded = await seed({ blockerStatus: "in_progress", withRelation: true });
    const { injected, sweep } = sweepWith();

    const result = await sweep.sweep();

    expect(result).toMatchObject({ scanned: 1, unblocked: 0, skippedLive: 1, failed: 0 });
    const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(issue!.status).toBe("blocked");
    const relations = await db
      .select()
      .from(issueRelations)
      .where(and(eq(issueRelations.companyId, seeded.companyId), eq(issueRelations.relatedIssueId, seeded.issueId)));
    expect(relations).toHaveLength(1);
    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, seeded.issueId));
    expect(comments).toHaveLength(0);
    expect(injected.logActivity).not.toHaveBeenCalled();
  });

  it("leaves a future due date and a still-set event alone", async () => {
    await seed({
      blockerStatus: undefined,
      unblockDescriptor: {
        owner: "board",
        action: "wait",
        reasonRef: { kind: "date", dueAt: "2026-10-05T00:00:00.000Z" },
      },
    });
    await seed({
      blockerStatus: undefined,
      unblockDescriptor: {
        owner: "board",
        action: "wait for the gate",
        reasonRef: { kind: "event", eventKey: "release-gate" },
      },
    });
    const { sweep } = sweepWith();
    const result = await sweep.sweep();
    expect(result).toMatchObject({ scanned: 2, unblocked: 0, skippedLive: 2, failed: 0 });
  });

  it("unblocks an event reason once the gate is cleared, through the injected seam", async () => {
    const seeded = await seed({
      blockerStatus: undefined,
      unblockDescriptor: {
        owner: "board",
        action: "wait for the gate",
        reasonRef: { kind: "event", eventKey: "release-gate" },
      },
    });
    const { sweep } = sweepWith({ isEventStillSet: vi.fn(async () => false) });
    const result = await sweep.sweep();
    expect(result).toMatchObject({ scanned: 1, unblocked: 1 });
    const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(issue!.status).toBe("in_progress");
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId));
    expect(comments[0]!.body).toContain("the gate or event no longer applies");
  });

  it("a task with one live and one dead reason stays blocked (only dead edges would go)", async () => {
    // reasonRef of kind date is live (future); the fallback edges are not read
    // when reasonRef exists, so the task keeps its live reason and stays.
    const seeded = await seed({
      blockerStatus: "in_progress",
      withRelation: true,
      unblockDescriptor: {
        owner: "board",
        action: "wait",
        reasonRef: { kind: "date", dueAt: "2026-10-05T00:00:00.000Z" },
      },
    });
    const { sweep } = sweepWith();
    const result = await sweep.sweep();
    expect(result).toMatchObject({ scanned: 1, unblocked: 0, skippedLive: 1 });
    const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(issue!.status).toBe("blocked");
  });

  it("skips a blocked task with no recognizable reason at all", async () => {
    const seeded = await seed({
      blockerStatus: undefined,
      unblockDescriptor: { owner: "board", action: "waiting" },
    });
    const { sweep } = sweepWith();
    const result = await sweep.sweep();
    expect(result).toMatchObject({ scanned: 1, unblocked: 0, skippedLive: 0, skippedUnknown: 1 });
    const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(issue!.status).toBe("blocked");
  });

  it("writes the activity log row for an unblock", async () => {
    const seeded = await seed({ blockerStatus: "done", withRelation: true });
    const { injected, sweep } = sweepWith();
    await sweep.sweep();
    expect(injected.logActivity).toHaveBeenCalledTimes(1);
    expect((injected.logActivity as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({
      companyId: seeded.companyId,
      actorType: "system",
      actorId: "stale_block_sweep",
      action: "myrmidon.stale_block.unblocked",
      entityType: "issue",
      entityId: seeded.issueId,
    });
  });

  it("records the operator signal for the attention feed after an unblock", async () => {
    const seeded = await seed({ blockerStatus: "done", withRelation: true });
    const { sweep } = sweepWith();
    await sweep.sweep();
    const signals = readStaleBlockSignals(seeded.companyId, NOW);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      issueId: seeded.issueId,
      identifier: expect.any(String),
      reasonTexts: ["the blocking task is done"],
      liftedAt: NOW.toISOString(),
    });
  });

  it("is idempotent: a second pass finds the task no longer blocked", async () => {
    const seeded = await seed({ blockerStatus: "done", withRelation: true });
    const { sweep } = sweepWith();
    await sweep.sweep();
    const commentsAfterFirst = await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId));
    const second = await sweep.sweep();
    expect(second).toMatchObject({ scanned: 0, unblocked: 0 });
    const commentsAfterSecond = await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId));
    expect(commentsAfterSecond).toHaveLength(commentsAfterFirst.length);
  });
});
