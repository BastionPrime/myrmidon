// myrmidon(1.6-BASELINE): the server-side BASELINE metrics.
//
// Two halves:
//  - the pure math over seeded transitions — all six metrics, both breakdowns,
//    the window filter and the return rate;
//  - the periodic job, driven through its injected ports, proving it freezes the
//    14-day window into baseline_metric_snapshots;
//  - a route contract test (company access, required window, response shape).
//
// Neutral data only: agent-a/agent-b, example.test, 192.0.2.0/24.

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  clippedSegmentHours,
  computeBaselineMetrics,
  percentileCont,
  statusSegments,
  type BaselineMetricsInput,
  type BaselineTransitionRow,
  type BaselineWindow,
} from "./metrics.js";
import { baselineRoutes } from "./routes.js";
import {
  BASELINE_WINDOW_DAYS,
  readBaselineSettings,
  runBaselineSnapshot,
  snapshotWindow,
  type BaselineSnapshotRow,
} from "./startup.js";

const WINDOW: BaselineWindow = {
  from: new Date("2026-09-01T00:00:00Z"),
  to: new Date("2026-09-30T00:00:00Z"),
};

const COMPANY = "11111111-1111-4111-8111-111111111111";

const PROJECT_A = "22222222-2222-4222-8222-222222222222";

function transition(issueId: string, at: string, from: string, to: string): BaselineTransitionRow {
  return { issueId, at: new Date(at), from, to };
}

/**
 * T1 (project-a, engineer): todo -> in_progress -> in_review -> in_progress
 * (a return) -> blocked -> in_progress -> blocked -> in_review -> done.
 * 23h cycle, 9h in review, 6h blocked (two segments), one return.
 */
const T1_TRANSITIONS = [
  transition("t1", "2026-09-01T01:00:00Z", "backlog", "todo"),
  transition("t1", "2026-09-01T03:00:00Z", "todo", "in_progress"),
  transition("t1", "2026-09-01T05:00:00Z", "in_progress", "in_review"),
  transition("t1", "2026-09-01T09:00:00Z", "in_review", "in_progress"),
  transition("t1", "2026-09-01T11:00:00Z", "in_progress", "blocked"),
  transition("t1", "2026-09-01T13:00:00Z", "blocked", "in_progress"),
  transition("t1", "2026-09-01T14:00:00Z", "in_progress", "blocked"),
  transition("t1", "2026-09-01T18:00:00Z", "blocked", "in_progress"),
  transition("t1", "2026-09-01T19:00:00Z", "in_progress", "in_review"),
  transition("t1", "2026-09-02T00:00:00Z", "in_review", "done"),
];

/** T2 (project-a, reviewer): 10h cycle, 2h in review, no return, no block. */
const T2_TRANSITIONS = [
  transition("t2", "2026-09-05T02:00:00Z", "backlog", "todo"),
  transition("t2", "2026-09-05T04:00:00Z", "todo", "in_progress"),
  transition("t2", "2026-09-05T10:00:00Z", "in_progress", "in_review"),
  transition("t2", "2026-09-05T12:00:00Z", "in_review", "done"),
];

/** T3 (no project, engineer): 5h cycle, 1h blocked, never entered review. */
const T3_TRANSITIONS = [
  transition("t3", "2026-09-10T01:00:00Z", "backlog", "todo"),
  transition("t3", "2026-09-10T03:00:00Z", "todo", "in_progress"),
  transition("t3", "2026-09-10T04:00:00Z", "in_progress", "blocked"),
  transition("t3", "2026-09-10T05:00:00Z", "blocked", "in_progress"),
  transition("t3", "2026-09-10T06:00:00Z", "in_progress", "done"),
];

/** A task completed outside the window; it must not contribute at all. */
const T4_TRANSITIONS = [
  transition("t4", "2026-08-01T01:00:00Z", "backlog", "todo"),
  transition("t4", "2026-08-01T02:00:00Z", "todo", "done"),
];

