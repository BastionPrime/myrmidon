// myrmidon(L3b): the periodic stranded-assigned-issue sweep does not escalate
// the issues of an agent the operator paused. A pause means "no new work, the
// current one drains", so such an issue is either being worked on (a live run)
// or waits for the operator's resume, which wakes it. A budget or any other
// system pause, and MYRMIDON_PAUSE_DRAINS=0, keep the vendor behavior.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { resumeAgentAfterPause } from "../myrmidon/pause-drain.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("reconcileStrandedAssignedIssues: operator-paused agent (L3b)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousDrains = process.env.MYRMIDON_PAUSE_DRAINS;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-stranded-operator-pause-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(() => {
    if (previousDrains === undefined) delete process.env.MYRMIDON_PAUSE_DRAINS;
    else process.env.MYRMIDON_PAUSE_DRAINS = previousDrains;
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  type SeedRun = "none" | "running" | "cancelled_by_pause";

  async function seedPausedAgentIssue(input: {
    pauseReason: string | null;
    issueStatus?: "todo" | "in_progress";
    run: SeedRun;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const now = new Date();

    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "user-a",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "agent-a",
      role: "engineer",
      status: "paused",
      pauseReason: input.pauseReason,
      pausedAt: now,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "task of a paused agent",
      status: input.issueStatus ?? "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "user-a",
      createdAt: new Date(now.getTime() - 60 * 60 * 1000),
    });
    let runId: string | null = null;
    if (input.run !== "none") {
      runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        status: input.run === "running" ? "running" : "cancelled",
        invocationSource: "automation",
        contextSnapshot: { issueId },
        errorCode: input.run === "cancelled_by_pause" ? "agent_paused" : null,
        startedAt: now,
        finishedAt: input.run === "running" ? null : now,
        updatedAt: now,
      });
    }
    return { companyId, agentId, issueId, runId };
  }

  async function recoveryActionsFor(issueId: string) {
    return db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
  }

  async function issueStatus(issueId: string) {
    const [row] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId));
    return row!.status;
  }

  it("does not escalate an issue whose operator-paused agent still has a live draining run", async () => {
    const { issueId, runId } = await seedPausedAgentIssue({ pauseReason: "manual", run: "running" });

    await heartbeatService(db).reconcileStrandedAssignedIssues();

    expect(await recoveryActionsFor(issueId)).toHaveLength(0);
    expect(await issueStatus(issueId)).toBe("in_progress");
    const [run] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId!));
    expect(run!.status).toBe("running");
  }, 30_000);

  it("does not escalate a todo issue of an operator-paused agent that has no run at all", async () => {
    const { issueId } = await seedPausedAgentIssue({ pauseReason: "manual", issueStatus: "todo", run: "none" });

    await heartbeatService(db).reconcileStrandedAssignedIssues();

    expect(await recoveryActionsFor(issueId)).toHaveLength(0);
    expect(await issueStatus(issueId)).toBe("todo");
  }, 30_000);

  it("leaves the issue wakeable: no action or hold after the sweep, and resume wakes it", async () => {
    const { agentId, issueId } = await seedPausedAgentIssue({ pauseReason: "manual", run: "cancelled_by_pause" });

    await heartbeatService(db).reconcileStrandedAssignedIssues();

    expect(await recoveryActionsFor(issueId)).toHaveLength(0);
    expect(await issueStatus(issueId)).toBe("in_progress");

    await db.update(agents).set({ status: "idle", pauseReason: null, pausedAt: null }).where(eq(agents.id, agentId));
    const enqueueWakeup = vi.fn(async (..._args: unknown[]) => ({ id: randomUUID() }));
    const result = await resumeAgentAfterPause(
      { db, startNextQueuedRunForAgent: async () => [], enqueueWakeup },
      agentId,
    );

    expect(result.strandedIssuesWoken).toBe(1);
    expect(enqueueWakeup).toHaveBeenCalledWith(
      agentId,
      expect.objectContaining({ contextSnapshot: expect.objectContaining({ issueId }) }),
    );
  }, 30_000);

  it("keeps the vendor escalation for a budget pause", async () => {
    const { issueId } = await seedPausedAgentIssue({ pauseReason: "budget", run: "cancelled_by_pause" });

    await heartbeatService(db).reconcileStrandedAssignedIssues();

    const actions = await recoveryActionsFor(issueId);
    expect(actions.length).toBeGreaterThan(0);
    expect(actions[0]!.ownerType).toBe("board");
    expect(await issueStatus(issueId)).toBe("blocked");
  }, 30_000);

  it("keeps the vendor escalation for a paused agent without a recorded pause reason", async () => {
    const { issueId } = await seedPausedAgentIssue({ pauseReason: null, run: "cancelled_by_pause" });

    await heartbeatService(db).reconcileStrandedAssignedIssues();

    expect((await recoveryActionsFor(issueId)).length).toBeGreaterThan(0);
    expect(await issueStatus(issueId)).toBe("blocked");
  }, 30_000);

  it("keeps the vendor escalation for an operator pause when MYRMIDON_PAUSE_DRAINS is off", async () => {
    process.env.MYRMIDON_PAUSE_DRAINS = "0";
    const { issueId } = await seedPausedAgentIssue({ pauseReason: "manual", run: "cancelled_by_pause" });

    await heartbeatService(db).reconcileStrandedAssignedIssues();

    expect((await recoveryActionsFor(issueId)).length).toBeGreaterThan(0);
    expect(await issueStatus(issueId)).toBe("blocked");
  }, 30_000);
});
