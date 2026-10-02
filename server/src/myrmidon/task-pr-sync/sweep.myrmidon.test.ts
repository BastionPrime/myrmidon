import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  issueComments,
  issueThreadInteractions,
  issueWorkProducts,
  issues,
} from "@paperclipai/db";
import type { PullRequestMergeDetailsResolver } from "../../services/github-pull-request-merge.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { TASK_PR_SYNC_SETTLED_ACTION, createTaskPrSyncSweep } from "./sweep.js";
import type { TaskPrSyncSettings } from "./settings.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const REPO = "company-a/example.com";

const SETTINGS: TaskPrSyncSettings = {
  enabled: true,
  settleDisabled: false,
  pollMs: 0,
  batchMax: 50,
};

/** A fake GitHub: returns the state recorded for each PR number, never the network. */
function fakeResolver(
  stateByNumber: Record<number, "open" | "draft" | "merged" | "closed" | "unknown">,
): PullRequestMergeDetailsResolver {
  return vi.fn<PullRequestMergeDetailsResolver>(async (_companyId, reference) => {
    const state = stateByNumber[reference.number] ?? "unknown";
    return {
      state: state === "merged" ? "merged" : state === "unknown" ? "unknown" : "open",
      headRef: null,
      headSha: state === "merged" ? `sha-${reference.number}` : null,
      workProductState: state === "unknown" ? undefined : state,
      draft: state === "draft",
    };
  });
}

