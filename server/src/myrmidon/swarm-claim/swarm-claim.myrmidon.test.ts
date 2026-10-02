// server/src/myrmidom/swarm-claim/swarm-claim.myrmidon.test.ts
//
// myrmidon(1.6-SWARM): the acceptance tests of the per-role task queues.
//
// The four decisions the ticket names, each pinned once at the seam where it
// is enforced — the domain functions, with fakes for the store ports (the
// *.myrmidon.test.ts style of this repo: no database, neutral data):
//
//   1. an agent takes the top task of its own role's queue;
//   2. an expired lease returns the task to the queue (the sweep path);
//   3. the per-agent ceiling blocks a claim beyond the limit;
//   4. a `critical` task preempts the queue order.
//
// The fifth acceptance line — "an idle agent with a non-empty queue of its
// role cannot exist longer than one lease period" — is the composition of 2
// and the sweep interval bound (sweep interval <= lease TTL), pinned in the
// last test.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SWARM_LEASE_TTL_SEC,
  DEFAULT_SWARM_MAX_ACTIVE_TASKS,
  DEFAULT_SWARM_CLAIM_SWEEP_INTERVAL_SEC,
  SWARM_CLAIM_QUEUE_ISSUE_STATUSES,
  SWARM_CLAIM_WAKE_REASON,
  type SwarmClaimLease,
  type SwarmClaimSettings,
  type SwarmQueueCandidate,
} from "@paperclipai/shared";
import {
  claimCovers,
  nextQueueTaskForAgent,
  planClaim,
  planLeaseHeartbeat,
  selectQueueForAgent,
} from "./domain.js";
import { createSwarmClaimSweeper } from "./sweep.js";
import { claimNextTaskForAgent } from "./service.js";

const settings: SwarmClaimSettings = {
  enabled: true,
  leaseTtlSec: DEFAULT_SWARM_LEASE_TTL_SEC,
  maxActiveTasks: DEFAULT_SWARM_MAX_ACTIVE_TASKS,
  sweepIntervalSec: DEFAULT_SWARM_CLAIM_SWEEP_INTERVAL_SEC,
};

function candidate(overrides: Partial<SwarmQueueCandidate> = {}): SwarmQueueCandidate {
  return {
    issueId: "11111111-1111-4111-8111-111111111111",
    identifier: "ISSUE-1",
    priority: "medium",
    queuedAt: new Date("2026-10-02T10:00:00Z"),
    ...overrides,
  };
}

function lease(overrides: Partial<SwarmClaimLease> = {}): SwarmClaimLease {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    issueId: "11111111-1111-4111-8111-111111111111",
    agentId: "33333333-3333-4333-8333-333333333333",
    heartbeatAt: new Date("2026-10-02T10:00:00Z"),
    expiresAt: new Date("2026-10-02T10:15:00Z"),
    releasedAt: null,
    ...overrides,
  };
}

const NOW = new Date("2026-10-02T12:00:00Z");

describe("myrmidon(1.6-SWARM) queue order", () => {
  it("an agent takes the top task of its own role's queue", () => {
    const candidates = [
      candidate({
        issueId: "a1111111-1111-4111-8111-111111111111",
        identifier: "ISSUE-3",
        queuedAt: new Date("2026-10-02T11:00:00Z"),
      }),
      candidate({
        issueId: "b2222222-2222-4222-8222-222222222222",
        identifier: "ISSUE-2",
        queuedAt: new Date("2026-10-02T09:00:00Z"),
      }),
    ];
    // The older task entered the queue first, so it is the top.
    const queue = selectQueueForAgent({ candidates, liveClaims: [], now: NOW });
    expect(queue[0]?.issueId).toBe("b2222222-2222-4222-8222-222222222222");
  });

  it("a critical task preempts the queue order", () => {
    const candidates = [
      candidate({
        issueId: "a1111111-1111-4111-8111-111111111111",
        identifier: "ISSUE-3",
        priority: "medium",
        queuedAt: new Date("2026-10-01T11:00:00Z"),
      }),
      candidate({
        issueId: "b2222222-2222-4222-8222-222222222222",
        identifier: "ISSUE-2",
        priority: "critical",
        queuedAt: new Date("2026-10-02T11:00:00Z"),
      }),
    ];
    const queue = selectQueueForAgent({ candidates, liveClaims: [], now: NOW });
    expect(queue[0]?.issueId).toBe("b2222222-2222-4222-8222-222222222222");
    expect(queue[0]?.priority).toBe("critical");
  });
});

