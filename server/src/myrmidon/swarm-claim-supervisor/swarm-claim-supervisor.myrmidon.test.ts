// myrmidon(1.6-SWARM-CLAIM-B): unit tests of the supervisor surface.
//
// Part A's claim table may not be merged yet, so these tests run the real
// view/rebalance/pilot logic over an in-memory fake of the read port — no
// database, no part A import. Neutral ids only.

import { describe, expect, it, vi } from "vitest";
import {
  orderQueueCandidates,
  swarmSupervisorView,
  type SwarmSupervisorReadPort,
} from "./view.js";
import {
  ClaimNotLiveError,
  ClaimNotFoundError,
  releaseLeaseForRebalance,
  type SwarmRebalanceDeps,
} from "./rebalance.js";
import {
  compareMetric,
  defaultPilotWindow,
  parsePilotWindow,
  parseSnapshot,
  swarmPilotReport,
  SwarmPilotNotEnabledError,
  SwarmPilotWindowError,
  type BaselineMetricsReportJson,
  type SwarmPilotDeps,
} from "./pilot-report.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

/** The read port plus the release write, faked in memory. */
interface FakePort extends SwarmSupervisorReadPort {
  releaseClaim: (
    companyId: string,
    claimId: string,
    reason: string,
    now: Date,
  ) => Promise<boolean>;
  released: { claimId: string; reason: string }[];
}

interface FakeClaim {
  claim_id: string;
  issue_id: string;
  agent_id: string;
  claimed_at: string;
  expires_at: string;
  heartbeat_at: string | null;
  released_at: string | null;
}

interface FakeIssue {
  issue_id: string;
  identifier: string | null;
  title: string;
  priority: string;
  project_id: string | null;
  created_at: string;
  blocked_transition_at: string | null;
}

/** Queued rows carry the assignee so the role queue can be attributed. */
interface FakeQueueRow extends FakeIssue {
  assignee_agent_id?: string | null;
}

interface FakeAgent {
  agent_id: string;
  agent_name: string;
  role: string;
  status: string;
}

const NOW = new Date("2026-10-02T15:30:00.000Z");

function fakePort(input: {
  enabled?: boolean;
  ttl?: number | null;
  maxActive?: number | null;
  claims?: FakeClaim[];
  issues?: FakeQueueRow[];
  agents?: FakeAgent[];
  liveRunAgents?: string[];
  releaseResult?: boolean;
}): FakePort {
  const released: { claimId: string; reason: string }[] = [];
  const port: FakePort = {
    async claimEnabled() {
      return input.enabled ?? true;
    },
    async leaseTtlSec() {
      return input.ttl ?? null;
    },
    async maxActiveTasksPerAgent() {
      return input.maxActive ?? null;
    },
    // myrmidon(1.6.1 SWARM-SETTINGS-UI): the fake answers the source map the
    // real DB port reads from the instance settings row.
    async settingSources() {
      return (input as { sources?: Record<string, string> }).sources ?? {};
    },
    // myrmidon(1.6.1 SWARM-IDLE-WAKE): the fake answers the resolved pilot
    // role set; empty means "every role".
    async pilotRoles() {
      return (input as { pilotRoles?: string[] }).pilotRoles ?? [];
    },
    async listClaimRows() {
      return (input.claims ?? []) as unknown as FakeClaim[];
    },
    async listQueueRows() {
      return (input.issues ?? []) as unknown as FakeQueueRow[];
    },
    async listAgents() {
      return (input.agents ?? []) as unknown as FakeAgent[];
    },
    async liveRunAgentIds() {
      return new Set(input.liveRunAgents ?? []);
    },
    async releaseClaim(_companyId, claimId, reason) {
      released.push({ claimId, reason });
      return input.releaseResult ?? true;
    },
    released,
  };
  return port;
}

function issue(overrides: Partial<FakeQueueRow> = {}): FakeQueueRow {
  return {
    issue_id: "11111111-1111-4111-8111-111111111111",
    identifier: "TST-1",
    title: "First queued task",
    priority: "medium",
    project_id: null,
    created_at: "2026-10-01T10:00:00.000Z",
    blocked_transition_at: null,
    assignee_agent_id: null,
    ...overrides,
  };
}

