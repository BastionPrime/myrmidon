import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  instanceSettings,
  issueWatchdogs,
  issues,
  projects,
  routineRuns,
  routineTriggers,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { heartbeatService } from "../../services/heartbeat.js";
import { routineService } from "../../services/routines.js";
import { taskWatchdogService } from "../../services/task-watchdogs.js";
import { newWindow, type MaintenanceScope } from "./domain.js";
import { resetMaintenanceGateCaches } from "./gate.js";
import { mutateMaintenanceDocument } from "./store.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("maintenance holds routines and watchdog sweeps", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-maintenance-sweeps-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await heartbeatService(db).drainActiveRunExecutions();
    // Each test uses its own company; only the window state is shared.
    await db.delete(instanceSettings);
    resetMaintenanceGateCaches();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: `W${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "user-a",
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, overrides: Partial<typeof agents.$inferInsert> = {}) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `agent-${agentId.slice(0, 6)}`,
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true } },
      permissions: {},
      ...overrides,
    });
    return agentId;
  }

  async function openWindow(scope: MaintenanceScope, companyId: string | null) {
    await mutateMaintenanceDocument(db, (doc) => ({
      next: {
        ...doc,
        windows: [
          ...doc.windows,
          {
            ...newWindow({
              id: randomUUID(),
              scope,
              companyId,
              reason: "test window",
              drainTimeoutSec: 60,
              onTimeout: "wait",
              startedBy: null,
              now: new Date(),
            }),
            state: "on" as const,
          },
        ],
      },
      result: null,
    }));
    resetMaintenanceGateCaches();
  }

  async function closeWindows() {
    await mutateMaintenanceDocument(db, (doc) => ({ next: { ...doc, windows: [] }, result: null }));
    resetMaintenanceGateCaches();
  }

  describe("routines", () => {
    async function seedRoutine(catchUpPolicy: "skip_missed" | "enqueue_missed_with_cap") {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const projectId = randomUUID();
      await db.insert(projects).values({ id: projectId, companyId, name: "routines", status: "in_progress" });
      const wakes: string[] = [];
      const svc = routineService(db, {
        heartbeat: {
          wakeup: async (wakeAgentId) => {
            wakes.push(wakeAgentId);
            return null;
          },
        },
      });
      const routine = await svc.create(
        companyId,
        {
          projectId,
          goalId: null,
          parentIssueId: null,
          title: "hourly report",
          description: null,
          assigneeAgentId: agentId,
          priority: "medium",
          status: "active",
          concurrencyPolicy: "always_enqueue",
          catchUpPolicy,
          variables: [],
        },
        {},
      );
      const { trigger } = await svc.createTrigger(
        routine.id,
        { kind: "schedule", enabled: true, cronExpression: "0 * * * *", timezone: "UTC" },
        {},
      );
      await db
        .update(routineTriggers)
        .set({ nextRunAt: new Date("2026-07-16T00:00:00.000Z") })
        .where(eq(routineTriggers.id, trigger.id));
      return { companyId, agentId, routine, trigger, svc, wakes };
    }

    it("skips a due tick for an agent under maintenance and does not replay it after exit", async () => {
      const { agentId, routine, trigger, svc } = await seedRoutine("enqueue_missed_with_cap");
      await openWindow({ type: "agent", id: agentId }, null);

      // Three hourly ticks are due; with the vendor catch-up policy they would all replay.
      expect(await svc.tickScheduledTriggers(new Date("2026-07-16T02:30:00.000Z"))).toEqual({ triggered: 0 });
      const runs = await db.select().from(routineRuns).where(eq(routineRuns.routineId, routine.id));
      expect(runs).toMatchObject([{ status: "skipped", failureReason: "maintenance", linkedIssueId: null }]);
      const [after] = await db.select().from(routineTriggers).where(eq(routineTriggers.id, trigger.id));
      expect(after!.nextRunAt).toEqual(new Date("2026-07-16T03:00:00.000Z"));

      await closeWindows();
      expect(await svc.tickScheduledTriggers(new Date("2026-07-16T02:40:00.000Z"))).toEqual({ triggered: 0 });
      expect(await svc.tickScheduledTriggers(new Date("2026-07-16T03:00:30.000Z"))).toEqual({ triggered: 1 });
    });

    it("keeps firing routines outside the window", async () => {
      const { routine, svc } = await seedRoutine("skip_missed");
      const other = await seedCompany();
      await openWindow({ type: "company", id: other }, other);
      expect(await svc.tickScheduledTriggers(new Date("2026-07-16T00:00:30.000Z"))).toEqual({ triggered: 1 });
      const runs = await db.select().from(routineRuns).where(eq(routineRuns.routineId, routine.id));
      expect(runs.map((r) => r.status)).not.toContain("skipped");
    });
  });

  it("does not create timer wakes for agents under maintenance", async () => {
    const companyId = await seedCompany();
    const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const held = await seedAgent(companyId, { lastHeartbeatAt: longAgo });
    const free = await seedAgent(companyId, { lastHeartbeatAt: longAgo });
    await openWindow({ type: "agent", id: held }, companyId);

    await heartbeatService(db).tickTimers(new Date());
    await heartbeatService(db).drainActiveRunExecutions();

    const wakesOf = async (agentId: string) =>
      db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(await wakesOf(held)).toHaveLength(0);
    expect((await wakesOf(free)).length).toBeGreaterThan(0);
  }, 30_000);

  it("does not redispatch stranded issues of agents under maintenance", async () => {
    const companyId = await seedCompany();
    const held = await seedAgent(companyId);
    const free = await seedAgent(companyId);
    for (const agentId of [held, free]) {
      await db.insert(issues).values({
        companyId,
        title: "assigned but idle",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        responsibleUserId: "user-a",
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
      });
    }
    await openWindow({ type: "agent", id: held }, companyId);

    await heartbeatService(db).reconcileStrandedAssignedIssues();
    await heartbeatService(db).drainActiveRunExecutions();

    const runsOf = async (agentId: string) =>
      db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(await runsOf(held)).toHaveLength(0);
    expect((await runsOf(free)).length).toBeGreaterThan(0);
  }, 30_000);

  it("does not wake task watchdogs whose watchdog agent or watched assignee is under maintenance", async () => {
    const companyId = await seedCompany();
    const watchdogAgent = await seedAgent(companyId, { adapterType: "codex_local", adapterConfig: {} });
    const heldWorker = await seedAgent(companyId);
    const seedWatched = async (assigneeAgentId: string | null) => {
      const [issue] = await db
        .insert(issues)
        .values({
          companyId,
          title: "watched",
          status: "done",
          priority: "medium",
          assigneeAgentId,
          createdAt: new Date(Date.now() - 60 * 60 * 1000),
        })
        .returning();
      await db.insert(issueWatchdogs).values({
        companyId,
        issueId: issue!.id,
        watchdogAgentId: watchdogAgent,
        instructions: "Verify stopped work.",
        status: "active",
      });
      return issue!.id;
    };
    await seedWatched(heldWorker);
    await seedWatched(null);
    await openWindow({ type: "agent", id: heldWorker }, companyId);

    const wakes: string[] = [];
    const service = taskWatchdogService(db, {
      enqueueWakeup: async (agentId) => {
        wakes.push(agentId);
        return { id: randomUUID() };
      },
    });
    const first = await service.reconcileTaskWatchdogs({ companyId });
    expect(first).toMatchObject({ checked: 1, triggered: 1 });

    await openWindow({ type: "agent", id: watchdogAgent }, companyId);
    const second = await service.reconcileTaskWatchdogs({ companyId });
    expect(second).toMatchObject({ checked: 0, triggered: 0 });
    expect(wakes).toHaveLength(1);
    const watchdogs = await db
      .select()
      .from(issueWatchdogs)
      .where(and(eq(issueWatchdogs.companyId, companyId), eq(issueWatchdogs.status, "active")));
    expect(watchdogs).toHaveLength(2);
  }, 30_000);
});