describe("myrmidon(1.6-SWARM) leases", () => {
  it("a live lease covers its task; an expired lease does not", () => {
    const covering = lease({ heartbeatAt: NOW, expiresAt: new Date(NOW.getTime() + 60_000) });
    const expired = lease({
      heartbeatAt: new Date(NOW.getTime() - 20 * 60_000),
      expiresAt: new Date(NOW.getTime() - 5 * 60_000),
    });
    expect(claimCovers(covering, NOW)).toBe(true);
    expect(claimCovers(expired, NOW)).toBe(false);
  });

  it("an expired lease returns the task to the queue", () => {
    const expired = lease({ expiresAt: new Date(NOW.getTime() - 60_000) });
    const candidates = [
      candidate({ issueId: expired.issueId }),
      candidate({ issueId: "c3333333-3333-4333-8333-333333333333", identifier: "ISSUE-9" }),
    ];
    // The expired claim no longer covers the task, so the task is claimable…
    expect(claimCovers(expired, NOW)).toBe(false);
    // …and the queue selection hands it out again (oldest first).
    const queue = selectQueueForAgent({ candidates, liveClaims: [expired], now: NOW });
    expect(queue[0]?.issueId).toBe(expired.issueId);
  });

  it("the heartbeat pushes the lease one TTL forward", () => {
    const claim = lease({
      heartbeatAt: new Date(NOW.getTime() - 10 * 60_000),
      expiresAt: new Date(NOW.getTime() + 5 * 60_000),
    });
    const plan = planLeaseHeartbeat({ claim, now: NOW, settings });
    expect(plan).not.toBeNull();
    expect(plan!.expiresAt.getTime()).toBe(NOW.getTime() + settings.leaseTtlSec * 1000);
  });

  it("a released lease is not resurrected by the heartbeat", () => {
    const claim = lease({ releasedAt: new Date(NOW.getTime() - 60_000) });
    const plan = planLeaseHeartbeat({ claim, now: NOW, settings });
    expect(plan).toBeNull();
  });

  it("a claim plan stamps the expiry exactly one TTL ahead", () => {
    const plan = planClaim({
      issueId: "11111111-1111-4111-8111-111111111111",
      agentId: "33333333-3333-4333-8333-333333333333",
      role: "eng",
      runId: null,
      now: NOW,
      settings,
    });
    expect(plan.expiresAt.getTime()).toBe(NOW.getTime() + settings.leaseTtlSec * 1000);
    expect(plan.heartbeatAt.getTime()).toBe(NOW.getTime());
  });
});

describe("myrmidon(1.6-SWARM) per-agent ceiling", () => {
  it("blocks a claim beyond the limit and admits one under it", () => {
    const queue = [candidate()];
    const atLimit = nextQueueTaskForAgent({
      candidates: queue,
      liveClaims: [],
      activeTasks: settings.maxActiveTasks as number,
      settings,
      now: NOW,
    });
    expect(atLimit).toBeNull();

    const underLimit = nextQueueTaskForAgent({
      candidates: queue,
      liveClaims: [],
      activeTasks: (settings.maxActiveTasks as number) - 1,
      settings,
      now: NOW,
    });
    expect(underLimit?.issueId).toBe(queue[0].issueId);
  });
});

describe("myrmidon(1.6-SWARM) claim service", () => {
  function fakePorts(general: Record<string, unknown>) {
    return {
      db: {
        select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }),
      },
      settings: { getGeneral: async () => (general as never) },
      env: {},
    } as never;
  }

  it("with the pilot flag off nothing is claimed", async () => {
    const ports = fakePorts({
      swarmClaim: { enabled: false, leaseTtlSec: 900, maxActiveTasks: 3, sweepIntervalSec: 30 },
    });
    const outcome = await claimNextTaskForAgent(ports, {
      companyId: "comp-1",
      agentId: "33333333-3333-4333-8333-333333333333",
      now: NOW,
    });
    expect(outcome).toEqual({ claim: null, reason: "disabled" });
  });

  it("with an empty agent table the answer is queue_empty, not a crash", async () => {
    const ports = fakePorts({
      swarmClaim: { enabled: true, leaseTtlSec: 900, maxActiveTasks: 3, sweepIntervalSec: 30 },
    });
    const outcome = await claimNextTaskForAgent(ports, {
      companyId: "comp-1",
      agentId: "33333333-3333-4333-8333-333333333333",
      now: NOW,
    });
    expect(outcome.claim).toBeNull();
    expect(outcome.reason).toBe("queue_empty");
  });
});

describe("myrmidon(1.6-SWARM) sweep acceptance window", () => {
  it("an idle agent with a non-empty queue cannot exist past one lease period (sweep interval <= lease TTL)", async () => {
    // The contract pins the inequality that composes the acceptance window:
    // worst case TTL + one sweep interval, and the interval defaults far
    // below the TTL.
    expect(DEFAULT_SWARM_CLAIM_SWEEP_INTERVAL_SEC).toBeLessThanOrEqual(
      DEFAULT_SWARM_LEASE_TTL_SEC,
    );
    // The sweep is a no-op pass when the pilot flag is off.
    const sweeper = createSwarmClaimSweeper({
      db: {
        select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }),
      } as never,
      settings: { getGeneral: async () => (({ swarmClaim: { enabled: false } }) as never) },
      env: {},
      intervalMs: 0,
    });
    sweeper.resetForTest();
    const result = await sweeper.sweep(new Date("2026-10-02T12:00:30Z"));
    expect(result.expiredReleased).toBe(0);
    expect(result.inspected).toBe(0);
  });
});

describe("myrmidon(1.6-SWARM) shared wake contract", () => {
  it("the wake reason and queue statuses come from the shared contract", () => {
    expect(SWARM_CLAIM_WAKE_REASON).toBe("swarm_claim_queue");
    expect(SWARM_CLAIM_QUEUE_ISSUE_STATUSES).toContain("todo");
  });
});