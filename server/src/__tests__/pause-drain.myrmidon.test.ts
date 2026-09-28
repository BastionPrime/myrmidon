import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agentWakeupRequests, agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
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

import { logger } from "../middleware/logger.ts";
import { resumeAgentAfterPause } from "../myrmidon/pause-drain.ts";

// L3: resume wakes queued runs and stranded assigned issues a drained pause left idle.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("resumeAgentAfterPause (L3)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-myrmidon-pause-drain-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  beforeEach(() => {
    vi.mocked(logger.warn).mockClear();
  });

  afterEach(async () => {
    await db.update(issues).set({ executionRunId: null, checkoutRunId: null });
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent() {
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
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedIssue(input: { companyId: string; agentId: string; status: string }) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      title: "Stranded task",
      status: input.status,
      priority: "medium",
      assigneeAgentId: input.agentId,
    });
    return id;
  }

  async function seedLiveRun(input: { companyId: string; agentId: string; issueId: string; status: string }) {
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId: input.companyId,
      agentId: input.agentId,
      status: input.status,
      invocationSource: "automation",
      contextSnapshot: { issueId: input.issueId },
    });
  }

  function fakeDeps(overrides: { startNextQueuedRunForAgent?: () => Promise<unknown[]>; enqueueWakeup?: (...args: unknown[]) => Promise<unknown> } = {}) {
    const startNextQueuedRunForAgent = vi.fn(overrides.startNextQueuedRunForAgent ?? (async () => []));
    const enqueueWakeup = vi.fn(overrides.enqueueWakeup ?? (async () => ({ id: randomUUID() })));
    return { db, startNextQueuedRunForAgent, enqueueWakeup };
  }

  it("does nothing for an agent that no longer exists", async () => {
    const deps = fakeDeps();

    const result = await resumeAgentAfterPause(deps, randomUUID());

    expect(result).toEqual({ queuedRunsPromoted: 0, strandedIssuesWoken: 0 });
    expect(deps.startNextQueuedRunForAgent).not.toHaveBeenCalled();
    expect(deps.enqueueWakeup).not.toHaveBeenCalled();
  });

  it("promotes queued runs through the injected admission path", async () => {
    const { agentId } = await seedAgent();
    const deps = fakeDeps({ startNextQueuedRunForAgent: async () => [{ id: "run-1" }, { id: "run-2" }] });

    const result = await resumeAgentAfterPause(deps, agentId);

    expect(result.queuedRunsPromoted).toBe(2);
    expect(deps.startNextQueuedRunForAgent).toHaveBeenCalledWith(agentId);
  });

  it("wakes an assigned todo/in_progress issue that has no live run", async () => {
    const { companyId, agentId } = await seedAgent();
    const todoId = await seedIssue({ companyId, agentId, status: "todo" });
    const inProgressId = await seedIssue({ companyId, agentId, status: "in_progress" });
    const deps = fakeDeps();

    const result = await resumeAgentAfterPause(deps, agentId);

    expect(result.strandedIssuesWoken).toBe(2);
    expect(deps.enqueueWakeup).toHaveBeenCalledTimes(2);
    expect(deps.enqueueWakeup).toHaveBeenCalledWith(
      agentId,
      expect.objectContaining({
        idempotencyKey: `pause_resume:${todoId}`,
        requestedByActorType: "system",
        contextSnapshot: { issueId: todoId, taskKey: todoId, resumeIntent: true },
      }),
    );
    expect(deps.enqueueWakeup).toHaveBeenCalledWith(
      agentId,
      expect.objectContaining({ idempotencyKey: `pause_resume:${inProgressId}` }),
    );
  });

  it("ignores issues outside todo/in_progress", async () => {
    const { companyId, agentId } = await seedAgent();
    await seedIssue({ companyId, agentId, status: "backlog" });
    await seedIssue({ companyId, agentId, status: "done" });
    const deps = fakeDeps();

    const result = await resumeAgentAfterPause(deps, agentId);

    expect(result.strandedIssuesWoken).toBe(0);
    expect(deps.enqueueWakeup).not.toHaveBeenCalled();
  });

  it("skips an issue that already has a live heartbeat run", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueId = await seedIssue({ companyId, agentId, status: "in_progress" });
    await seedLiveRun({ companyId, agentId, issueId, status: "running" });
    const deps = fakeDeps();

    const result = await resumeAgentAfterPause(deps, agentId);

    expect(result.strandedIssuesWoken).toBe(0);
    expect(deps.enqueueWakeup).not.toHaveBeenCalled();
  });

  it("is idempotent: a second call leaves an issue alone once the first call's wake landed a live run", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueId = await seedIssue({ companyId, agentId, status: "todo" });
    // The fake stands in for the real enqueueWakeup's own effect: a
    // successful wake creates a queued heartbeat run for the issue.
    const deps = fakeDeps({
      enqueueWakeup: async () => {
        await seedLiveRun({ companyId, agentId, issueId, status: "queued" });
        return { id: randomUUID() };
      },
    });

    const first = await resumeAgentAfterPause(deps, agentId);
    const second = await resumeAgentAfterPause(deps, agentId);

    expect(first.strandedIssuesWoken).toBe(1);
    expect(second.strandedIssuesWoken).toBe(0);
    expect(deps.enqueueWakeup).toHaveBeenCalledTimes(1);
  });

  it("does not let one stranded issue's wake failure block the others", async () => {
    const { companyId, agentId } = await seedAgent();
    const failingId = await seedIssue({ companyId, agentId, status: "todo" });
    const okId = await seedIssue({ companyId, agentId, status: "todo" });
    // Keyed on the issue id, not call order: the two issues' select order is
    // not guaranteed, and the failure must stay tied to the same issue either way.
    const deps = fakeDeps({
      enqueueWakeup: async (...args: unknown[]) => {
        const opts = args[1] as { contextSnapshot?: { issueId?: string } };
        if (opts.contextSnapshot?.issueId === failingId) {
          throw new Error("execution blocker rejected the wake");
        }
        return { id: randomUUID() };
      },
    });

    const result = await resumeAgentAfterPause(deps, agentId);

    expect(deps.enqueueWakeup).toHaveBeenCalledTimes(2);
    expect(result.strandedIssuesWoken).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ agentId, issueId: failingId }),
      expect.stringContaining("wake failed"),
    );
    void okId;
  });

  it("does not wake an issue assigned to a different agent in the same company", async () => {
    const { companyId, agentId } = await seedAgent();
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "agent-b",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await seedIssue({ companyId, agentId: otherAgentId, status: "todo" });
    const deps = fakeDeps();

    const result = await resumeAgentAfterPause(deps, agentId);

    expect(result.strandedIssuesWoken).toBe(0);
    expect(deps.enqueueWakeup).not.toHaveBeenCalled();
  });
});
