// server/src/myrmidon/swarm-claim/idle-wake.myrmidon.test.ts
//
// myrmidon(1.6.1 SWARM-IDLE-WAKE): the acceptance tests of the idle pass.
//
// The ticket's criterion, pinned at the seams where it is enforced:
//
//   1. the verdict matrix — free agents (no live claim, under the ceiling,
//      not paused, no live run) of a role with a non-empty ready queue are
//      the wake targets, and nothing else is;
//   2. the wake binds to the top of the queue in claim order (a critical
//      task is the top — P0 first), and one agent per queue task;
//   3. the batch cap (≤5 by default, clamped);
//   4. the acceptance window: the pass runs on the same scheduler tick as
//      the expired-lease sweep, whose interval is far below the lease TTL —
//      "an idle engineer and an unclaimed task of his role" is served within
//      one TTL plus one sweep interval, without manual action.
//
// Pure verdicts live in idle-wake.ts (no database); the pass runner is
// tested through module-seam fakes the same way caste-gate.myrmidon.test.ts
// drives the claim service.

import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SWARM_LEASE_TTL_SEC,
  DEFAULT_SWARM_MAX_ACTIVE_TASKS,
  DEFAULT_SWARM_CLAIM_SWEEP_INTERVAL_SEC,
  type SwarmClaimLease,
  type SwarmQueueCandidate,
} from "@paperclipai/shared";
import {
  idleWakeTargetsForRole,
  idleWakeIdempotencyKey,
  type SwarmRoleIdleInput,
} from "./idle-wake.js";
import {
  DEFAULT_SWARM_IDLE_WAKE_BATCH,
  readSwarmIdleWakeBatch,
  SWARM_IDLE_WAKE_BATCH_ENV,
  createSwarmClaimSweeper,
  type SwarmClaimSweeperDeps,
} from "./sweep.js";

const NOW = new Date("2026-10-03T12:00:00Z");

function candidate(overrides: Partial<SwarmQueueCandidate> = {}): SwarmQueueCandidate {
  return {
    issueId: "11111111-1111-4111-8111-111111111111",
    identifier: "ISSUE-1",
    priority: "medium",
    queuedAt: new Date("2026-10-03T10:00:00Z"),
    ...overrides,
  };
}

function lease(overrides: Partial<SwarmClaimLease> = {}): SwarmClaimLease {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    issueId: "11111111-1111-4111-8111-111111111111",
    agentId: "33333333-3333-4333-8333-333333333333",
    heartbeatAt: NOW,
    expiresAt: new Date(NOW.getTime() + 60_000),
    releasedAt: null,
    ...overrides,
  };
}

function roleInput(overrides: Partial<SwarmRoleIdleInput> = {}): SwarmRoleIdleInput {
  return {
    role: "engineer",
    queue: [candidate()],
    liveClaims: [],
    agents: [
      { id: "agent-a", activeClaims: 0, maxActiveTasks: 3, status: "idle", hasLiveRun: false },
    ],
    ...overrides,
  };
}

describe("myrmidon(1.6.1 SWARM-IDLE-WAKE) idle verdict matrix", () => {
  it("a free agent at a non-empty queue is the wake target, bound to the top task", () => {
    const targets = idleWakeTargetsForRole(roleInput(), { batchLimit: 5, now: NOW, p0Preemption: true });
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      agentId: "agent-a",
      issueId: "11111111-1111-4111-8111-111111111111",
      role: "engineer",
    });
  });

  it("an agent with a live run, at the ceiling, paused or errored is not woken", () => {
    const input = roleInput({
      agents: [
        { id: "agent-live-run", activeClaims: 0, maxActiveTasks: 3, status: "idle", hasLiveRun: true },
        { id: "agent-capped", activeClaims: 3, maxActiveTasks: 3, status: "idle", hasLiveRun: false },
        { id: "agent-paused", activeClaims: 0, maxActiveTasks: 3, status: "paused", hasLiveRun: false },
        { id: "agent-error", activeClaims: 0, maxActiveTasks: 3, status: "error", hasLiveRun: false },
        { id: "agent-free", activeClaims: 2, maxActiveTasks: 3, status: "idle", hasLiveRun: false },
      ],
    });
    const targets = idleWakeTargetsForRole(input, { batchLimit: 5, now: NOW, p0Preemption: true });
    expect(targets.map((target) => target.agentId)).toEqual(["agent-free"]);
  });

  it("a null ceiling means no cap from the ceiling rule", () => {
    const input = roleInput({
      agents: [
        { id: "agent-many", activeClaims: 9, maxActiveTasks: null, status: "idle", hasLiveRun: false },
      ],
    });
    const targets = idleWakeTargetsForRole(input, { batchLimit: 5, now: NOW, p0Preemption: true });
    expect(targets).toHaveLength(1);
  });

  it("a covered task (a live claim) leaves nothing to hand out", () => {
    const input = roleInput({
      queue: [candidate({ issueId: "claimed-issue" }), candidate({ issueId: "other-issue", identifier: "ISSUE-2" })],
      liveClaims: [lease({ issueId: "claimed-issue" })],
    });
    const targets = idleWakeTargetsForRole(input, { batchLimit: 5, now: NOW, p0Preemption: true });
    // The first task is covered, so the free agent binds to the next one.
    expect(targets).toHaveLength(1);
    expect(targets[0]!.issueId).toBe("other-issue");
  });

  it("an empty queue wakes nobody even with free agents", () => {
    const targets = idleWakeTargetsForRole(roleInput({ queue: [] }), { batchLimit: 5, now: NOW, p0Preemption: true });
    expect(targets).toEqual([]);
  });
});

