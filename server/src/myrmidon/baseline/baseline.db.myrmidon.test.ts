// myrmidon(1.6-BASELINE): the live-database half — the same numbers come out of
// the API and out of scripts/myrmidon/baseline-spot-check.sql on a real
// database (three seeded tasks, discrepancy 0), and the periodic job freezes
// one row into baseline_metric_snapshots.
//
// Neutral data only: agent-a/agent-b, project-a/example.test.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  baselineMetricSnapshots,
  companies,
  createDb,
  heartbeatRuns,
  issueRelations,
  issues,
  litellmCostEvents,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { computeBaselineMetrics } from "./service.js";
import { runBaselineSnapshot } from "./startup.js";
import type { BaselineWindow } from "./metrics.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

const WINDOW: BaselineWindow = {
  from: new Date("2026-09-01T00:00:00Z"),
  to: new Date("2026-09-30T00:00:00Z"),
};

/** The snapshot window the job freezes: the 14 days before `now`. */
const JOB_NOW = new Date("2026-09-12T00:00:00Z");

const SPOT_CHECK_SCRIPT = new URL(
  "../../../../scripts/myrmidon/baseline-spot-check.sql",
  import.meta.url,
);

function renderSpotCheck(companyId: string, fromIso: string, toIso: string, taskIds: string[]): string {
  return readFileSync(SPOT_CHECK_SCRIPT, "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("\\set"))
    .join("\n")
    .replaceAll(":'window_from'", `'${fromIso}'`)
    .replaceAll(":'window_to'", `'${toIso}'`)
    .replaceAll(":'company_id'", `'${companyId}'`)
    .replaceAll(":'task_1'", `'${taskIds[0]}'`)
    .replaceAll(":'task_2'", `'${taskIds[1]}'`)
    .replaceAll(":'task_3'", `'${taskIds[2]}'`);
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  const maybe = result as { rows?: Record<string, unknown>[] } | Record<string, unknown>[];
  if (Array.isArray(maybe)) return maybe as Record<string, unknown>[];
  return maybe.rows ?? [];
}

const num = (value: unknown): number => Number(value);
const close = (value: unknown): number => Number(Number(value).toFixed(2));

describeEmbeddedPostgres("myrmidon(1.6-BASELINE) live metrics and the snapshot job", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let projectA!: string;
  let blockerX!: string;
  let blockerY!: string;
  let blockerZ!: string;
  let taskIds!: string[];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-baseline-");
    db = createDb(tempDb.connectionString);

    const company = await db
      .insert(companies)
      .values({ name: `company-a ${randomUUID()}`, issuePrefix: `BL${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning()
      .then((rows) => rows[0]!);
    companyId = company.id;

    const engineer = await db
      .insert(agents)
      .values({
        companyId,
        name: "agent-a",
        role: "engineer",
        permissions: {},
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
      })
      .returning()
      .then((rows) => rows[0]!);
    const reviewer = await db
      .insert(agents)
      .values({
        companyId,
        name: "agent-b",
        role: "reviewer",
        permissions: {},
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
      })
      .returning()
      .then((rows) => rows[0]!);

    projectA = await db
      .insert(projects)
      .values({ companyId, name: "project-a" })
      .returning()
      .then((rows) => rows[0]!.id);

    const blockers = await db
      .insert(issues)
      .values(
        ["blocker-x", "blocker-y", "blocker-z"].map((title) => ({
          companyId,
          title,
          status: "in_progress",
        })),
      )
      .returning();
    [blockerX, blockerY, blockerZ] = blockers.map((row) => row.id);

    const t1 = await db
      .insert(issues)
      .values({
        companyId,
        title: "task-1",
        status: "done",
        projectId: projectA,
        assigneeAgentId: engineer.id,
        createdAt: new Date("2026-09-01T00:00:00Z"),
        completedAt: new Date("2026-09-02T00:00:00Z"),
      })
      .returning()
      .then((rows) => rows[0]!);
    const t2 = await db
      .insert(issues)
      .values({
        companyId,
        title: "task-2",
        status: "done",
        projectId: projectA,
        assigneeAgentId: reviewer.id,
        createdAt: new Date("2026-09-05T00:00:00Z"),
        completedAt: new Date("2026-09-05T12:00:00Z"),
      })
      .returning()
      .then((rows) => rows[0]!);
    const t3 = await db
      .insert(issues)
      .values({
        companyId,
        title: "task-3",
        status: "done",
        projectId: null,
        assigneeAgentId: engineer.id,
        createdAt: new Date("2026-09-10T00:00:00Z"),
        completedAt: new Date("2026-09-10T06:00:00Z"),
      })
      .returning()
      .then((rows) => rows[0]!);
    taskIds = [t1.id, t2.id, t3.id];

    // Status transitions, exactly the seeded story of the unit test:
    //  cycle 23h / review 9h / blocked 6h / one return  -> task-1
    //  cycle 10h / review 2h / no return                -> task-2
    //  cycle  5h / blocked 1h / never in review         -> task-3
    const transitions: Array<[string, string, string, string]> = [
      [t1.id, "2026-09-01T01:00:00Z", "backlog", "todo"],
      [t1.id, "2026-09-01T03:00:00Z", "todo", "in_progress"],
      [t1.id, "2026-09-01T05:00:00Z", "in_progress", "in_review"],
      [t1.id, "2026-09-01T09:00:00Z", "in_review", "in_progress"],
      [t1.id, "2026-09-01T11:00:00Z", "in_progress", "blocked"],
      [t1.id, "2026-09-01T13:00:00Z", "blocked", "in_progress"],
      [t1.id, "2026-09-01T14:00:00Z", "in_progress", "blocked"],
      [t1.id, "2026-09-01T18:00:00Z", "blocked", "in_progress"],
      [t1.id, "2026-09-01T19:00:00Z", "in_progress", "in_review"],
      [t1.id, "2026-09-02T00:00:00Z", "in_review", "done"],
      [t2.id, "2026-09-05T02:00:00Z", "backlog", "todo"],
      [t2.id, "2026-09-05T04:00:00Z", "todo", "in_progress"],
      [t2.id, "2026-09-05T10:00:00Z", "in_progress", "in_review"],
      [t2.id, "2026-09-05T12:00:00Z", "in_review", "done"],
      [t3.id, "2026-09-10T01:00:00Z", "backlog", "todo"],
      [t3.id, "2026-09-10T03:00:00Z", "todo", "in_progress"],
      [t3.id, "2026-09-10T04:00:00Z", "in_progress", "blocked"],
      [t3.id, "2026-09-10T05:00:00Z", "blocked", "in_progress"],
      [t3.id, "2026-09-10T06:00:00Z", "in_progress", "done"],
    ];
    await db.insert(activityLog).values(
      transitions.map(([issueId, at, from, to]) => ({
        companyId,
        actorType: "system",
        actorId: "system",
        action: "issue.updated",
        entityType: "issue",
        entityId: issueId,
        details: { status: to, _previous: { status: from } },
        createdAt: new Date(at),
      })),
    );

    // Three runs for task-1 inside the window, one outside it, one for task-2.
    const runValues: Array<{ issueId: string; at: string; agentId: string }> = [
      { issueId: t1.id, at: "2026-09-01T02:00:00Z", agentId: engineer.id },
      { issueId: t1.id, at: "2026-09-01T06:00:00Z", agentId: engineer.id },
      { issueId: t1.id, at: "2026-09-01T20:00:00Z", agentId: engineer.id },
      { issueId: t1.id, at: "2026-08-20T00:00:00Z", agentId: engineer.id },
      { issueId: t2.id, at: "2026-09-05T05:00:00Z", agentId: reviewer.id },
    ];
    await db.insert(heartbeatRuns).values(
      runValues.map((run) => ({
        companyId,
        agentId: run.agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "succeeded",
        startedAt: new Date(run.at),
        finishedAt: new Date(new Date(run.at).getTime() + 60_000),
        contextSnapshot: { issueId: run.issueId },
      })),
    );

    // Gateway-collected costs: 150 + 100 cents inside the window for task-1,
    // 999 outside it, 50 for task-2. litellm_cost_events wins as the source.
    await db.insert(litellmCostEvents).values(
      [
        { issueId: t1.id, cents: 150, at: "2026-09-01T06:00:00Z" },
        { issueId: t1.id, cents: 100, at: "2026-09-01T20:00:00Z" },
        { issueId: t1.id, cents: 999, at: "2026-08-20T00:00:00Z" },
        { issueId: t2.id, cents: 50, at: "2026-09-05T05:00:00Z" },
      ].map((cost) => ({
        id: `req-${randomUUID()}`,
        companyId,
        agentId: engineer.id,
        issueId: cost.issueId,
        provider: "openai",
        model: "example-model",
        inputTokens: 1,
        outputTokens: 1,
        costCents: cost.cents,
        occurredAt: new Date(cost.at),
      })),
    );

    await db.insert(issueRelations).values([
      { companyId, issueId: blockerX, relatedIssueId: t1.id, type: "blocks" },
      { companyId, issueId: blockerY, relatedIssueId: t1.id, type: "blocks" },
      { companyId, issueId: blockerZ, relatedIssueId: t3.id, type: "blocks" },
    ]);
  }, 90_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("reports the six metrics per project and per role", async () => {
    const metrics = await computeBaselineMetrics(db, companyId, WINDOW, new Date("2026-09-30T12:00:00Z"));

    expect(metrics.source).toEqual({ statusLog: "activity_log", costs: "litellm_cost_events" });
    expect(metrics.byProject.map((group) => group.key)).toEqual([null, projectA]);
    expect(metrics.byRole.map((group) => group.key)).toEqual(["engineer", "reviewer"]);

    const withProject = metrics.byProject.find((group) => group.key === projectA)!;
    expect(withProject.tasksCompleted).toBe(2);
    expect(withProject.cycleTimeHours).toEqual({ mean: 16.5, median: 16.5, p90: 21.7 });
    expect(withProject.timeInReviewHours).toEqual({ mean: 5.5, median: 5.5 });
    expect(withProject.returnRate).toEqual({ enteredReview: 2, returned: 1, rate: 0.5 });
    expect(withProject.blockedHours.total).toBe(6);
    expect(withProject.blockedHours.mean).toBe(3);
    const expectedCauses = [blockerX, blockerY]
      .slice()
      .sort((a, b) => a.localeCompare(b))
      .map((cause) => ({ cause, hours: 6 }));
    expect(withProject.blockedHours.topCauses).toEqual(expectedCauses);
    expect(withProject.runsPerTask).toEqual({ total: 4, mean: 2 });
    expect(withProject.costPerTask).toEqual({ totalCents: 300, meanCents: 150 });

    const withoutProject = metrics.byProject.find((group) => group.key === null)!;
    expect(withoutProject.tasksCompleted).toBe(1);
    expect(withoutProject.blockedHours.topCauses).toEqual([{ cause: blockerZ, hours: 1 }]);
    expect(withoutProject.costPerTask).toEqual({ totalCents: 0, meanCents: 0 });

    const engineer = metrics.byRole.find((group) => group.key === "engineer")!;
    expect(engineer.tasksCompleted).toBe(2);
    expect(engineer.cycleTimeHours.mean).toBe(14);
    expect(engineer.returnRate).toEqual({ enteredReview: 1, returned: 1, rate: 1 });
    expect(engineer.runsPerTask.total).toBe(3);
  }, 60_000);

  it("matches scripts/myrmidon/baseline-spot-check.sql field by field (three tasks, discrepancy 0)", async () => {
    const metrics = await computeBaselineMetrics(db, companyId, WINDOW, new Date("2026-09-30T12:00:00Z"));
    const rendered = renderSpotCheck(
      companyId,
      WINDOW.from.toISOString(),
      WINDOW.to.toISOString(),
      taskIds,
    );
    const [perTaskSql, byProjectSql] = rendered.split(/^-- SPOT-CHECK-SPLIT.*$/m);
    expect(perTaskSql).toBeTruthy();
    expect(byProjectSql).toBeTruthy();

    // Per task: the three tasks the spot check is run on.
    const perTask = rowsOf(await db.execute(sql.raw(perTaskSql!)));
    expect(perTask).toHaveLength(3);
    const expectedPerTask: Record<string, { cycle: number; review: number; blocked: number; runs: number; cost: number }> = {
      [taskIds[0]!]: { cycle: 23, review: 9, blocked: 6, runs: 3, cost: 250 },
      [taskIds[1]!]: { cycle: 10, review: 2, blocked: 0, runs: 1, cost: 50 },
      [taskIds[2]!]: { cycle: 5, review: 0, blocked: 1, runs: 0, cost: 0 },
    };
    for (const row of perTask) {
      const expected = expectedPerTask[String(row.issue_id)]!;
      expect(expected).toBeDefined();
      expect(close(row.cycle_hours)).toBe(expected.cycle);
      expect(close(row.review_hours)).toBe(expected.review);
      expect(close(row.blocked_hours)).toBe(expected.blocked);
      expect(num(row.runs)).toBe(expected.runs);
      expect(num(row.cost_cents)).toBe(expected.cost);
    }

    // By project: every field of the API answer, zero discrepancy.
    const byProject = rowsOf(await db.execute(sql.raw(byProjectSql!)));
    expect(byProject).toHaveLength(metrics.byProject.length);
    for (const row of byProject) {
      const key = row.key === "no-project" ? null : String(row.key);
      const api = metrics.byProject.find((group) => group.key === key);
      expect(api).toBeDefined();
      expect(api!.tasksCompleted).toBe(num(row.tasks_completed));
      expect(api!.cycleTimeHours.mean).toBe(close(row.cycle_mean));
      expect(api!.cycleTimeHours.median).toBe(close(row.cycle_median));
      expect(api!.cycleTimeHours.p90).toBe(close(row.cycle_p90));
      expect(api!.timeInReviewHours.mean).toBe(close(row.review_mean));
      expect(api!.timeInReviewHours.median).toBe(close(row.review_median));
      expect(api!.returnRate.enteredReview).toBe(num(row.entered_review));
      expect(api!.returnRate.returned).toBe(num(row.returned));
      expect(api!.blockedHours.total).toBe(close(row.blocked_total));
      expect(api!.blockedHours.mean).toBe(close(row.blocked_mean));
      expect(api!.runsPerTask.total).toBe(num(row.runs_total));
      expect(api!.runsPerTask.mean).toBe(close(row.runs_mean));
      expect(api!.costPerTask.totalCents).toBe(num(row.cost_total_cents));
      expect(api!.costPerTask.meanCents).toBe(close(row.cost_mean_cents));
    }
  }, 60_000);

  it("freezes one snapshot row per company through the periodic job", async () => {
    const result = await runBaselineSnapshot(db, {
      env: { MYRMIDON_BASELINE_INTERVAL_SEC: "3600" },
      ports: { now: () => JOB_NOW },
    });
    expect(result).toEqual({ companies: 1, written: 1 });

    const rows = await db.select().from(baselineMetricSnapshots);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.companyId).toBe(companyId);
    expect(row.windowFrom).toEqual(new Date(JOB_NOW.getTime() - 14 * 86_400_000));
    expect(row.windowTo).toEqual(JOB_NOW);
    expect(row.generatedAt).toEqual(JOB_NOW);

    const payload = row.payload as unknown as { byProject: Array<{ key: string | null; costPerTask: { totalCents: number } }> };
    expect(payload.byProject).toHaveLength(2);
    expect(payload.byProject.find((group) => group.key === projectA)!.costPerTask.totalCents).toBe(300);
  }, 60_000);
});