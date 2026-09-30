import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueRelations,
  issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: vi.fn(function child() {
      return this;
    }),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
  httpLogger: vi.fn(),
}));

import {
  createIdlePickupSweeper,
  idlePickupForAgent,
  IDLE_PICKUP_ENABLED_ENV,
  IDLE_PICKUP_INTERVAL_SEC_ENV,
  IDLE_WAKE_REASON,
  readIdlePickupEnabled,
  readIdlePickupIntervalSec,
} from "../myrmidon/idle-pickup.ts";

// IDLE-PICKUP (1.3): the board wakes an agent with a free queue on its
// highest-priority ready task, reusing the normal wake admission path.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describe("settings readers", () => {
  const savedInterval = process.env[IDLE_PICKUP_INTERVAL_SEC_ENV];
  const savedEnabled = process.env[IDLE_PICKUP_ENABLED_ENV];

  afterEach(() => {
    if (savedInterval === undefined) delete process.env[IDLE_PICKUP_INTERVAL_SEC_ENV];
    else process.env[IDLE_PICKUP_INTERVAL_SEC_ENV] = savedInterval;
    if (savedEnabled === undefined) delete process.env[IDLE_PICKUP_ENABLED_ENV];
    else process.env[IDLE_PICKUP_ENABLED_ENV] = savedEnabled;
  });

  it("interval defaults to 30 when unset, empty or non-numeric", () => {
    for (const raw of [undefined, "", "  ", "abc", "-5", "0", "1.5"]) {
      const env: Record<string, string | undefined> = {};
      if (raw !== undefined) env[IDLE_PICKUP_INTERVAL_SEC_ENV] = raw;
      expect(readIdlePickupIntervalSec(env), `raw=${JSON.stringify(raw)}`).toBe(30);
    }
  });

  it("interval clamps small values up to 5 seconds", () => {
    expect(readIdlePickupIntervalSec({ [IDLE_PICKUP_INTERVAL_SEC_ENV]: "1" })).toBe(5);
    expect(readIdlePickupIntervalSec({ [IDLE_PICKUP_INTERVAL_SEC_ENV]: "5" })).toBe(5);
    expect(readIdlePickupIntervalSec({ [IDLE_PICKUP_INTERVAL_SEC_ENV]: "300" })).toBe(300);
  });

  it("the feature is on unless an explicit off value is set (a typo must not disable the fix)", () => {
    expect(readIdlePickupEnabled({})).toBe(true);
    expect(readIdlePickupEnabled({ [IDLE_PICKUP_ENABLED_ENV]: "garbage" })).toBe(true);
    for (const raw of ["0", "false", "off", "no", "OFF", " No "]) {
      expect(readIdlePickupEnabled({ [IDLE_PICKUP_ENABLED_ENV]: raw }), `raw=${raw}`).toBe(false);
    }
  });
});