function claim(overrides: Partial<FakeClaim> = {}): FakeClaim {
  return {
    claim_id: "33333333-3333-4333-8333-333333333333",
    issue_id: "11111111-1111-4111-8111-111111111111",
    agent_id: "44444444-4444-4444-8444-444444444444",
    claimed_at: "2026-10-02T15:00:00.000Z",
    expires_at: "2026-10-02T16:00:00.000Z",
    heartbeat_at: "2026-10-02T15:20:00.000Z",
    released_at: null,
    ...overrides,
  };
}

function agent(overrides: Partial<FakeAgent> = {}): FakeAgent {
  return {
    agent_id: "44444444-4444-4444-8444-444444444444",
    agent_name: "agent-a",
    role: "engineer",
    status: "idle",
    ...overrides,
  };
}

describe("orderQueueCandidates", () => {
  it("ranks critical above medium and older blocked first", () => {
    const rows = [
      { issueId: "i-1", identifier: null, title: "a", priority: "medium", projectId: null, createdAt: "2026-10-01T10:00:00.000Z", blockedTransitionAt: null },
      { issueId: "i-2", identifier: null, title: "b", priority: "critical", projectId: null, createdAt: "2026-10-01T12:00:00.000Z", blockedTransitionAt: null },
      { issueId: "i-3", identifier: null, title: "c", priority: "critical", projectId: null, createdAt: "2026-10-01T11:00:00.000Z", blockedTransitionAt: null },
    ];
    const ordered = orderQueueCandidates(rows).map((row) => row.issueId);
    expect(ordered).toEqual(["i-3", "i-2", "i-1"]);
  });
});

describe("swarmSupervisorView.overview", () => {
  it("answers enabled:false with empty totals when the claim machinery is off", async () => {
    const view = swarmSupervisorView(fakePort({ enabled: false }), {}, () => NOW);
    const overview = await view.overview(COMPANY_ID);
    expect(overview.enabled).toBe(false);
    expect(overview.roles).toEqual([]);
    expect(overview.totals.queued).toBe(0);
  });

  it("reports the role queue, live lease, expired lease and idle agents", async () => {
    const port = fakePort({
      ttl: 3600,
      maxActive: 2,
      claims: [
        claim(),
        claim({
          claim_id: "33333333-3333-4333-8333-333333333334",
          issue_id: "11111111-1111-4111-8111-111111111112",
          agent_id: "44444444-4444-4444-8444-444444444445",
          expires_at: "2026-10-02T15:10:00.000Z",
        }),
        claim({
          claim_id: "33333333-3333-4333-8333-333333333335",
          issue_id: "11111111-1111-4111-8111-111111111113",
          agent_id: "44444444-4444-4444-8444-444444444444",
          released_at: "2026-10-02T15:25:00.000Z",
        }),
      ],
      issues: [
        issue(),
        issue({
          issue_id: "11111111-1111-4111-8111-111111111112",
          identifier: "TST-2",
          title: "Claimed task",
        }),
        issue({
          issue_id: "11111111-1111-4111-8111-111111111114",
          identifier: "TST-3",
          title: "Unclaimed queued task",
          priority: "critical",
          assignee_agent_id: "44444444-4444-4444-8444-444444444444",
        }),
      ],
      agents: [
        agent(),
        agent({
          agent_id: "44444444-4444-4444-8444-444444444445",
          agent_name: "agent-b",
        }),
        agent({
          agent_id: "44444444-4444-4444-8444-444444444446",
          agent_name: "agent-c",
        }),
      ],
      liveRunAgents: ["44444444-4444-4444-8444-444444444446"],
    });
    const view = swarmSupervisorView(port, {}, () => NOW);
    const overview = await view.overview(COMPANY_ID);

    expect(overview.enabled).toBe(true);
    expect(overview.leaseTtlSec).toBe(3600);
    expect(overview.maxActiveTasksPerAgent).toBe(2);
    // The released history row is not a live lease.
    expect(overview.totals.activeClaims).toBe(2);
    expect(overview.totals.expiredClaims).toBe(1);
    expect(overview.totals.agentsWithClaims).toBe(2);
    // Only the unclaimed critical task is queued; the two leased tasks are not.
    expect(overview.totals.queued).toBe(1);
    // agent-a and agent-b are idle with a non-empty role queue; agent-c has a
    // live run and is not idle.
    expect(overview.totals.idleAgentsWithQueue).toBe(2);

    const engineer = overview.roles.find((role) => role.role === "engineer");
    expect(engineer).toBeDefined();
    expect(engineer?.queue.map((row) => row.identifier)).toEqual(["TST-3"]);
    expect(engineer?.claims).toHaveLength(2);
    const expired = engineer?.claims.find((row) => row.claimId === "33333333-3333-4333-8333-333333333334");
    expect(expired?.expired).toBe(true);
    expect(expired?.agentName).toBe("agent-b");
    const live = engineer?.claims.find((row) => row.claimId === "33333333-3333-4333-8333-333333333333");
    expect(live?.expired).toBe(false);
    expect(live?.secondsToExpiry).toBe(1800);
    expect(engineer?.idleAgents.map((row) => row.name)).toEqual(["agent-a", "agent-b"]);
    expect(overview.topQueue[0]?.priority).toBe("critical");
  });
});

