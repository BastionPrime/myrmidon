import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, like } from "drizzle-orm";
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
import { errorHandler } from "../../middleware/index.js";
import { healthRoutes } from "../../routes/health.js";
import { heartbeatService } from "../../services/heartbeat.js";
import { isAgentUnderMaintenance, resetMaintenanceGateCaches } from "./gate.js";
import { maintenanceHealth } from "./index.js";
import { maintenanceRoutes } from "./routes.js";
import { maintenanceService } from "./service.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const ADMIN = { actorType: "user", actorId: "admin-user" };

describeEmbeddedPostgres("maintenance service and API", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-maintenance-service-");
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

  function service(now?: () => Date) {
    return maintenanceService(db, { heartbeat: heartbeatService(db), now });
  }

  async function seed(script = "process.exit(0)") {
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
      adapterConfig: { command: process.execPath, args: ["-e", script] },
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

  it("enters instance maintenance straight to `on` when nothing runs, and logs it", async () => {
    const { companyId } = await seed();
    const result = await service().enter({ scope: { type: "instance" }, reason: "deploy test" }, ADMIN);
    expect(result).toMatchObject({
      changed: true,
      state: "on",
      scope: { type: "instance" },
      runningRuns: 0,
      drainTimeoutSec: 900,
      onTimeout: "wait",
      reason: "deploy test",
    });
    const status = await service().status();
    expect(status.active).toBe(true);
    expect(status.instance?.state).toBe("on");
    const actions = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), like(activityLog.action, "myrmidon.maintenance.%")));
    expect(actions.map((a) => a.action).sort()).toEqual([
      "myrmidon.maintenance.enter_requested",
      "myrmidon.maintenance.on",
    ]);
    expect(await maintenanceHealth(db)).toEqual({ active: true, instanceState: "on", windows: 1 });
  });

  it("lets a running run finish, then turns on; exit delivers the queued wake exactly once", async () => {
    const { agentId } = await seed("setTimeout(() => process.exit(0), 1500)");
    await wake(agentId);
    await waitFor(async () => (await runStatuses(agentId)).includes("running"));

    const svc = service();
    const entered = await svc.enter({ scope: { type: "agent", id: agentId }, reason: "agent upgrade" }, ADMIN);
    expect(entered).toMatchObject({ state: "entering", runningRuns: 1 });

    await heartbeatService(db).drainActiveRunExecutions();
    await svc.tick();
    expect((await svc.status()).windows[0]).toMatchObject({ state: "on", runningRuns: 0, queuedRuns: 0 });

    // A wake during the window queues behind the admission gate.
    await wake(agentId);
    await heartbeatService(db).resumeQueuedRuns();
    expect((await svc.status()).windows[0]).toMatchObject({ state: "on", queuedRuns: 1, queuedWakeups: 1 });
    expect((await runStatuses(agentId)).sort()).toEqual(["queued", "succeeded"]);

    const exited = await svc.exit({ type: "agent", id: agentId }, ADMIN);
    expect(exited).toMatchObject({ state: "off", changed: true });
    await heartbeatService(db).drainActiveRunExecutions();
    await waitFor(async () => (await runStatuses(agentId)).every((s) => s === "succeeded"));
    expect(await runStatuses(agentId)).toEqual(["succeeded", "succeeded"]);
    expect((await svc.status()).active).toBe(false);
  }, 30_000);

  it("reports a drain timeout once and keeps waiting with onTimeout=wait", async () => {
    const { agentId } = await seed("setTimeout(() => process.exit(0), 3000)");
    await wake(agentId);
    await waitFor(async () => (await runStatuses(agentId)).includes("running"));
    let clock = new Date();
    const svc = service(() => clock);
    await svc.enter({ scope: { type: "instance" }, reason: "deploy", drainTimeoutSec: 1 }, ADMIN);
    clock = new Date(clock.getTime() + 2_000);
    await svc.tick();
    await svc.tick();
    const window = (await svc.status()).instance!;
    expect(window).toMatchObject({ state: "entering", drainTimedOut: true, runningRuns: 1 });
    const timeouts = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "myrmidon.maintenance.drain_timed_out"));
    expect(timeouts).toHaveLength(1);
    await heartbeatService(db).drainActiveRunExecutions();
    await svc.tick();
    expect((await svc.status()).instance?.state).toBe("on");
    expect(await runStatuses(agentId)).toEqual(["succeeded"]);
  }, 30_000);

  it("is idempotent for scripts and validates scope ids", async () => {
    const { companyId } = await seed();
    const svc = service();
    const first = await svc.enter({ scope: { type: "company", id: companyId }, reason: "first" }, ADMIN);
    const second = await svc.enter({ scope: { type: "company", id: companyId }, reason: "second" }, ADMIN);
    expect(second).toMatchObject({ changed: false, id: first.id, reason: "first" });
    await expect(svc.enter({ scope: { type: "agent", id: randomUUID() }, reason: "x" }, ADMIN)).rejects.toMatchObject({
      status: 404,
    });
    expect(await svc.exit({ type: "instance" }, ADMIN)).toEqual({ scope: { type: "instance" }, state: "off", changed: false });
    expect(await svc.exit({ type: "company", id: companyId }, ADMIN)).toMatchObject({ state: "off", changed: true });
    expect(await svc.exit({ type: "company", id: companyId }, ADMIN)).toMatchObject({ state: "off", changed: false });
  });

  it("survives a server restart: a fresh process restores the window before admitting runs", async () => {
    const { agentId } = await seed();
    await service().enter({ scope: { type: "instance" }, reason: "deploy" }, ADMIN);

    // Simulate a new process: nothing cached.
    resetMaintenanceGateCaches();
    await service().restore();
    expect(await isAgentUnderMaintenance(db, agentId)).toBe(true);
    await wake(agentId);
    await heartbeatService(db).resumeQueuedRuns();
    await heartbeatService(db).drainActiveRunExecutions();
    expect(await runStatuses(agentId)).toEqual(["queued"]);
  }, 30_000);

  describe("routes", () => {
    function app(actor: unknown) {
      const server = express();
      server.use(express.json());
      server.use((req, _res, next) => {
        (req as unknown as { actor: unknown }).actor = actor;
        next();
      });
      server.use("/api", maintenanceRoutes(db, service()));
      server.use(errorHandler);
      return server;
    }

    const admin = { type: "board", source: "session", userId: "admin-user", isInstanceAdmin: true, companyIds: [] };
    const member = { type: "board", source: "session", userId: "user-a", isInstanceAdmin: false, companyIds: ["c"] };
    const agentActor = { type: "agent", source: "agent_key", agentId: "a", companyId: "c", keyId: "k" };
    const enterBody = { action: "enter", scope: { type: "instance" }, reason: "deploy" };

    it("allows only instance admins to change the mode", async () => {
      await request(app(member)).post("/api/myrmidon/maintenance").send(enterBody).expect(403);
      await request(app(agentActor)).post("/api/myrmidon/maintenance").send(enterBody).expect(403);
      await request(app(agentActor)).get("/api/myrmidon/maintenance").expect(403);
      expect((await service().status()).active).toBe(false);

      const res = await request(app(admin)).post("/api/myrmidon/maintenance").send(enterBody).expect(200);
      expect(res.body).toMatchObject({ state: "on", changed: true, scope: { type: "instance" } });
      const seen = await request(app(member)).get("/api/myrmidon/maintenance").expect(200);
      expect(seen.body).toMatchObject({ active: true, instance: { state: "on" } });
      const exit = await request(app(admin))
        .post("/api/myrmidon/maintenance")
        .send({ action: "exit", scope: { type: "instance" } })
        .expect(200);
      expect(exit.body).toMatchObject({ state: "off", changed: true });
    });

    it("shows the instance window in /api/health, also to anonymous callers", async () => {
      const health = () => {
        const server = express();
        server.use("/api/health", healthRoutes(db, {
          deploymentMode: "authenticated",
          deploymentExposure: "private",
          authReady: true,
          companyDeletionEnabled: false,
        }));
        return server;
      };
      expect((await request(health()).get("/api/health").expect(200)).body.maintenance).toBeUndefined();
      await service().enter({ scope: { type: "instance" }, reason: "deploy" }, ADMIN);
      expect((await request(health()).get("/api/health").expect(200)).body.maintenance).toEqual({
        active: true,
        instanceState: "on",
        windows: 1,
      });
    });

    it("rejects malformed bodies", async () => {
      const post = (body: unknown) => request(app(admin)).post("/api/myrmidon/maintenance").send(body as object);
      await post({ action: "enter", scope: { type: "instance" } }).expect(400);
      await post({ action: "enter", scope: { type: "company" }, reason: "x" }).expect(400);
      await post({ action: "enter", scope: { type: "instance", id: randomUUID() }, reason: "x" }).expect(400);
      await post({ ...enterBody, onTimeout: "explode" }).expect(400);
      await post({ ...enterBody, drainTimeoutSec: -1 }).expect(400);
      await post({ action: "enter", scope: { type: "agent", id: randomUUID() }, reason: "x" }).expect(404);
    });
  });
});
