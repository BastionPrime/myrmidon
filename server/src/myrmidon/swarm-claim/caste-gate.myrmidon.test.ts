// server/src/myrmidon/swarm-claim/caste-gate.myrmidon.test.ts
//
// myrmidon(1.6.1 CUSTOM-CASTES B): the acceptance tests of the caste consumers
// of the swarm claim.
//
// The decisions this file pins, at the seam where they are enforced — the
// claim service, with the store/queue reads faked at the module seam (the
// *.myrmidon.test.ts style of this repo: no database, neutral data):
//
//   1. an agent whose caste is swarmEligible=false never claims (reason
//      `caste_excluded`), and the queue read never even runs;
//   2. a caste-set maxActiveTasks overrides the global swarm ceiling: with
//      maxActiveTasks=1 the second active task is refused while the global
//      ceiling of 3 would still claim;
//   3. a role with no caste entry, and a service with no directory port
//      wired (the pre-part-A build), keep the legacy behavior exactly;
//   4. the queue is the agent's own role queue (the claim path consults
//      `agent.role` for the queue read, which is what keeps a reviewer out
//      of the engineer queue).
//
// The directory read is the contract of part A (GET /api/myrmidon/companies/
// :id/castes); until it lands this test drives the port with an in-memory
// fake — exactly the "mock the directory read" the ticket prescribes.

import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SWARM_LEASE_TTL_SEC,
  DEFAULT_SWARM_MAX_ACTIVE_TASKS,
  DEFAULT_SWARM_CLAIM_SWEEP_INTERVAL_SEC,
  swarmActiveTaskLimitReached,
  SWARM_CLAIM_REASON_CASTE_EXCLUDED,
  type CompanyCaste,
  type SwarmClaimLease,
} from "@paperclipai/shared";

const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-03T12:00:00Z");
const QUEUE_ISSUE_ID = "a1111111-1111-4111-8111-111111111111";
const HELD_ISSUE_ID = "b2222222-2222-4222-8222-222222222222";

const castes: readonly CompanyCaste[] = [
  { key: "engineer", swarmEligible: true, maxActiveTasks: null },
  { key: "reviewer", swarmEligible: true, maxActiveTasks: null },
  { key: "lead", swarmEligible: false, maxActiveTasks: null },
  { key: "focused-qa", swarmEligible: true, maxActiveTasks: 1 },
];

// --- module-seam fakes -----------------------------------------------------

const mockListRoleQueue = vi.hoisted(() => vi.fn());
const mockListAgentLiveClaims = vi.hoisted(() => vi.fn());
const mockListCompanyClaims = vi.hoisted(() => vi.fn());
const mockInsertClaim = vi.hoisted(() => vi.fn());

let serviceModules: typeof import("./service.js") | null = null;

beforeAll(async () => {
  vi.doMock("./queue.js", () => ({
    listRoleQueue: mockListRoleQueue,
    listAgentsOfRole: vi.fn(async () => []),
    listQueuedRoles: vi.fn(async () => []),
    roleQueueRows: vi.fn(async () => []),
  }));
  vi.doMock("./store.js", () => ({
    listAgentLiveClaims: mockListAgentLiveClaims,
    listCompanyClaims: mockListCompanyClaims,
    findLiveClaimForIssue: vi.fn(async () => null),
    heartbeatClaim: vi.fn(async () => true),
    insertClaim: mockInsertClaim,
    releaseClaim: vi.fn(async () => null),
    releaseClaimsForIssue: vi.fn(async () => []),
    listRoleQueueCompanyClaims: vi.fn(async () => []),
  }));
  serviceModules = await vi.importActual<typeof import("./service.js")>("./service.js");
});

// The service reads the agent row through drizzle against `ports.db`; the
// fake only needs the select-shape the service builds.
function fakeDb(role: string) {
  const agentRows = [{ id: AGENT_ID, role, companyId: COMPANY_ID }];
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => agentRows,
        }),
      }),
    }),
    __role: role,
  } as never;
}

function liveClaim(issueId: string): SwarmClaimLease {
  return {
    id: `claim-${issueId}`,
    issueId,
    agentId: AGENT_ID,
    heartbeatAt: NOW,
    expiresAt: new Date(NOW.getTime() + 60_000),
    releasedAt: null,
  };
}

/** Queue holds one ready task; the agent holds `held` live claims. */
function armStore(input: { held: number }) {
  mockListRoleQueue.mockClear();
  mockListRoleQueue.mockResolvedValue([
    {
      issueId: QUEUE_ISSUE_ID,
      identifier: "ISSUE-A",
      priority: "medium",
      queuedAt: new Date("2026-10-03T10:00:00Z"),
    },
  ]);
  const held = Array.from({ length: input.held }, (_, i) =>
    liveClaim(`c${i}0000000-0000-4000-8000-00000000000${i}`),
  );
  mockListAgentLiveClaims.mockClear();
  mockListAgentLiveClaims.mockResolvedValue(held);
  mockListCompanyClaims.mockClear();
  mockListCompanyClaims.mockResolvedValue([]);
}