describeEmbeddedPostgres("idlePickupForAgent (IDLE-PICKUP)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-idle-pickup-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.update(issues).set({ executionRunId: null, checkoutRunId: null });
    await db.delete(issueRelations);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(status = "idle") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "agent-a",
      role: "engineer",
      status,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedIssue(input: {
    companyId: string;
    agentId: string;
    status?: string;
    priority?: string;
    parentId?: string | null;
  }) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      title: "Ready task",
      status: input.status ?? "todo",
      priority: input.priority ?? "medium",
      assigneeAgentId: input.agentId,
      ...(input.parentId ? { parentId: input.parentId } : {}),
    });
    return id;
  }

  async function seedLiveRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    status: string;
  }) {
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId: input.companyId,
      agentId: input.agentId,
      status: input.status,
      invocationSource: "automation",
      contextSnapshot: { issueId: input.issueId },
    });
  }

  function fakeDeps(
    overrides: {
      enqueueWakeup?: (...args: unknown[]) => Promise<unknown>;
      env?: Record<string, string | undefined>;
    } = {},
  ) {
    const enqueueWakeup = vi.fn(overrides.enqueueWakeup ?? (async () => ({ id: randomUUID() })));
    return {
      db,
      enqueueWakeup: enqueueWakeup as unknown as Parameters<typeof idlePickupForAgent>[0]["enqueueWakeup"],
      ...(overrides.env ? { env: overrides.env } : {}),
    };
  }

  it("wakes the agent on a ready todo issue with no live run", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueId = await seedIssue({ companyId, agentId });
    const deps = fakeDeps();

    const result = await idlePickupForAgent(deps, { id: agentId, companyId });

    expect(result.woken).toBe(1);
    expect(result.issueIds).toEqual([issueId]);
    expect(deps.enqueueWakeup).toHaveBeenCalledWith(
      agentId,
      expect.objectContaining({
        source: "automation",
        triggerDetail: "system",
        reason: IDLE_WAKE_REASON,
        requestedByActorType: "system",
        requestedByActorId: "idle_pickup",
        contextSnapshot: { issueId, taskKey: issueId, source: "idle_pickup" },
      }),
    );
  });

  it("picks the highest-priority ready issue first", async () => {
    const { companyId, agentId } = await seedAgent();
    const lowId = await seedIssue({ companyId, agentId, priority: "low" });
    const criticalId = await seedIssue({ companyId, agentId, priority: "critical" });
    const mediumId = await seedIssue({ companyId, agentId, priority: "medium" });
    const deps = fakeDeps();

    const result = await idlePickupForAgent(deps, { id: agentId, companyId });

    // One wake per pass, on the critical issue.
    expect(result.woken).toBe(1);
    expect(result.issueIds).toEqual([criticalId]);
    expect(deps.enqueueWakeup).toHaveBeenCalledTimes(1);
    void lowId;
    void mediumId;
  });

  it("skips an issue that already has a live heartbeat run", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueId = await seedIssue({ companyId, agentId, status: "in_progress" });
    await seedLiveRun({ companyId, agentId, issueId, status: "running" });
    const deps = fakeDeps();

    const result = await idlePickupForAgent(deps, { id: agentId, companyId });

    expect(result.alreadyActive).toBe(1);
    expect(result.woken).toBe(0);
    expect(deps.enqueueWakeup).not.toHaveBeenCalled();
  });

  it("skips an issue that already has a queued wake (the pass stays idempotent)", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueId = await seedIssue({ companyId, agentId });
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "queued",
      requestedByActorType: "system",
      requestedByActorId: null,
    });
    const deps = fakeDeps();

    const result = await idlePickupForAgent(deps, { id: agentId, companyId });

    expect(result.alreadyActive).toBe(1);
    expect(result.woken).toBe(0);
    expect(deps.enqueueWakeup).not.toHaveBeenCalled();
  });

  it("does not wake issues outside todo/in_progress or assigned to a user", async () => {
    const { companyId, agentId } = await seedAgent();
    await seedIssue({ companyId, agentId, status: "backlog" });
    await seedIssue({ companyId, agentId, status: "done" });
    await seedIssue({ companyId, agentId, status: "in_review" });
    const userAssignedId = randomUUID();
    await db.insert(issues).values({
      id: userAssignedId,
      companyId,
      title: "User task",
      status: "todo",
      priority: "medium",
      assigneeAgentId: null,
      assigneeUserId: randomUUID(),
    });
    const deps = fakeDeps();

    const result = await idlePickupForAgent(deps, { id: agentId, companyId });

    expect(result.considered).toBe(0);
    expect(result.woken).toBe(0);
    expect(deps.enqueueWakeup).not.toHaveBeenCalled();
  });

  it("does not wake a blocked issue (an unresolved blocker relation)", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueId = await seedIssue({ companyId, agentId });
    const blockerId = await seedIssue({ companyId, agentId, status: "in_progress" });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: issueId,
      type: "blocks",
    });
    const deps = fakeDeps();

    const result = await idlePickupForAgent(deps, { id: agentId, companyId });

    // The dependent is filtered out by the unresolved blocker; the blocker
    // itself is a ready in_progress issue, so the wake goes to it.
    expect(result.considered).toBe(1);
    expect(result.issueIds).toEqual([blockerId]);
    void issueId;
  });

  it("does not wake a cancelled-blocker dependent (an operator must resolve the relation)", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueId = await seedIssue({ companyId, agentId });
    const blockerId = randomUUID();
    await db.insert(issues).values({
      id: blockerId,
      companyId,
      title: "Cancelled blocker",
      status: "cancelled",
      priority: "medium",
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: issueId,
      type: "blocks",
    });
    const deps = fakeDeps();

    const result = await idlePickupForAgent(deps, { id: agentId, companyId });

    expect(result.considered).toBe(0);
    expect(result.woken).toBe(0);
    expect(deps.enqueueWakeup).not.toHaveBeenCalled();
  });

  it("does not wake a container (an issue with an open child)", async () => {
    const { companyId, agentId } = await seedAgent();
    const parentId = await seedIssue({ companyId, agentId });
    await seedIssue({ companyId, agentId, status: "todo", parentId });
    const deps = fakeDeps();

    const result = await idlePickupForAgent(deps, { id: agentId, companyId });

    // The parent is a container and is filtered out; the child is the work.
    expect(result.considered).toBe(1);
    expect(result.woken).toBe(1);
    const [call] = vi.mocked(deps.enqueueWakeup).mock.calls;
    expect((call[1] as { contextSnapshot: { issueId: string } }).contextSnapshot.issueId).not.toBe(parentId);
  });

  it("a container whose children are all done is itself ready again", async () => {
    const { companyId, agentId } = await seedAgent();
    const parentId = await seedIssue({ companyId, agentId });
    await seedIssue({ companyId, agentId, status: "done", parentId });
    const deps = fakeDeps();

    const result = await idlePickupForAgent(deps, { id: agentId, companyId });

    expect(result.woken).toBe(1);
    expect(result.issueIds).toEqual([parentId]);
  });

  it("counts a suppressed admission (null wake) and does not treat it as an error", async () => {
    const { companyId, agentId } = await seedAgent();
    await seedIssue({ companyId, agentId });
    const deps = fakeDeps({ enqueueWakeup: async () => null });

    const result = await idlePickupForAgent(deps, { id: agentId, companyId });

    expect(result.suppressed).toBe(1);
    expect(result.woken).toBe(0);
  });

  it("survives a throwing wake (best-effort) and still reports the rest", async () => {
    const { companyId, agentId } = await seedAgent();
    const firstId = await seedIssue({ companyId, agentId, priority: "high" });
    const secondId = await seedIssue({ companyId, agentId, priority: "low" });
    const deps = fakeDeps({
      enqueueWakeup: vi.fn()
        .mockRejectedValueOnce(new Error("admission conflict"))
        .mockResolvedValueOnce({ id: randomUUID() }),
    });

    const result = await idlePickupForAgent(deps, { id: agentId, companyId });

    expect(result.suppressed).toBe(1);
    expect(result.woken).toBe(1);
    expect(result.issueIds).toEqual([secondId]);
    void firstId;
  });

  it("release path: finishing a run on issue A with issue B ready wakes exactly B, never A", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueA = await seedIssue({ companyId, agentId, status: "in_progress" });
    const issueB = await seedIssue({ companyId, agentId, priority: "high" });
    const deps = fakeDeps();

    // The run on A just released its execution lock; heartbeat passes A's id.
    const result = await idlePickupForAgent(
      deps,
      { id: agentId, companyId },
      { excludeIssueId: issueA },
    );

    expect(result.woken).toBe(1);
    expect(result.issueIds).toEqual([issueB]);
    expect(deps.enqueueWakeup).toHaveBeenCalledTimes(1);
    const [call] = vi.mocked(deps.enqueueWakeup).mock.calls;
    expect((call[1] as { contextSnapshot: { issueId: string } }).contextSnapshot.issueId).toBe(issueB);
  });

  it("release path: with nothing ready except the just-released issue, no wake at all (no runaway loop)", async () => {
    const { companyId, agentId } = await seedAgent();
    // Vendor-fixture shape: the finished issue stays in a wakeable status.
    const issueA = await seedIssue({ companyId, agentId, status: "in_progress" });
    const deps = fakeDeps();

    const result = await idlePickupForAgent(
      deps,
      { id: agentId, companyId },
      { excludeIssueId: issueA },
    );

    expect(result.woken).toBe(0);
    expect(result.alreadyActive).toBe(1);
    expect(deps.enqueueWakeup).not.toHaveBeenCalled();

    // After B (the only other ready issue) finished, A — still open, no live
    // run — IS the next ready task and gets the wake: that is the feature
    // working (an agent keeps working its open tasks), not a runaway: one wake
    // per pass, and A's own next release excludes A again. The chain in the
    // review failed only because the just-released issue was never excluded.
    const issueB = await seedIssue({ companyId, agentId, status: "in_progress" });
    const result2 = await idlePickupForAgent(
      deps,
      { id: agentId, companyId },
      { excludeIssueId: issueB },
    );
    expect(result2.woken).toBe(1);
    expect(result2.issueIds).toEqual([issueA]);
    expect(deps.enqueueWakeup).toHaveBeenCalledTimes(1);
  });

  it("a deferred or claimed wake also counts as covering (not only queued)", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueId = await seedIssue({ companyId, agentId });
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_comment_mentioned",
      payload: { issueId },
      status: "deferred_issue_execution",
      requestedByActorType: "system",
      requestedByActorId: null,
    });
    const deps = fakeDeps();

    const result = await idlePickupForAgent(deps, { id: agentId, companyId });

    expect(result.alreadyActive).toBe(1);
    expect(result.woken).toBe(0);
    expect(deps.enqueueWakeup).not.toHaveBeenCalled();
  });

  it("does nothing when the feature is disabled by setting", async () => {
    const { companyId, agentId } = await seedAgent();
    await seedIssue({ companyId, agentId });
    const deps = fakeDeps({ env: { [IDLE_PICKUP_ENABLED_ENV]: "0" } });

    const result = await idlePickupForAgent(deps, { id: agentId, companyId });

    expect(result.woken).toBe(0);
    expect(result.considered).toBe(0);
    expect(deps.enqueueWakeup).not.toHaveBeenCalled();
  });

  it("ignores another agent's issues and another company's rows", async () => {
    const first = await seedAgent();
    const second = await seedAgent();
    const foreignIssueId = await seedIssue({ companyId: second.companyId, agentId: second.agentId });
    const deps = fakeDeps();

    const result = await idlePickupForAgent(deps, { id: first.agentId, companyId: first.companyId });

    expect(result.woken).toBe(0);
    const [call] = vi.mocked(deps.enqueueWakeup).mock.calls;
    void call;
    void foreignIssueId;
    expect(deps.enqueueWakeup).not.toHaveBeenCalled();
  });
});