function seededInput(): BaselineMetricsInput {
  return {
    tasks: [
      {
        id: "t1",
        projectId: PROJECT_A,
        assigneeAgentId: "agent-a",
        createdAt: new Date("2026-09-01T00:00:00Z"),
        completedAt: new Date("2026-09-02T00:00:00Z"),
      },
      {
        id: "t2",
        projectId: PROJECT_A,
        assigneeAgentId: "agent-b",
        createdAt: new Date("2026-09-05T00:00:00Z"),
        completedAt: new Date("2026-09-05T12:00:00Z"),
      },
      {
        id: "t3",
        projectId: null,
        assigneeAgentId: "agent-a",
        createdAt: new Date("2026-09-10T00:00:00Z"),
        completedAt: new Date("2026-09-10T06:00:00Z"),
      },
      {
        id: "t4",
        projectId: PROJECT_A,
        assigneeAgentId: "agent-a",
        createdAt: new Date("2026-08-01T00:00:00Z"),
        completedAt: new Date("2026-08-01T02:00:00Z"),
      },
    ],
    transitions: [...T1_TRANSITIONS, ...T2_TRANSITIONS, ...T3_TRANSITIONS, ...T4_TRANSITIONS],
    runs: [
      { issueId: "t1", at: new Date("2026-09-01T02:00:00Z") },
      { issueId: "t1", at: new Date("2026-09-01T06:00:00Z") },
      { issueId: "t1", at: new Date("2026-09-01T20:00:00Z") },
      { issueId: "t1", at: new Date("2026-08-20T00:00:00Z") }, // outside the window
      { issueId: "t2", at: new Date("2026-09-05T05:00:00Z") },
    ],
    costs: [
      { issueId: "t1", cents: 150, at: new Date("2026-09-01T06:00:00Z") },
      { issueId: "t1", cents: 100, at: new Date("2026-09-01T20:00:00Z") },
      { issueId: "t1", cents: 999, at: new Date("2026-08-20T00:00:00Z") }, // outside the window
      { issueId: "t2", cents: 50, at: new Date("2026-09-05T05:00:00Z") },
    ],
    blockers: [
      { issueId: "t1", blockerIssueId: "blocker-x" },
      { issueId: "t1", blockerIssueId: "blocker-y" },
      { issueId: "t3", blockerIssueId: "blocker-z" },
    ],
    roles: [
      { agentId: "agent-a", role: "engineer" },
      { agentId: "agent-b", role: "reviewer" },
    ],
  };
}

describe("myrmidon(1.6-BASELINE) percentile helper", () => {
  it("matches percentile_cont linear interpolation", () => {
    expect(percentileCont([], 0.5)).toBe(0);
    expect(percentileCont([7], 0.9)).toBe(7);
    expect(percentileCont([10, 23], 0.5)).toBe(16.5);
    expect(percentileCont([10, 23], 0.9)).toBeCloseTo(21.7, 6);
    expect(percentileCont([1, 2, 3, 4], 0.5)).toBe(2.5);
  });
});

describe("myrmidon(1.6-BASELINE) status segments", () => {
  it("reconstructs segments and clips them to the window", () => {
    const segments = statusSegments(T1_TRANSITIONS);
    expect(segments[0]).toMatchObject({ status: "todo", start: new Date("2026-09-01T01:00:00Z") });
    expect(segments.at(-1)).toMatchObject({ status: "done", end: null });
    const closed = { status: "in_review", start: new Date("2026-09-01T05:00:00Z"), end: new Date("2026-09-01T09:00:00Z") };
    expect(clippedSegmentHours(closed, WINDOW)).toBe(4);
    const openBeforeWindow = { status: "blocked", start: new Date("2026-08-31T00:00:00Z"), end: null };
    // Clipped to the window: from 2026-09-01T00:00Z to the window end (29 days).
    expect(clippedSegmentHours(openBeforeWindow, WINDOW)).toBe(696);
    // A segment entirely before the window contributes nothing.
    const fullyBefore = { status: "blocked", start: new Date("2026-08-01T00:00:00Z"), end: new Date("2026-08-02T00:00:00Z") };
    expect(clippedSegmentHours(fullyBefore, WINDOW)).toBe(0);
  });
});