describeEmbeddedPostgres("task PR sync sweep", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-task-pr-sync-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issueThreadInteractions);
    await db.delete(issueWorkProducts);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(input: {
    status?: string;
    products: Array<{ number: number; status?: string; updatedAt?: Date }>;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
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
      identifier: `SYNC-${issueId.slice(0, 4)}`,
      title: "Task a",
      status: input.status ?? "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    for (const product of input.products) {
      await db.insert(issueWorkProducts).values({
        companyId,
        issueId,
        type: "pull_request",
        provider: "github",
        title: `PR ${product.number}`,
        status: product.status ?? "ready_for_review",
        metadata: { repo: REPO, number: product.number, state: "open", draft: false },
        ...(product.updatedAt ? { updatedAt: product.updatedAt } : {}),
      });
    }
    return { companyId, agentId, issueId };
  }

  function sweepFor(resolver: PullRequestMergeDetailsResolver) {
    return createTaskPrSyncSweep({
      db,
      resolvePullRequestDetails: resolver,
      isUnderMaintenance: async () => false,
    });
  }

  it("settles a delivered task with exactly one comment and clears the workflow", async () => {
    const seeded = await seed({ products: [{ number: 11 }] });
    const sweep = sweepFor(fakeResolver({ 11: "merged" }));

    const result = await sweep.sweep({ settings: SETTINGS, force: true });

    expect(result).toMatchObject({ scanned: 1, settled: 1, returned: 0, failed: 0 });
    const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(issue).toMatchObject({ status: "done", executionState: null, executionPolicy: null });
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]!.authorType).toBe("system");
    expect(comments[0]!.body).toContain(`${REPO}#11`);
    expect(comments[0]!.body).toContain("sha-11");

    const logs = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, seeded.issueId), eq(activityLog.action, TASK_PR_SYNC_SETTLED_ACTION)));
    expect(logs).toHaveLength(1);

    const [product] = await db
      .select()
      .from(issueWorkProducts)
      .where(eq(issueWorkProducts.issueId, seeded.issueId));
    expect((product!.metadata as Record<string, unknown>).lastMergedSha).toBe("sha-11");
  });

  it("does not comment twice on a repeat pass", async () => {
    const seeded = await seed({ products: [{ number: 12 }] });
    const sweep = sweepFor(fakeResolver({ 12: "merged" }));

    await sweep.sweep({ settings: SETTINGS, force: true });
    const second = await sweep.sweep({ settings: SETTINGS, force: true });

    expect(second.scanned).toBe(0);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId));
    expect(comments).toHaveLength(1);
  });

  it("respects the batch cap", async () => {
    await seed({ products: [{ number: 21 }] });
    await seed({ products: [{ number: 22 }] });
    await seed({ products: [{ number: 23 }] });
    const sweep = sweepFor(fakeResolver({ 21: "merged", 22: "merged", 23: "merged" }));

    const result = await sweep.sweep({ settings: SETTINGS, force: true, batchMax: 2 });

    expect(result.scanned).toBe(2);
    expect(result.settled).toBe(2);
  });

  it("never touches a done or cancelled task", async () => {
    const done = await seed({ status: "done", products: [{ number: 31 }] });
    const cancelled = await seed({ status: "cancelled", products: [{ number: 32 }] });
    const sweep = sweepFor(fakeResolver({ 31: "merged", 32: "merged" }));

    const result = await sweep.sweep({ settings: SETTINGS, force: true });

    expect(result.scanned).toBe(0);
    const [doneIssue] = await db.select().from(issues).where(eq(issues.id, done.issueId));
    expect(doneIssue!.status).toBe("done");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, done.issueId))).toHaveLength(0);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, cancelled.issueId))).toHaveLength(0);
  });

  it("leaves the task alone while a PR is still open", async () => {
    const seeded = await seed({ products: [{ number: 41 }] });
    const sweep = sweepFor(fakeResolver({ 41: "open" }));

    const result = await sweep.sweep({ settings: SETTINGS, force: true });

    expect(result).toMatchObject({ scanned: 1, settled: 0, skipped: 1 });
    const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(issue!.status).toBe("in_progress");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId))).toHaveLength(0);
  });

  it("returns the task to the assignee when a PR closed without merging", async () => {
    const seeded = await seed({ status: "in_review", products: [{ number: 51 }] });
    const sweep = sweepFor(fakeResolver({ 51: "closed" }));

    const result = await sweep.sweep({ settings: SETTINGS, force: true });

    expect(result).toMatchObject({ scanned: 1, returned: 1, settled: 0 });
    const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(issue!.status).toBe("in_progress");
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain(`${REPO}#51`);
  });

  it("does not return the task again when a newer comment already answered the closure", async () => {
    const closedAt = new Date(Date.now() - 60_000);
    const seeded = await seed({ products: [{ number: 61, updatedAt: closedAt }] });
    await db.insert(issueComments).values({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      authorType: "system",
      body: "Someone already looked at the closed pull request.",
      createdAt: new Date(closedAt.getTime() + 30_000),
    });
    const sweep = sweepFor(fakeResolver({ 61: "closed" }));

    const result = await sweep.sweep({ settings: SETTINGS, force: true });

    expect(result).toMatchObject({ returned: 0, skipped: 1 });
    const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(issue!.status).toBe("in_progress");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId))).toHaveLength(1);
  });

  it("defers the settle while an explicit post-deploy gate is open", async () => {
    const seeded = await seed({ products: [{ number: 71 }] });
    await db.insert(issueThreadInteractions).values({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      kind: "request_confirmation",
      status: "pending",
      payload: {} as never,
    });
    const sweep = sweepFor(fakeResolver({ 71: "merged" }));

    const result = await sweep.sweep({ settings: SETTINGS, force: true });

    expect(result).toMatchObject({ settled: 0, skipped: 1 });
    const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(issue!.status).toBe("in_progress");
  });

  it("is disabled by MYRMIDON_TASK_PR_SYNC_ENABLED=0", async () => {
    const seeded = await seed({ products: [{ number: 81 }] });
    const sweep = sweepFor(fakeResolver({ 81: "merged" }));

    const result = await sweep.sweep({
      settings: { ...SETTINGS, enabled: false },
      force: true,
    });

    expect(result.skippedPass).toBe(true);
    const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(issue!.status).toBe("in_progress");
  });
});