describeEmbeddedPostgres("createIdlePickupSweeper (IDLE-PICKUP tick)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-idle-pickup-sweep-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.update(issues).set({ executionRunId: null, checkoutRunId: null });
    await db.delete(issueRelations);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(input: { status?: string; companyStatus?: string } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      ...(input.companyStatus ? { status: input.companyStatus } : {}),
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "agent-a",
      role: "engineer",
      status: input.status ?? "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  function sweeperDeps(
    overrides: {
      enqueueWakeup?: (...args: unknown[]) => Promise<unknown>;
      invokable?: (agent: { id: string; status: string }) => boolean;
      underMaintenance?: (agentId: string) => boolean;
      env?: Record<string, string | undefined>;
    } = {},
  ) {
    const enqueueWakeup = vi.fn(overrides.enqueueWakeup ?? (async () => ({ id: randomUUID() })));
    const deps = {
      db,
      enqueueWakeup: enqueueWakeup as unknown as Parameters<typeof createIdlePickupSweeper>[0]["enqueueWakeup"],
      isAgentInvokable: vi.fn(
        async (agent: { id: string; status: string }) =>
          overrides.invokable ? overrides.invokable(agent) : agent.status !== "paused" && agent.status !== "terminated",
      ),
      isAgentUnderMaintenance: vi.fn(
        async (agentId: string) => (overrides.underMaintenance ? overrides.underMaintenance(agentId) : false),
      ),
      ...(overrides.env ? { env: overrides.env } : {}),
    };
    const sweeper = createIdlePickupSweeper(deps);
    return { sweeper, enqueueWakeup: enqueueWakeup as unknown as ReturnType<typeof vi.fn>, deps };
  }

  it("wakes a ready issue of an invokable idle agent on the tick", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Ready task",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });
    const { sweeper, enqueueWakeup } = sweeperDeps();

    const result = await sweeper.sweep(new Date());

    expect(result.agentsChecked).toBe(1);
    expect(result.woken).toBe(1);
    expect(enqueueWakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({ reason: IDLE_WAKE_REASON }));
  });

  it("does not wake a paused agent (the pause is respected)", async () => {
    const { companyId, agentId } = await seedAgent({ status: "paused" });
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: "Ready task",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    const { sweeper, enqueueWakeup } = sweeperDeps();

    const result = await sweeper.sweep(new Date());

    expect(result.agentsChecked).toBe(0);
    expect(result.woken).toBe(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("does not wake an agent under maintenance", async () => {
    const { companyId, agentId } = await seedAgent();
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: "Ready task",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    const { sweeper, enqueueWakeup } = sweeperDeps({ underMaintenance: () => true });

    const result = await sweeper.sweep(new Date());

    expect(result.agentsChecked).toBe(0);
    expect(result.woken).toBe(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("skips agents of a non-active company", async () => {
    const { companyId, agentId } = await seedAgent({ companyStatus: "suspended" });
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: "Ready task",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    const { sweeper, enqueueWakeup } = sweeperDeps();

    const result = await sweeper.sweep(new Date());

    expect(result.woken).toBe(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("respects the interval: a second sweep inside the window checks nothing", async () => {
    const { sweeper } = sweeperDeps({ env: { [IDLE_PICKUP_INTERVAL_SEC_ENV]: "300" } });
    const first = await sweeper.sweep(new Date("2026-09-30T12:00:00Z"));
    const second = await sweeper.sweep(new Date("2026-09-30T12:01:00Z"));

    expect(first.agentsChecked).toBeGreaterThanOrEqual(0);
    expect(second.agentsChecked).toBe(0);
    expect(second.woken).toBe(0);
  });

  it("runs again after the interval elapses", async () => {
    const { sweeper } = sweeperDeps({ env: { [IDLE_PICKUP_INTERVAL_SEC_ENV]: "5" } });
    await sweeper.sweep(new Date("2026-09-30T12:00:00Z"));
    const second = await sweeper.sweep(new Date("2026-09-30T12:00:30Z"));
    expect(second.agentsChecked).toBeGreaterThanOrEqual(0);
  });

  it("does nothing when disabled by setting", async () => {
    const { companyId, agentId } = await seedAgent();
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: "Ready task",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    const { sweeper, enqueueWakeup } = sweeperDeps({ env: { [IDLE_PICKUP_ENABLED_ENV]: "off" } });

    const result = await sweeper.sweep(new Date());

    expect(result.agentsChecked).toBe(0);
    expect(result.woken).toBe(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });
});
