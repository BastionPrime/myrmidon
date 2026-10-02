// myrmidon(LEAVE-ALWAYS, OPE-3638): `leaving` windows always retire.
//
// The defect: `finishLeaving` awaited `runHook(window, "onExited")` before the
// retire write. A hook that HANGS pinned the window (the 16:10 UTC operator
// report: 38 windows in `leaving`, `enter` answered 409 "still leaving"), and
// one stuck window also starved the sequential tick loop for every window
// behind it, so the deploy drain's interrupt never fired.
//
// The guard cases below pin the fixed behavior. On the previous revision:
// - the hanging-hook case never resolves within the test timeout (the window
//   stays `leaving` forever);
// - the throwing-hook case rejects the tick and the window stays `leaving`;
// - the interleaving case lets the first `leaving` window block the second's
//   retire, because `tick()` awaits windows sequentially.
// Each expectation fails there.

import { randomUUID } from "node:crypto";
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
import { heartbeatService } from "../../services/heartbeat.js";
import { withHookTimeout } from "./hook-timeout.js";
import { resetMaintenanceGateCaches } from "./gate.js";
import { maintenanceService, type MaintenanceHooks } from "./service.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const ADMIN = { actorType: "user", actorId: "admin-user" };

/** A hook call that is still pending; resolvable by the test. */
function hangingHook() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve, hook: () => promise };
}

function service(deps: {
  hooks?: Partial<MaintenanceHooks>;
  hookTimeoutMs?: number;
  heartbeat?: unknown;
}) {
  return maintenanceService(db, {
    heartbeat: (deps.heartbeat as never) ?? stubHeartbeat(),
    hooks: deps.hooks,
    hookTimeoutMs: deps.hookTimeoutMs,
  });
}

/** No-op heartbeat port: the leave tail is exercised without the vendor run machinery. */
function stubHeartbeat() {
  return { resumeQueuedRuns: async () => {} };
}

let db!: ReturnType<typeof createDb>;
let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

describe("withHookTimeout: a bounded await for integration hooks", () => {
  it("returns the hook result when it settles in time", async () => {
    const result = await withHookTimeout(async () => "ok", 1_000);
    expect(result).toBe("ok");
  });

  it("abandons a hung hook after the timeout and resolves undefined", async () => {
    let timeouts = 0;
    const hung = hangingHook();
    const startedAt = Date.now();
    const result = await withHookTimeout(() => hung.promise, 50, () => {
      timeouts += 1;
    });
    expect(result).toBeUndefined();
    expect(timeouts).toBe(1);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(45);
    // The hook promise is still pending; the await must not have depended on it.
    hung.resolve();
  });
});

describeEmbeddedPostgres("maintenance leave-always: hooks never pin a `leaving` window", () => {
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-maintenance-leave-always-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
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

  async function seedAgent(scopeSuffix: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `company-${scopeSuffix}`,
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `agent-${scopeSuffix}`,
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true } },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function maintenanceActions(companyId: string) {
    const rows = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), like(activityLog.action, "myrmidon.maintenance.%")));
    return rows.map((r) => r.action);
  }

  it("retires the window when onExited hangs (hook timeout), then admits a fresh window", async () => {
    const { agentId, companyId } = await seedAgent("hang");
    const hung = hangingHook();
    const svc = service({
      hooks: { onExited: hung.hook },
      hookTimeoutMs: 100,
    });
    await svc.enter({ scope: { type: "agent", id: agentId }, reason: "profile update" }, ADMIN);
    const exited = await svc.exit({ type: "agent", id: agentId }, ADMIN);
    expect(exited).toMatchObject({ state: "leaving", changed: true });

    // The guard: one tick retires the window although the hook never settled.
    await svc.tick();
    expect((await svc.status()).active).toBe(false);
    expect(await maintenanceActions(companyId)).toContain("myrmidon.maintenance.exited");

    // A hung window does not 409 the next update either: the scope is free.
    const reentered = await service({ hooks: { onExited: hung.hook }, hookTimeoutMs: 100 }).enter(
      { scope: { type: "agent", id: agentId }, reason: "profile update 2" },
      ADMIN,
    );
    expect(reentered).toMatchObject({ changed: true, state: "on" });
    hung.resolve();
  }, 30_000);

  it("retires the window when onExited throws, and logs the failure", async () => {
    const { agentId, companyId } = await seedAgent("throw");
    const svc = service({
      hooks: { onExited: () => Promise.reject(new Error("zabbix exploded")) },
      hookTimeoutMs: 10_000,
    });
    await svc.enter({ scope: { type: "agent", id: agentId }, reason: "profile update" }, ADMIN);
    await svc.exit({ type: "agent", id: agentId }, ADMIN);

    // The guard: the tick resolves and the window is retired.
    await svc.tick();
    expect((await svc.status()).active).toBe(false);

    const actions = await maintenanceActions(companyId);
    expect(actions).toContain("myrmidon.maintenance.exited");
    expect(actions).toContain("myrmidon.maintenance.zabbix_failed");
  }, 30_000);

  it("processes windows independently: a hung first window does not hold back the others", async () => {
    const first = await seedAgent("first");
    const second = await seedAgent("second");
    const hung = hangingHook();
    const svc = service({
      hooks: {
        // Hangs only for the first agent's scope; the second retires at once.
        onExited: (window) => {
          if (window.scope.id === first.agentId) return hung.promise;
          return Promise.resolve();
        },
      },
      hookTimeoutMs: 60_000, // long: only the interleaving is under test here
    });
    await svc.enter({ scope: { type: "agent", id: first.agentId }, reason: "one" }, ADMIN);
    await svc.enter({ scope: { type: "agent", id: second.agentId }, reason: "two" }, ADMIN);
    await svc.exit({ type: "agent", id: first.agentId }, ADMIN);
    await svc.exit({ type: "agent", id: second.agentId }, ADMIN);

    // The guard: one tick retires the second window even though the first
    // window's hook is still pending (the sequential loop retired none).
    await svc.tick();
    const status = await svc.status();
    expect(status.windows.map((w) => w.scope.id)).toEqual([first.agentId]);
    expect(status.windows.map((w) => w.state)).toEqual(["leaving"]);
    hung.resolve();
  }, 30_000);

  it("still retires when onEntered throws at enter time (the mode enters regardless)", async () => {
    const { agentId } = await seedAgent("enter-throw");
    const svc = service({
      hooks: { onEntered: () => Promise.reject(new Error("zabbix down")) },
      hookTimeoutMs: 10_000,
    });
    const entered = await svc.enter({ scope: { type: "agent", id: agentId }, reason: "deploy" }, ADMIN);
    expect(entered).toMatchObject({ changed: true, state: "on" });
    await svc.exit({ type: "agent", id: agentId }, ADMIN);
    await svc.tick();
    expect((await svc.status()).active).toBe(false);
  }, 30_000);

  it("respects MYRMIDON_MAINTENANCE_HOOK_TIMEOUT_MS: a lower bound is honored via the dep", async () => {
    const { agentId } = await seedAgent("fast-timeout");
    const hung = hangingHook();
    const svc = service({ hooks: { onExited: hung.hook }, hookTimeoutMs: 60 });
    await svc.enter({ scope: { type: "agent", id: agentId }, reason: "deploy" }, ADMIN);
    await svc.exit({ type: "agent", id: agentId }, ADMIN);
    const startedAt = Date.now();
    await svc.tick();
    const elapsed = Date.now() - startedAt;
    expect((await svc.status()).active).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(55);
    expect(elapsed).toBeLessThan(5_000);
    hung.resolve();
  }, 30_000);
});