describe("myrmidon(1.6.1 SWARM-IDLE-WAKE) P0 first and one agent per task", () => {
  it("a critical task is the top: the first free agent binds to it", () => {
    const input = roleInput({
      queue: [
        candidate({ issueId: "old-medium", identifier: "OLD", queuedAt: new Date("2026-10-01T10:00:00Z") }),
        candidate({ issueId: "new-critical", identifier: "P0", priority: "critical", queuedAt: new Date("2026-10-03T11:00:00Z") }),
      ],
      agents: [
        { id: "agent-a", activeClaims: 0, maxActiveTasks: 3, status: "idle", hasLiveRun: false },
        { id: "agent-b", activeClaims: 0, maxActiveTasks: 3, status: "idle", hasLiveRun: false },
      ],
    });
    const targets = idleWakeTargetsForRole(input, { batchLimit: 5, now: NOW, p0Preemption: true });
    expect(targets[0]).toMatchObject({ agentId: "agent-a", issueId: "new-critical" });
    expect(targets[1]).toMatchObject({ agentId: "agent-b", issueId: "old-medium" });
  });
});

describe("myrmidon(1.6.1 SWARM-IDLE-WAKE) batch cap", () => {
  it("default 5, clamped 1..25, anything else falls back", () => {
    expect(DEFAULT_SWARM_IDLE_WAKE_BATCH).toBe(5);
    expect(readSwarmIdleWakeBatch({})).toBe(5);
    expect(readSwarmIdleWakeBatch({ [SWARM_IDLE_WAKE_BATCH_ENV]: "3" })).toBe(3);
    expect(readSwarmIdleWakeBatch({ [SWARM_IDLE_WAKE_BATCH_ENV]: "100" })).toBe(25);
    expect(readSwarmIdleWakeBatch({ [SWARM_IDLE_WAKE_BATCH_ENV]: "0" })).toBe(1);
    expect(readSwarmIdleWakeBatch({ [SWARM_IDLE_WAKE_BATCH_ENV]: "abc" })).toBe(5);
  });

  it("the cap truncates the wake targets of one role", () => {
    const input = roleInput({
      queue: [1, 2, 3, 4, 5, 6, 7].map((n) => candidate({ issueId: `issue-${n}`, identifier: `I-${n}` })),
      agents: [1, 2, 3, 4, 5, 6, 7].map((n) => ({
        id: `agent-${n}`,
        activeClaims: 0,
        maxActiveTasks: 3,
        status: "idle",
        hasLiveRun: false,
      })),
    });
    const targets = idleWakeTargetsForRole(input, { batchLimit: 5, now: NOW, p0Preemption: true });
    expect(targets).toHaveLength(5);
  });
});

describe("myrmidon(1.6.1 SWARM-IDLE-WAKE) idempotency key", () => {
  it("the key is per issue, tracing-stable", () => {
    expect(idleWakeIdempotencyKey({ issueId: "issue-1" })).toBe("swarm_idle_wake:issue-1");
  });
});

// --- the pass through module-seam fakes ------------------------------------

const mockListIdleRolePairs = vi.hoisted(() => vi.fn());
const mockLiveClaimCountsByAgent = vi.hoisted(() => vi.fn());