describe("releaseLeaseForRebalance", () => {
  function deps(port: ReturnType<typeof fakePort>, opts: { wakeError?: boolean } = {}): SwarmRebalanceDeps {
    return {
      port,
      enqueueWakeup: vi.fn(async () => {
        if (opts.wakeError) throw new Error("wake refused");
        return { queued: true };
      }),
      now: () => NOW,
    };
  }

  it("releases a live lease, wakes the next idle agent of the role and audits", async () => {
    const port = fakePort({
      claims: [claim()],
      issues: [issue()],
      agents: [
        agent(),
        agent({
          agent_id: "44444444-4444-4444-8444-444444444445",
          agent_name: "agent-b",
        }),
      ],
      liveRunAgents: ["44444444-4444-4444-8444-444444444444"],
    });
    const logActivity = vi.fn<(input: { action: string }) => Promise<void>>(async () => {});
    const result = await releaseLeaseForRebalance(
      { ...deps(port), logActivity },
      COMPANY_ID,
      "33333333-3333-4333-8333-333333333333",
    );
    expect(result.released).toBe(true);
    expect(result.wokenAgentId).toBe("44444444-4444-4444-8444-444444444445");
    expect(port.released).toEqual([
      { claimId: "33333333-3333-4333-8333-333333333333", reason: "supervisor_rebalance" },
    ]);
    const logged = logActivity.mock.calls[0]?.[0];
    expect(logged?.action).toBe("issue.swarm_claim_supervisor_release");
  });

  it("404s on an unknown claim and 409s on a released or expired claim", async () => {
    const port = fakePort({
      claims: [
        claim({
          claim_id: "33333333-3333-4333-8333-333333333334",
          released_at: "2026-10-02T15:00:00.000Z",
        }),
        claim({
          claim_id: "33333333-3333-4333-8333-333333333335",
          expires_at: "2026-10-02T15:00:00.000Z",
        }),
      ],
    });
    await expect(
      releaseLeaseForRebalance(deps(port), COMPANY_ID, "00000000-0000-4000-8000-000000000000"),
    ).rejects.toBeInstanceOf(ClaimNotFoundError);
    await expect(
      releaseLeaseForRebalance(deps(port), COMPANY_ID, "33333333-3333-4333-8333-333333333334"),
    ).rejects.toBeInstanceOf(ClaimNotLiveError);
    await expect(
      releaseLeaseForRebalance(deps(port), COMPANY_ID, "33333333-3333-4333-8333-333333333335"),
    ).rejects.toBeInstanceOf(ClaimNotLiveError);
  });

  it("survives a refused wake: released stays true, wokenAgentId null", async () => {
    const port = fakePort({ claims: [claim()], issues: [issue()], agents: [agent()] });
    const result = await releaseLeaseForRebalance(
      deps(port, { wakeError: true }),
      COMPANY_ID,
      "33333333-3333-4333-8333-333333333333",
    );
    expect(result.released).toBe(true);
    expect(result.wokenAgentId).toBeNull();
  });

  it("reports released:false when the release path declines", async () => {
    const port = fakePort({ claims: [claim()], releaseResult: false });
    const result = await releaseLeaseForRebalance(
      deps(port),
      COMPANY_ID,
      "33333333-3333-4333-8333-333333333333",
    );
    expect(result.released).toBe(false);
  });
});

function metricsReport(meanCycle: number): BaselineMetricsReportJson {
  return {
    window: { from: "2026-09-18T00:00:00.000Z", to: "2026-10-02T00:00:00.000Z" },
    generatedAt: "2026-10-02T12:00:00.000Z",
    source: { statusLog: "activity_log", costs: "none" },
    byProject: [
      {
        key: null,
        tasksCompleted: 10,
        cycleTimeHours: { mean: meanCycle, median: meanCycle, p90: meanCycle },
        timeInReviewHours: { mean: 2, median: 2 },
        returnRate: { enteredReview: 10, returned: 3, rate: 0.3 },
        blockedHours: { total: 5, mean: 0.5, topCauses: [] },
        runsPerTask: { total: 20, mean: 2 },
        costPerTask: { totalCents: 1000, meanCents: 100 },
      },
    ],
    byRole: [],
  };
}