describe("myrmidon(1.6-BASELINE) metrics", () => {
  const metrics = computeBaselineMetrics(seededInput(), WINDOW);

  it("group by project, keeping the no-project bucket", () => {
    expect(metrics.byProject.map((group) => group.key)).toEqual([null, PROJECT_A]);
    const withProject = metrics.byProject.find((group) => group.key === PROJECT_A)!;
    expect(withProject.tasksCompleted).toBe(2);
    const withoutProject = metrics.byProject.find((group) => group.key === null)!;
    expect(withoutProject.tasksCompleted).toBe(1);
  });

  it("computes cycle time (parsed from todo), median and p90", () => {
    const group = metrics.byProject.find((g) => g.key === PROJECT_A)!;
    expect(group.cycleTimeHours.mean).toBe(16.5);
    expect(group.cycleTimeHours.median).toBe(16.5);
    expect(group.cycleTimeHours.p90).toBeCloseTo(21.7, 6);
    expect(metrics.byRole.find((g) => g.key === "engineer")!.cycleTimeHours.mean).toBe(14);
  });

  it("sums the review segments and counts the return", () => {
    const group = metrics.byProject.find((g) => g.key === PROJECT_A)!;
    expect(group.timeInReviewHours.mean).toBe(5.5);
    expect(group.timeInReviewHours.median).toBe(5.5);
    expect(group.returnRate).toEqual({ enteredReview: 2, returned: 1, rate: 0.5 });
    expect(metrics.byRole.find((g) => g.key === "engineer")!.returnRate).toEqual({
      enteredReview: 1,
      returned: 1,
      rate: 1,
    });
    expect(metrics.byRole.find((g) => g.key === "reviewer")!.returnRate).toEqual({
      enteredReview: 1,
      returned: 0,
      rate: 0,
    });
  });

  it("sums blocked time and attributes it to the current blockers", () => {
    const group = metrics.byProject.find((g) => g.key === PROJECT_A)!;
    expect(group.blockedHours.total).toBe(6);
    expect(group.blockedHours.mean).toBe(3);
    expect(group.blockedHours.topCauses).toEqual([
      { cause: "blocker-x", hours: 6 },
      { cause: "blocker-y", hours: 6 },
    ]);
    const withoutProject = metrics.byProject.find((g) => g.key === null)!;
    expect(withoutProject.blockedHours.topCauses).toEqual([{ cause: "blocker-z", hours: 1 }]);
  });

  it("counts runs per task inside the window", () => {
    const group = metrics.byProject.find((g) => g.key === PROJECT_A)!;
    expect(group.runsPerTask).toEqual({ total: 4, mean: 2 });
    expect(metrics.byRole.find((g) => g.key === "engineer")!.runsPerTask.total).toBe(3);
  });

  it("joins cost rows by issue inside the window", () => {
    const group = metrics.byProject.find((g) => g.key === PROJECT_A)!;
    expect(group.costPerTask).toEqual({ totalCents: 300, meanCents: 150 });
    expect(metrics.byRole.find((g) => g.key === "reviewer")!.costPerTask).toEqual({
      totalCents: 50,
      meanCents: 50,
    });
    const withoutProject = metrics.byProject.find((g) => g.key === null)!;
    expect(withoutProject.costPerTask).toEqual({ totalCents: 0, meanCents: 0 });
  });

  it("counts only the tasks whose completedAt falls inside the window", () => {
    const input = seededInput();
    const inside = computeBaselineMetrics(input, WINDOW);
    expect(inside.byProject.reduce((sum, group) => sum + group.tasksCompleted, 0)).toBe(3); // t4 dropped

    const boundary = computeBaselineMetrics(
      {
        ...seededInput(),
        tasks: [
          { id: "t5", projectId: null, assigneeAgentId: null, createdAt: WINDOW.from, completedAt: WINDOW.from },
          { id: "t6", projectId: null, assigneeAgentId: null, createdAt: WINDOW.from, completedAt: WINDOW.to },
          {
            id: "t7",
            projectId: null,
            assigneeAgentId: null,
            createdAt: WINDOW.from,
            completedAt: new Date(WINDOW.to.getTime() + 1),
          },
        ],
      },
      WINDOW,
    );
    // Both bounds are inclusive; one millisecond past `to` is out.
    expect(boundary.byProject.find((g) => g.key === null)!.tasksCompleted).toBe(2);
  });
});