vi.mock("./idle-queue.js", () => ({
  listIdleRolePairs: mockListIdleRolePairs,
  liveClaimCountsByAgent: mockLiveClaimCountsByAgent,
  rolesOfQueueRow: vi.fn(),
}));

/**
 * The fake db: `listActiveCompanies` reads companies through the select
 * chain, so the chain resolves one active company. The expired/closed claim
 * reads and the coverage check chain through orderBy/limit — for the wake
 * test the chain answers empty (nothing covers the task), which is exactly
 * the pass's "nothing claimed, nothing queued" state.
 */
function fakeDb(companies: string[] = ["company-a"]) {
  const companyRows = companies.map((id) => ({ id }));
  const emptyChain = {
    where: () => emptyChain,
    orderBy: () => emptyChain,
    innerJoin: () => emptyChain,
    leftJoin: () => emptyChain,
    then: (resolve: (rows: unknown[]) => Promise<unknown>) => resolve([]),
    limit: async () => [] as unknown[],
  };
  // listActiveCompanies selects { id } FROM companies — the only companies
  // read in the pass. Discriminate on a companies-only column (issuePrefix)
  // the from() chain names; everything else (claims, wakes, statuses)
  // answers empty: nothing covers the task — exactly the pass's "nothing
  // claimed, nothing queued" state.
  const companyChain = {
    where: () => ({ limit: async () => companyRows }),
  };
  return {
    select: (_shape: unknown) => ({
      from: (table: unknown) => {
        const isCompanies = Boolean(
          table && typeof table === "object" && "issuePrefix" in (table as Record<string, unknown>),
        );
        return isCompanies ? companyChain : emptyChain;
      },
    }),
  } as never;
}

function fakeSweepPorts(input: {
  enabled?: boolean;
  companies?: string[];
  pilotRoles?: string[];
  castes?: (companyId: string) => Promise<readonly {
    key: string;
    label: string;
    swarmEligible: boolean;
    maxActiveTasks: number | null;
  }[]>;
  enqueueWakeup?: (agentId: string, opts: Record<string, unknown>) => Promise<unknown>;
}): Omit<SwarmClaimSweeperDeps, "intervalMs"> {
  return {
    db: fakeDb(input.companies),
    settings: {
      getGeneral: async () =>
        ({
          swarmClaim: {
            enabled: input.enabled ?? true,
            enabledRoles: input.pilotRoles ?? [],
            leaseTtlSec: DEFAULT_SWARM_LEASE_TTL_SEC,
            maxActiveTasks: DEFAULT_SWARM_MAX_ACTIVE_TASKS,
            sweepIntervalSec: DEFAULT_SWARM_CLAIM_SWEEP_INTERVAL_SEC,
          },
        }) as never,
    },
    castes: input.castes,
    enqueueWakeup: (input.enqueueWakeup ??
      (async () => ({ id: "wake-1" }))) as SwarmClaimSweeperDeps["enqueueWakeup"],
    env: {} as Record<string, string | undefined>,
  };
}

