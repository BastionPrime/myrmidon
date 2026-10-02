// myrmidon(EXIT-ASYNC): the exit path is asynchronous — the HTTP call returns
// as soon as the window is marked `leaving`, and the maintenance tick owns the
// leave tail (resumeQueuedRuns, the onExited hook, the retire write, the audit).
//
// The pure cases pin the decision the tick relies on (`leaving` is not a
// blocking window; the tick finishes it), and the database case is the guard:
// on the previous inline revision `exit()` returned `off` with the window
// already retired, so the `leaving` expectation below fails there.

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
import {
  blockingWindows,
  decideTick,
  newWindow,
  type MaintenanceDocument,
  type MaintenanceWindow,
  type MaintenanceWindowState,
} from "./domain.js";
import { resetMaintenanceGateCaches } from "./gate.js";
import { maintenanceService } from "./service.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const ADMIN = { actorType: "user", actorId: "admin-user" };

function windowInState(state: MaintenanceWindowState): MaintenanceWindow {
  const base = newWindow({
    id: `window-${state}`,
    scope: { type: "instance" },
    companyId: null,
    reason: "deploy test",
    drainTimeoutSec: 60,
    onTimeout: "wait",
    startedBy: null,
    now: new Date("2026-01-01T00:00:00.000Z"),
  });
  return { ...base, state };
}

describe("maintenance async exit: the tick owns the leave tail", () => {
  it("keeps admission closed for `entering`/`on` windows and open for `leaving`", () => {
    const doc: MaintenanceDocument = {
      version: 1,
      windows: [windowInState("entering"), windowInState("on"), windowInState("leaving")],
      history: [],
    };
    expect(blockingWindows(doc).map((w) => w.state)).toEqual(["entering", "on"]);
  });

  it("decides to finish a `leaving` window, not to wait", () => {
    expect(decideTick(windowInState("leaving"), [], new Date())).toEqual({ kind: "finish_leaving" });
  });
});

describeEmbeddedPostgres("maintenance async exit: the service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-maintenance-exit-async-");
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

  function service() {
    return maintenanceService(db, { heartbeat: heartbeatService(db) });
  }

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "agent-a",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true } },
      permissions: {},
    });
    return { companyId, agentId };
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

  async function runStatuses(agentId: string) {
    const rows = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    return rows.map((r) => r.status);
  }

  async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000) {
    const started = Date.now();
    while (!(await check())) {
      if (Date.now() - started > timeoutMs) throw new Error("condition not reached");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  it("exit returns promptly at `leaving` with a queued backlog, then the tick retires the window", async () => {
    const { agentId } = await seed();
    const svc = service();
    await svc.enter({ scope: { type: "agent", id: agentId }, reason: "agent upgrade" }, ADMIN);
    expect((await svc.status()).windows[0]).toMatchObject({ state: "on" });

    // A wake during the window queues behind the admission gate.
    await wake(agentId);
    await heartbeatService(db).resumeQueuedRuns();
    await heartbeatService(db).drainActiveRunExecutions();
    expect((await svc.status()).windows[0]).toMatchObject({ state: "on", queuedRuns: 1 });

    const startedAt = Date.now();
    const exited = await svc.exit({ type: "agent", id: agentId }, ADMIN);
    const elapsedMs = Date.now() - startedAt;

    // The guard: the exit call returns the `leaving` view at once. The inline
    // revision returned `off` here with the window already retired.
    expect(exited).toMatchObject({ state: "leaving", changed: true });
    expect(elapsedMs).toBeLessThan(5_000);
    expect((await svc.status()).windows[0]).toMatchObject({ state: "leaving" });

    // The tick owns the leave tail: it resumes the queued run and retires the
    // window (the old inline finishLeaving did the same work inside exit).
    await svc.tick();
    await heartbeatService(db).drainActiveRunExecutions();
    await waitFor(async () => (await runStatuses(agentId)).every((s) => s === "succeeded"));
    expect(await runStatuses(agentId)).toEqual(["succeeded"]);
    expect((await svc.status()).active).toBe(false);
  }, 30_000);

  it("leaves the window in `leaving` when the exit request is repeated before the tick", async () => {
    const { agentId } = await seed();
    const svc = service();
    await svc.enter({ scope: { type: "agent", id: agentId }, reason: "agent upgrade" }, ADMIN);
    const first = await svc.exit({ type: "agent", id: agentId }, ADMIN);
    expect(first).toMatchObject({ state: "leaving", changed: true });
    // A repeat call is idempotent and still returns promptly with the same view.
    const second = await svc.exit({ type: "agent", id: agentId }, ADMIN);
    expect(second).toMatchObject({ state: "leaving", changed: false });
    await svc.tick();
    expect((await svc.status()).active).toBe(false);
    expect(await svc.exit({ type: "agent", id: agentId }, ADMIN)).toMatchObject({ state: "off", changed: false });
  }, 30_000);
});