describe("myrmidon(1.6-BASELINE) snapshot settings and job", () => {
  it("is off when the interval setting is unset", () => {
    expect(readBaselineSettings({})).toMatchObject({ enabled: false, intervalSec: 86_400 });
    expect(readBaselineSettings({ MYRMIDON_BASELINE_INTERVAL_SEC: "" })).toMatchObject({ enabled: false });
  });

  it("turns on for a valid interval and clamps an unreadable one to the default", () => {
    expect(readBaselineSettings({ MYRMIDON_BASELINE_INTERVAL_SEC: "3600" })).toMatchObject({
      enabled: true,
      intervalSec: 3600,
      intervalMs: 3_600_000,
    });
    expect(readBaselineSettings({ MYRMIDON_BASELINE_INTERVAL_SEC: "nope" })).toMatchObject({
      enabled: true,
      intervalSec: 86_400,
    });
    expect(readBaselineSettings({ MYRMIDON_BASELINE_INTERVAL_SEC: "5" })).toMatchObject({
      enabled: true,
      intervalSec: 86_400,
    });
  });

  it("freezes the last 14 days", () => {
    const now = new Date("2026-09-30T12:00:00Z");
    const window = snapshotWindow(now);
    expect(window.to).toEqual(now);
    expect(window.from).toEqual(new Date(now.getTime() - BASELINE_WINDOW_DAYS * 86_400_000));
  });

  it("writes one snapshot per company with the computed payload", async () => {
    const written: BaselineSnapshotRow[] = [];
    const now = new Date("2026-09-30T12:00:00Z");
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await runBaselineSnapshot({} as Db, {
      env: { MYRMIDON_BASELINE_INTERVAL_SEC: "3600" },
      ports: {
        listCompanyIds: async () => ["company-a", "company-b"],
        compute: async (_db, companyId, window) => ({
          window: { from: window.from.toISOString(), to: window.to.toISOString() },
          generatedAt: now.toISOString(),
          source: { statusLog: "activity_log", costs: "none" },
          byProject: [],
          byRole: [
            {
              key: companyId,
              tasksCompleted: 1,
              cycleTimeHours: { mean: 1, median: 1, p90: 1 },
              timeInReviewHours: { mean: 0, median: 0 },
              returnRate: { enteredReview: 0, returned: 0, rate: 0 },
              blockedHours: { total: 0, mean: 0, topCauses: [] },
              runsPerTask: { total: 0, mean: 0 },
              costPerTask: { totalCents: 0, meanCents: 0 },
            },
          ],
        }),
        writeSnapshot: async (_db, row) => {
          written.push(row);
        },
        now: () => now,
        log,
      },
    });

    expect(result).toEqual({ companies: 2, written: 2 });
    expect(written.map((row) => row.companyId)).toEqual(["company-a", "company-b"]);
    expect(written[0]!.windowFrom).toEqual(new Date(now.getTime() - BASELINE_WINDOW_DAYS * 86_400_000));
    expect(written[0]!.windowTo).toEqual(now);
    expect(written[0]!.generatedAt).toEqual(now);
    expect((written[0]!.payload as { byRole: Array<{ key: string }> }).byRole[0]!.key).toBe("company-a");
  });

  it("does nothing while the job is off", async () => {
    const writeSnapshot = vi.fn();
    const result = await runBaselineSnapshot({} as Db, {
      env: {},
      ports: { writeSnapshot, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
    });
    expect(result).toEqual({ companies: 0, written: 0 });
    expect(writeSnapshot).not.toHaveBeenCalled();
  });

  it("keeps going when one company fails", async () => {
    const written: string[] = [];
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await runBaselineSnapshot({} as Db, {
      env: { MYRMIDON_BASELINE_INTERVAL_SEC: "3600" },
      ports: {
        listCompanyIds: async () => ["company-a", "company-b"],
        compute: async (_db, companyId, window) => {
          if (companyId === "company-a") throw new Error("boom");
          return {
            window: { from: window.from.toISOString(), to: window.to.toISOString() },
            generatedAt: window.to.toISOString(),
            source: { statusLog: "activity_log", costs: "none" },
            byProject: [],
            byRole: [],
          };
        },
        writeSnapshot: async (_db, row) => {
          written.push(row.companyId);
        },
        now: () => new Date("2026-09-30T12:00:00Z"),
        log,
      },
    });
    expect(written).toEqual(["company-b"]);
    expect(result.written).toBe(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});

describe("myrmidon(1.6-BASELINE) metrics route", () => {
  const board = { type: "board", source: "session", userId: "user-a", isInstanceAdmin: true, companyIds: [COMPANY] };
  const otherBoard = { ...board, companyIds: ["99999999-9999-4999-8999-999999999999"] };
  const anonymous = { type: "none" };

  function app(actor: unknown, compute = vi.fn()) {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = actor;
      next();
    });
    server.use("/api", baselineRoutes({} as Db, { now: () => new Date("2026-09-30T12:00:00Z"), compute }));
    return { server, compute };
  }

  it("answers the six metrics for a board actor and passes the window through", async () => {
    const compute = vi.fn(async (_db: Db, _companyId: string, window: BaselineWindow) => ({
      window: { from: window.from.toISOString(), to: window.to.toISOString() },
      generatedAt: "2026-09-30T12:00:00.000Z",
      source: { statusLog: "activity_log", costs: "litellm_cost_events" as const },
      byProject: [],
      byRole: [],
    }));
    const response = await request(app(board, compute).server)
      .get(`/api/myrmidon/companies/${COMPANY}/baseline/metrics`)
      .query({ from: "2026-09-01T00:00:00Z", to: "2026-09-30T00:00:00Z" });
    expect(response.status).toBe(200);
    expect(response.body.source).toEqual({ statusLog: "activity_log", costs: "litellm_cost_events" });
    expect(compute).toHaveBeenCalledTimes(1);
    expect((compute.mock.calls[0]![2] as BaselineWindow).from).toEqual(new Date("2026-09-01T00:00:00Z"));
  });

  it("requires both window bounds", async () => {
    const { server, compute } = app(board);
    const missing = await request(server).get(`/api/myrmidon/companies/${COMPANY}/baseline/metrics`);
    expect(missing.status).toBe(400);
    const bad = await request(server)
      .get(`/api/myrmidon/companies/${COMPANY}/baseline/metrics`)
      .query({ from: "nope", to: "2026-09-30T00:00:00Z" });
    expect(bad.status).toBe(400);
    const inverted = await request(server)
      .get(`/api/myrmidon/companies/${COMPANY}/baseline/metrics`)
      .query({ from: "2026-09-30T00:00:00Z", to: "2026-09-01T00:00:00Z" });
    expect(inverted.status).toBe(400);
    expect(compute).not.toHaveBeenCalled();
  });

  it("refuses another company and an anonymous caller", async () => {
    const other = await request(app(otherBoard).server)
      .get(`/api/myrmidon/companies/${COMPANY}/baseline/metrics`)
      .query({ from: "2026-09-01T00:00:00Z", to: "2026-09-30T00:00:00Z" });
    expect(other.status).toBe(403);
    const anon = await request(app(anonymous).server)
      .get(`/api/myrmidon/companies/${COMPANY}/baseline/metrics`)
      .query({ from: "2026-09-01T00:00:00Z", to: "2026-09-30T00:00:00Z" });
    expect(anon.status).toBe(401);
  });
});