describe("myrmidon(1.6.1 SWARM-IDLE-WAKE) sweep pass", () => {
  it("a free agent and an unclaimed task of its role: one wake within one pass", async () => {
    const wakes: Array<{ agentId: string; opts: Record<string, unknown> }> = [];
    mockListIdleRolePairs.mockResolvedValue([
      {
        role: "engineer",
        companyId: "company-a",
        queue: [candidate()],
        agents: [{ id: "agent-a", status: "idle", activeClaims: 0, hasLiveRun: false }],
      },
    ]);
    mockLiveClaimCountsByAgent.mockResolvedValue(new Map());

    const sweeper = createSwarmClaimSweeper({
      ...fakeSweepPorts({
        enqueueWakeup: async (agentId: string, opts: Record<string, unknown>) => {
          wakes.push({ agentId, opts });
          return { id: `wake-${wakes.length}` };
        },
      }),
      intervalMs: 0,
    });
    sweeper.resetForTest();
    const result = await sweeper.sweep(NOW);
    expect(result.idleWoken).toBe(1);
    expect(result.idleRoles).toBe(1);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.agentId).toBe("agent-a");
    // The wake binds to the top queue task — the run checkout claims it.
    expect(wakes[0]!.opts).toMatchObject({
      reason: "swarm_claim_queue",
      requestedByActorId: "swarm_idle_wake",
    });
    const snapshot = wakes[0]!.opts.contextSnapshot as Record<string, unknown>;
    expect(snapshot.issueId).toBe("11111111-1111-4111-8111-111111111111");
    expect(snapshot.taskKey).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("with the pilot flag off the idle pass is a no-op", async () => {
    const wakes: unknown[] = [];
    mockListIdleRolePairs.mockClear();
    const sweeper = createSwarmClaimSweeper({
      ...fakeSweepPorts({
        enabled: false,
        enqueueWakeup: async () => {
          wakes.push(1);
          return null;
        },
      }),
      intervalMs: 0,
    });
    sweeper.resetForTest();
    const result = await sweeper.sweep(NOW);
    expect(result.idleWoken).toBe(0);
    expect(wakes).toHaveLength(0);
    expect(mockListIdleRolePairs).not.toHaveBeenCalled();
  });

  it("myrmidon(1.6.1 SWARM-IDLE-WAKE): a role outside the pilot set never gets a wake", async () => {
    // Blocker 1 of the review: an unassigned task fans out to every role with
    // agents, but the pilot gate must keep the wake away from non-pilot roles
    // (a reviewer would claim `disabled`, end with nothing, and the next tick
    // would wake it again — the endless loop the ticket forbids).
    const wakes: Array<{ agentId: string; opts: Record<string, unknown> }> = [];
    mockListIdleRolePairs.mockResolvedValue([
      {
        role: "reviewer",
        companyId: "company-a",
        queue: [candidate()],
        agents: [{ id: "agent-reviewer", status: "idle", activeClaims: 0, hasLiveRun: false }],
      },
      {
        role: "engineer",
        companyId: "company-a",
        queue: [candidate()],
        agents: [{ id: "agent-eng", status: "idle", activeClaims: 0, hasLiveRun: false }],
      },
    ]);
    mockLiveClaimCountsByAgent.mockResolvedValue(new Map());

    const sweeper = createSwarmClaimSweeper({
      ...fakeSweepPorts({
        pilotRoles: ["engineer"],
        enqueueWakeup: async (agentId: string, opts: Record<string, unknown>) => {
          wakes.push({ agentId, opts });
          return { id: `wake-${wakes.length}` };
        },
      }),
      intervalMs: 0,
    });
    sweeper.resetForTest();
    const result = await sweeper.sweep(NOW);
    // The engineer is woken, the reviewer is not.
    expect(result.idleWoken).toBe(1);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.agentId).toBe("agent-eng");
  });

  it("myrmidon(1.6.1 CUSTOM-CASTES B): a caste-excluded role is never woken, a caste ceiling applies", async () => {
    const wakes: Array<{ agentId: string }> = [];
    mockListIdleRolePairs.mockResolvedValue([
      {
        role: "engineer",
        companyId: "company-a",
        queue: [candidate()],
        agents: [
          // 2 live claims, global ceiling 3 — free under the global ceiling,
          // but the caste ceiling of 2 caps this agent out.
          { id: "agent-caste-capped", status: "idle", activeClaims: 0, hasLiveRun: false },
        ],
      },
      {
        role: "lead",
        companyId: "company-a",
        queue: [candidate()],
        agents: [{ id: "agent-lead", status: "idle", activeClaims: 0, hasLiveRun: false }],
      },
    ]);
    mockLiveClaimCountsByAgent.mockResolvedValue(new Map([["agent-caste-capped", 2]]));

    const sweeper = createSwarmClaimSweeper({
      ...fakeSweepPorts({
        castes: async () => [
          { key: "engineer", label: "engineer", swarmEligible: true, maxActiveTasks: 2 },
          { key: "lead", label: "lead", swarmEligible: false, maxActiveTasks: null },
        ],
        enqueueWakeup: async (agentId: string) => {
          wakes.push({ agentId });
          return { id: `wake-${wakes.length}` };
        },
      }),
      intervalMs: 0,
    });
    sweeper.resetForTest();
    const result = await sweeper.sweep(NOW);
    // The lead caste is swarmEligible=false — no wake. The engineer is
    // capped out by the caste ceiling (2 live claims, ceiling 2) — no wake.
    expect(result.idleWoken).toBe(0);
    expect(wakes).toHaveLength(0);
  });

  it("the acceptance window: the sweep interval defaults far below the lease TTL", () => {
    // One TTL plus one sweep interval is the contract's worst case; the
    // interval must stay a small fraction of the TTL.
    expect(DEFAULT_SWARM_CLAIM_SWEEP_INTERVAL_SEC).toBeLessThanOrEqual(
      DEFAULT_SWARM_LEASE_TTL_SEC / 3,
    );
  });
});
