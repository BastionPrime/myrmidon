import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  instanceSettings,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { heartbeatService } from "../../services/heartbeat.js";
import { LEGACY_RECOVERY_CAUSE } from "../../services/legacy-execution-recovery.js";
import { MAINTENANCE_INTERRUPT_ERROR_CODE } from "./domain.js";
import { resetMaintenanceGateCaches } from "./gate.js";
import { maintenanceHeartbeatPort } from "./index.js";
import { maintenanceService } from "./service.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const ADMIN = { actorType: "user", actorId: "admin-user" };
const SLOW = "setTimeout(() => process.exit(0), 20000)";
const FAST = "process.exit(0)";

describeEmbeddedPostgres("maintenance interrupt_and_retry", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-maintenance-interrupt-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await heartbeatService(db).drainActiveRunExecutions();
    await db.delete(issueRecoveryActions);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(heartbeatRunEvents);
      await db.delete(activityLog);
      try {
        await db.update(heartbeatRuns).set({ retryOfRunId: null });
        await db.delete(heartbeatRuns);
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
    await db.delete(instanceSettings);
    resetMaintenanceGateCaches();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /** An agent working on an assigned issue, its run already started. */
  async function seedIssueRun(script: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: `I${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "agent-a",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", script] },
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Long task",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      responsibleUserId: "user-a",
    });
    const [wakeup] = await db
      .insert(agentWakeupRequests)
      .values({ companyId, agentId, source: "assignment", status: "queued" })
      .returning();
    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: wakeup!.id,
        contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      })
      .returning();
    await heartbeatService(db).resumeQueuedRuns();
    return { companyId, agentId, issueId, runId: run!.id };
  }

  async function waitFor(check: () => Promise<boolean>, timeoutMs = 15_000) {
    const started = Date.now();
    while (!(await check())) {
      if (Date.now() - started > timeoutMs) throw new Error("condition not reached");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async function run(id: string) {
    return (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!;
  }

  async function holds(issueId: string) {
    const rows = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
    return rows.filter((r) => r.cause === LEGACY_RECOVERY_CAUSE);
  }

  it("interrupts at the drain timeout without a reconciliation hold and retries after exit", async () => {
    const { agentId, issueId, runId } = await seedIssueRun(SLOW);
    await waitFor(async () => (await run(runId)).status === "running");

    const svc = maintenanceService(db, { heartbeat: maintenanceHeartbeatPort(heartbeatService(db)) });
    await svc.enter(
      { scope: { type: "instance" }, reason: "deploy", drainTimeoutSec: 0, onTimeout: "interrupt_and_retry" },
      ADMIN,
    );
    await svc.tick();

    const interrupted = await run(runId);
    expect(interrupted).toMatchObject({ status: "cancelled", errorCode: MAINTENANCE_INTERRUPT_ERROR_CODE });
    expect(await holds(issueId)).toEqual([]);
    const window = (await svc.status()).instance!;
    expect(window).toMatchObject({ state: "on", interruptedRuns: 1, runningRuns: 0 });

    // The retry exists and is held by the admission gate while the window is open.
    const retries = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
    expect(retries).toHaveLength(1);
    await heartbeatService(db).promoteDueScheduledRetries();
    await heartbeatService(db).resumeQueuedRuns();
    expect(["queued", "scheduled_retry"]).toContain((await run(retries[0]!.id)).status);

    await db
      .update(agents)
      .set({ adapterConfig: { command: process.execPath, args: ["-e", FAST] } })
      .where(eq(agents.id, agentId));
    // myrmidon(EXIT-ASYNC): exit returns at `leaving`; the tick finishes the
    // leave and resumes the queued retry.
    await svc.exit({ type: "instance" }, ADMIN);
    await svc.tick();
    await waitFor(async () => (await run(retries[0]!.id)).status === "succeeded");
    expect(await holds(issueId)).toEqual([]);
    const actions = await db.select({ action: activityLog.action }).from(activityLog);
    expect(actions.map((a) => a.action)).toContain("myrmidon.maintenance.run_interrupted");
  }, 45_000);

  /**
   * Replay of the production scenario: a planned deploy enters the window with
   * `interrupt_and_retry` and a short drain grace, and five long runs outlast
   * the grace. After the grace the window interrupts all five (no
   * reconciliation hold, so no task is left blocked) and the deploy can switch
   * the image; when the window closes, the five retries start on their own.
   */
  it("a deploy that outlasts the grace interrupts five long runs and resumes all five tasks", async () => {
    const seeds: Awaited<ReturnType<typeof seedIssueRun>>[] = [];
    for (let i = 0; i < 5; i += 1) seeds.push(await seedIssueRun(SLOW));
    await waitFor(
      async () => (await Promise.all(seeds.map((s) => run(s.runId)))).every((r) => r.status === "running"),
      30_000,
    );

    // The window reads time from an injected clock, so the grace boundary is
    // crossed by advancing the clock, not by sleeping against the wall clock
    // (how long enter, the ticks and the database take no longer decides which
    // side of the deadline a tick lands on).
    const graceSec = 300;
    let clock = Date.now();
    const svc = maintenanceService(db, {
      heartbeat: maintenanceHeartbeatPort(heartbeatService(db)),
      now: () => new Date(clock),
    });
    await svc.enter(
      { scope: { type: "instance" }, reason: "deploy", drainTimeoutSec: graceSec, onTimeout: "interrupt_and_retry" },
      ADMIN,
    );
    await svc.tick();
    // Inside the grace the window is still draining; nothing is interrupted yet.
    clock += graceSec * 1000 - 1;
    await svc.tick();
    expect((await svc.status()).instance).toMatchObject({ state: "entering", runningRuns: 5, interruptedRuns: 0 });

    clock += 1;
    await svc.tick();
    // The grace is over: every run is interrupted and leaves `running`.
    expect((await svc.status()).instance).toMatchObject({ interruptedRuns: 5, runningRuns: 0 });

    for (const seed of seeds) {
      const interrupted = await run(seed.runId);
      expect(interrupted).toMatchObject({ status: "cancelled", errorCode: MAINTENANCE_INTERRUPT_ERROR_CODE });
      expect(await holds(seed.issueId)).toEqual([]);
      const issue = (await db.select().from(issues).where(eq(issues.id, seed.issueId)))[0]!;
      expect(issue.status).not.toBe("blocked");
    }

    // Each interrupted run has exactly one held retry; the admission gate keeps
    // it from starting while the window is open.
    const retryIds: string[] = [];
    for (const seed of seeds) {
      const retries = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, seed.runId));
      expect(retries).toHaveLength(1);
      retryIds.push(retries[0]!.id);
    }
    await heartbeatService(db).promoteDueScheduledRetries();
    await heartbeatService(db).resumeQueuedRuns();
    for (const id of retryIds) {
      expect(["queued", "scheduled_retry"]).toContain((await run(id)).status);
    }

    // Nothing is running: the window moves to `on` and the deploy can switch.
    await svc.tick();
    expect((await svc.status()).instance).toMatchObject({ state: "on", runningRuns: 0, interruptedRuns: 5 });

    // The window closes: every task continues on its own, none is left blocked.
    for (const seed of seeds) {
      await db
        .update(agents)
        .set({ adapterConfig: { command: process.execPath, args: ["-e", FAST] } })
        .where(eq(agents.id, seed.agentId));
    }
    await svc.exit({ type: "instance" }, ADMIN);
    // myrmidon(EXIT-ASYNC): exit returns at `leaving`; the tick finishes the
    // leave and resumes the queued retries.
    await svc.tick();
    await waitFor(
      async () => (await Promise.all(retryIds.map((id) => run(id)))).every((r) => r.status === "succeeded"),
      30_000,
    );
    for (const seed of seeds) {
      expect(await holds(seed.issueId)).toEqual([]);
      const issue = (await db.select().from(issues).where(eq(issues.id, seed.issueId)))[0]!;
      expect(issue.status).not.toBe("blocked");
    }
  }, 90_000);

  it("keeps the vendor hold for a real failure, inside or outside maintenance", async () => {
    const outside = await seedIssueRun("process.exit(3)");
    await waitFor(async () => (await run(outside.runId)).status === "failed");
    await heartbeatService(db).drainActiveRunExecutions();
    expect(await holds(outside.issueId)).toHaveLength(1);
  }, 30_000);

  it("keeps the vendor hold for a manual cancel of a started run", async () => {
    const { issueId, runId } = await seedIssueRun(SLOW);
    await waitFor(async () => (await run(runId)).status === "running");
    await heartbeatService(db).cancelRun(runId, "Cancelled by operator");
    await heartbeatService(db).drainActiveRunExecutions();
    const cancelled = await run(runId);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.errorCode).not.toBe(MAINTENANCE_INTERRUPT_ERROR_CODE);
    expect(await holds(issueId)).toHaveLength(1);
  }, 30_000);
});