function pilotDeps(input: {
  enabled?: boolean;
  pilot?: BaselineMetricsReportJson | null;
  snapshotBody?: string | null;
}): SwarmPilotDeps {
  return {
    async fetchBaselineMetrics() {
      if (input.pilot === null) throw new Error("metrics unavailable");
      return input.pilot ?? metricsReport(20);
    },
    async readBaselineSnapshot() {
      return input.snapshotBody === null || input.snapshotBody === undefined
        ? null
        : { body: input.snapshotBody };
    },
    async pilotEnabled() {
      return input.enabled ?? true;
    },
    now: () => NOW,
  };
}

describe("swarmPilotReport", () => {
  it("503s through SwarmPilotNotEnabledError when the pilot flag is off", async () => {
    await expect(
      swarmPilotReport(pilotDeps({ enabled: false }), COMPANY_ID),
    ).rejects.toBeInstanceOf(SwarmPilotNotEnabledError);
  });

  it("answers baseline:null with a note until the snapshot exists", async () => {
    const report = await swarmPilotReport(pilotDeps({ snapshotBody: null }), COMPANY_ID);
    expect(report.enabled).toBe(true);
    expect(report.baseline).toBeNull();
    expect(report.pilot).not.toBeNull();
    expect(report.notes.some((note) => note.includes("baseline-snapshot-14d"))).toBe(true);
    expect(report.comparison.cycleTimeHoursMean.baseline).toBeNull();
    expect(report.comparison.cycleTimeHoursMean.pilot).toBe(20);
  });

  it("computes the signed delta against the frozen snapshot", async () => {
    const snapshot = JSON.stringify(metricsReport(40));
    const report = await swarmPilotReport(
      pilotDeps({ snapshotBody: `# snapshot\n\n\`\`\`json\n${snapshot}\n\`\`\`\n` }),
      COMPANY_ID,
    );
    expect(report.baseline).not.toBeNull();
    expect(report.comparison.cycleTimeHoursMean).toEqual({
      pilot: 20,
      baseline: 40,
      deltaPercent: -50,
    });
  });

  it("rejects an invalid window with SwarmPilotWindowError", async () => {
    await expect(
      swarmPilotReport(pilotDeps({}), COMPANY_ID, "not-a-date", "2026-10-02T00:00:00.000Z"),
    ).rejects.toBeInstanceOf(SwarmPilotWindowError);
    await expect(
      swarmPilotReport(pilotDeps({}), COMPANY_ID, "2026-10-02T15:00:00.000Z", "2026-10-02T14:00:00.000Z"),
    ).rejects.toBeInstanceOf(SwarmPilotWindowError);
  });
});

describe("pilot report helpers", () => {
  it("defaultPilotWindow spans the last 14 days floored to the minute", () => {
    const window = defaultPilotWindow(() => new Date("2026-10-02T15:30:45.200Z"));
    expect(window.to).toBe("2026-10-02T15:30:00.000Z");
    expect(Date.parse(window.to) - Date.parse(window.from)).toBe(14 * 24 * 3600 * 1000);
  });

  it("parsePilotWindow accepts a valid explicit window", () => {
    const parsed = parsePilotWindow("2026-09-25T00:00:00.000Z", "2026-10-02T00:00:00.000Z", () => NOW);
    expect(parsed.from.toISOString()).toBe("2026-09-25T00:00:00.000Z");
  });

  it("parseSnapshot extracts the JSON from a fenced markdown body", () => {
    const body = `# frozen snapshot\n\nSome prose.\n\n\`\`\`json\n${JSON.stringify(metricsReport(42))}\n\`\`\`\n`;
    const parsed = parseSnapshot(body);
    expect(parsed?.byProject[0]?.cycleTimeHours.mean).toBe(42);
    expect(parseSnapshot("no json here")).toBeNull();
  });

  it("compareMetric returns null deltas without a baseline or with zero baseline", () => {
    expect(compareMetric(10, null).deltaPercent).toBeNull();
    expect(compareMetric(10, 0).deltaPercent).toBeNull();
    expect(compareMetric(15, 10)).toEqual({ pilot: 15, baseline: 10, deltaPercent: 50 });
  });
});
