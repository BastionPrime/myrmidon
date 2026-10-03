import request from "supertest";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { activityLog, issues } from "@paperclipai/db";
import {
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";
import { issueRoutes } from "../routes/issues.js";
import {
  isStaleBlockGuardedTransition,
  STALE_BLOCK_ROLLOUT_AT,
} from "../services/routable-blocked.js";

// myrmidon(STALE-BLOCK): blocked transitions must carry a reason reference —
// a non-empty blockedByIssueIds list or an unblockDescriptor.reasonRef —
// once the rollout moment has passed.

const ctx = useEmbeddedPostgres("myrmidon-stale-block-guard-", {
  resetEach: async (db) => {
    await db.delete(activityLog);
    await resetCompanyIssueFixtures(db);
  },
});

describe("stale-block reason reference guard (route level)", () => {
  async function seedTodoIssue(companyId: string, title: string) {
    const issueId = crypto.randomUUID();
    await ctx.db.insert(issues).values({
      id: issueId,
      companyId,
      title,
      status: "todo",
      priority: "medium",
    });
    return issueId;
  }

  async function seedBlockerIssue(companyId: string, title: string) {
    const blockerId = crypto.randomUUID();
    await ctx.db.insert(issues).values({
      id: blockerId,
      companyId,
      title,
      status: "todo",
      priority: "medium",
    });
    return blockerId;
  }

  it("rejects a blocked transition without a reason reference with 400 (validation error)", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Stale block guard");
    const issueId = await seedTodoIssue(companyId, "Guarded issue");

    const res = await request(routeApp(ctx.db, actor, issueRoutes))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "blocked" });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(JSON.stringify(res.body)).toContain("reason reference");
    const after = await ctx.db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(after.status).toBe("todo");
  });

  it("accepts a blocked transition with a non-empty blockedByIssueIds list", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Stale block guard");
    const issueId = await seedTodoIssue(companyId, "Guarded issue with blockers");
    const blockerId = await seedBlockerIssue(companyId, "Blocking issue");

    const res = await request(routeApp(ctx.db, actor, issueRoutes))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "blocked", blockedByIssueIds: [blockerId] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const after = await ctx.db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(after.status).toBe("blocked");
  });

  it("accepts a blocked transition with reasonRef kind=date and stores it", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Stale block guard");
    const issueId = await seedTodoIssue(companyId, "Guarded issue with date reason");

    const res = await request(routeApp(ctx.db, actor, issueRoutes))
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "blocked",
        unblockDescriptor: {
          owner: "board",
          action: "Wait for the scheduled maintenance window",
          reasonRef: { kind: "date", dueAt: "2026-10-10T00:00:00.000Z" },
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const after = await ctx.db
      .select({ status: issues.status, unblockDescriptor: issues.unblockDescriptor })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(after.status).toBe("blocked");
    expect((after.unblockDescriptor as { reasonRef?: unknown } | null)?.reasonRef).toEqual({
      kind: "date",
      dueAt: "2026-10-10T00:00:00.000Z",
    });
  });

  it("guards only transitions after the rollout moment (unit check)", () => {
    expect(
      isStaleBlockGuardedTransition({
        status: "blocked",
        blockedTransitionAt: new Date(STALE_BLOCK_ROLLOUT_AT.getTime() - 1),
      }),
    ).toBe(false);
    expect(
      isStaleBlockGuardedTransition({
        status: "blocked",
        blockedTransitionAt: new Date(STALE_BLOCK_ROLLOUT_AT.getTime() + 1),
      }),
    ).toBe(true);
    expect(
      isStaleBlockGuardedTransition({
        status: "blocked",
        blockedTransitionAt: STALE_BLOCK_ROLLOUT_AT.toISOString(),
      }),
    ).toBe(true);
    expect(
      isStaleBlockGuardedTransition({
        status: "todo",
        blockedTransitionAt: new Date(),
      }),
    ).toBe(false);
    expect(
      isStaleBlockGuardedTransition({ status: "blocked", blockedTransitionAt: null }),
    ).toBe(false);
  });
});