const insertedClaim = {
  id: "claim-new",
  issueId: QUEUE_ISSUE_ID,
  agentId: AGENT_ID,
  heartbeatAt: NOW,
  expiresAt: new Date(NOW.getTime() + DEFAULT_SWARM_LEASE_TTL_SEC * 1000),
  releasedAt: null,
};

function portsFor(input: { role: string; directory?: readonly CompanyCaste[] }) {
  return {
    db: fakeDb(input.role),
    settings: {
      getGeneral: async () =>
        ({
          swarmClaim: {
            enabled: true,
            leaseTtlSec: DEFAULT_SWARM_LEASE_TTL_SEC,
            maxActiveTasks: DEFAULT_SWARM_MAX_ACTIVE_TASKS,
            sweepIntervalSec: DEFAULT_SWARM_CLAIM_SWEEP_INTERVAL_SEC,
          },
        }) as never,
    },
    castes: input.directory
      ? async (companyId: string) => {
          expect(companyId).toBe(COMPANY_ID);
          return input.directory!;
        }
      : undefined,
    env: {},
  } as never;
}

// --- tests -----------------------------------------------------------------

describe("myrmidon(1.6.1 CUSTOM-CASTES B) swarm caste gate", () => {
  it("an agent of a swarmEligible=false caste never claims (reason caste_excluded)", async () => {
    armStore({ held: 0 });
    mockInsertClaim.mockClear();
    const outcome = await serviceModules!.claimNextTaskForAgent(
      portsFor({ role: "lead", directory: castes }),
      { companyId: COMPANY_ID, agentId: AGENT_ID, now: NOW },
    );
    expect(outcome).toEqual({ claim: null, reason: "caste_excluded" });
    // The excluded caste never even looks at the queue.
    expect(mockListRoleQueue).not.toHaveBeenCalled();
    expect(mockInsertClaim).not.toHaveBeenCalled();
  });

  it("an eligible caste proceeds: the queue read is the agent's own role queue", async () => {
    armStore({ held: 0 });
    const outcome = await serviceModules!.claimNextTaskForAgent(
      portsFor({ role: "reviewer", directory: castes }),
      { companyId: COMPANY_ID, agentId: AGENT_ID, now: NOW },
    );
    // The queue read was made for the reviewer role — an agent of the
    // reviewer caste is offered the reviewer queue, never another role's.
    expect(mockListRoleQueue).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, "reviewer");
    expect(outcome.reason).not.toBe("caste_excluded");
  });

  it("a caste-set maxActiveTasks=1 refuses the second active task (global 3 would claim)", async () => {
    armStore({ held: 1 });
    mockInsertClaim.mockClear();
    mockInsertClaim.mockResolvedValue(insertedClaim);
    // focused-qa carries maxActiveTasks=1; the agent already holds one task.
    const casteOutcome = await serviceModules!.claimNextTaskForAgent(
      portsFor({ role: "focused-qa", directory: castes }),
      { companyId: COMPANY_ID, agentId: AGENT_ID, now: NOW },
    );
    expect(casteOutcome).toEqual({ claim: null, reason: "limit_reached" });
    expect(mockInsertClaim).not.toHaveBeenCalled();

    // The same one-held-task state against the global ceiling (3) claims.
    const globalOutcome = await serviceModules!.claimNextTaskForAgent(
      portsFor({ role: "engineer", directory: castes }),
      { companyId: COMPANY_ID, agentId: AGENT_ID, now: NOW },
    );
    expect(globalOutcome.reason).toBe("claimed");
    expect(globalOutcome.claim).toMatchObject({ issueId: QUEUE_ISSUE_ID, agentId: AGENT_ID });
  });

  it("a role with no caste entry stays eligible (the directory is additive)", async () => {
    armStore({ held: 0 });
    mockInsertClaim.mockClear();
    mockInsertClaim.mockResolvedValue(insertedClaim);
    const outcome = await serviceModules!.claimNextTaskForAgent(
      portsFor({ role: "engineer", directory: [] }),
      { companyId: COMPANY_ID, agentId: AGENT_ID, now: NOW },
    );
    expect(outcome.reason).toBe("claimed");
  });

  it("no directory port wired (pre-part-A build) keeps the legacy behavior", async () => {
    armStore({ held: 0 });
    mockInsertClaim.mockClear();
    mockInsertClaim.mockResolvedValue(insertedClaim);
    const outcome = await serviceModules!.claimNextTaskForAgent(
      portsFor({ role: "lead" }),
      { companyId: COMPANY_ID, agentId: AGENT_ID, now: NOW },
    );
    // Without the directory the gate cannot know about the lead caste: the
    // claim path runs to the end exactly as before the directory existed.
    expect(outcome.reason).not.toBe("caste_excluded");
    expect(outcome.reason).toBe("claimed");
  });

  it("the shared contract exposes the caste_excluded reason and the ceiling rule", () => {
    expect(SWARM_CLAIM_REASON_CASTE_EXCLUDED).toBe("caste_excluded");
    expect(swarmActiveTaskLimitReached(1, { maxActiveTasks: 1 })).toBe(true);
    expect(swarmActiveTaskLimitReached(1, { maxActiveTasks: 3 })).toBe(false);
    expect(swarmActiveTaskLimitReached(1, { maxActiveTasks: null })).toBe(false);
  });
});
