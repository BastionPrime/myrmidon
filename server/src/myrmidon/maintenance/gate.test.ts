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
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { heartbeatService } from "../../services/heartbeat.js";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { subscribeCompanyLiveEvents } from "../../services/live-events.js";
import { newWindow, type MaintenanceScope } from "./domain.js";
import { resetMaintenanceGateCaches, setMaintenanceDocumentCache } from "./gate.js";
import { mutateMaintenanceDocument, readMaintenanceDocument } from "./store.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("maintenance admission gate", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-maintenance-gate-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await heartbeatService(db).drainActiveRunExecutions();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(heartbeatRunEvents);
      await db.delete(activityLog);
      try {
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

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: `M${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, name: string, reportsTo: string | null = null) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "idle",
      reportsTo,
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true } },
      permissions: {},
    });
    return agentId;
  }

  async function openWindow(scope: MaintenanceScope, companyId: string | null, state: "entering" | "on" = "on") {
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
            state,
          },
        ],
      },
      result: null,
    }));
    resetMaintenanceGateCaches();
  }

  async function closeAllWindows() {
    await mutateMaintenanceDocument(db, (doc) => ({ next: { ...doc, windows: [] }, result: null }));
    resetMaintenanceGateCaches();
  }

  function wake(agentId: string) {
    return heartbeatService(db).wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "maintenance_test",
      requestedByActorType: "user",
      requestedByActorId: "user-a",
    });
  }

  async function runsOf(agentId: string) {
    return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
  }

  async function wakeupsOf(agentId: string) {
    return db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
  }

  async function settle() {
    const heartbeat = heartbeatService(db);
    await heartbeat.drainActiveRunExecutions();
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
  }

  it("keeps a wake queued during instance maintenance and delivers it exactly once after exit", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "agent-a");
    await openWindow({ type: "instance" }, null);

    await wake(agentId);
    await settle();

    const held = await runsOf(agentId);
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ status: "queued", startedAt: null });
    const wakeups = await wakeupsOf(agentId);
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]!.status).toBe("queued");

    await closeAllWindows();
    await settle();
    await settle();

    const done = await runsOf(agentId);
    expect(done).toHaveLength(1);
    expect(done[0]!.status).toBe("succeeded");
    expect((await wakeupsOf(agentId)).map((w) => w.status)).toEqual(["completed"]);
  }, 30_000);

  it("holds only the agent in an agent window", async () => {
    const companyId = await seedCompany();
    const held = await seedAgent(companyId, "agent-held");
    const free = await seedAgent(companyId, "agent-free");
    await openWindow({ type: "agent", id: held }, companyId);

    await wake(held);
    await wake(free);
    await settle();

    expect((await runsOf(held)).map((r) => r.status)).toEqual(["queued"]);
    expect((await runsOf(free)).map((r) => r.status)).toEqual(["succeeded"]);
  }, 30_000);

  it("holds a manager and every subordinate in a department window, not a sibling department", async () => {
    const companyId = await seedCompany();
    const manager = await seedAgent(companyId, "manager-a");
    const lead = await seedAgent(companyId, "lead-a", manager);
    const worker = await seedAgent(companyId, "worker-a", lead);
    const siblingManager = await seedAgent(companyId, "manager-b");
    const siblingWorker = await seedAgent(companyId, "worker-b", siblingManager);
    await openWindow({ type: "department", id: manager }, companyId, "entering");

    for (const agentId of [manager, lead, worker, siblingManager, siblingWorker]) await wake(agentId);
    await settle();

    for (const agentId of [manager, lead, worker]) {
      expect((await runsOf(agentId)).map((r) => r.status)).toEqual(["queued"]);
    }
    for (const agentId of [siblingManager, siblingWorker]) {
      expect((await runsOf(agentId)).map((r) => r.status)).toEqual(["succeeded"]);
    }
  }, 30_000);

  it("releases a run claimed just before a window opened", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "agent-a");
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Work claimed just before a window opens",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      responsibleUserId: "user-a",
    });
    const [wakeup] = await db
      .insert(agentWakeupRequests)
      .values({ companyId, agentId, source: "assignment", status: "queued" })
      .returning();
    const [queued] = await db
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
    const windowOpen = {
      version: 1 as const,
      history: [],
      windows: [
        newWindow({
          id: randomUUID(),
          scope: { type: "company", id: companyId },
          companyId,
          reason: "test window",
          drainTimeoutSec: 60,
          onTimeout: "wait",
          startedBy: null,
          now: new Date(),
        }),
      ],
    };
    // The claim publishes "running" before executeRun's second admission check;
    // opening the window from that event reproduces the gap.
    const unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => {
      const payload = event.payload as { runId?: string; status?: string };
      if (event.type === "heartbeat.run.status" && payload.runId === queued!.id && payload.status === "running") {
        setMaintenanceDocumentCache(windowOpen);
      }
    });
    try {
      await heartbeatService(db).resumeQueuedRuns();
      await heartbeatService(db).drainActiveRunExecutions();
    } finally {
      unsubscribe();
    }
    const [run] = await runsOf(agentId);
    expect(run).toMatchObject({ status: "queued", startedAt: null });
  }, 30_000);

  it("keeps the maintenance key when the vendor saves general settings", async () => {
    await openWindow({ type: "instance" }, null);
    await instanceSettingsService(db).updateGeneral({ censorUsernameInLogs: true });
    const doc = await readMaintenanceDocument(db);
    expect(doc.windows).toHaveLength(1);
    expect((await instanceSettingsService(db).getGeneral()).censorUsernameInLogs).toBe(true);
  });
});
