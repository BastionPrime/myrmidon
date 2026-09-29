import { afterEach, describe, expect, it, vi } from "vitest";
import { BOT_CONTAINERS_ENV, CONTAINER_GROUP_UNSUPPORTED_REASON } from "./agent-config.js";
import { createBotKeyLock } from "./bot-key-lock.js";
import type { BotContainerDriver, BotContainerStatus } from "./driver.js";
import {
  BOT_CONTAINER_ACTOR,
  applyBotContainerNow,
  botMaintenancePortFromService,
  startBotContainerReconciliation,
  type BotContainerAgent,
  type BotContainerRuntimeDeps,
  type BotMaintenanceServiceSlice,
} from "./index.js";

const ENABLED = { [BOT_CONTAINERS_ENV]: "1" };

function agent(overrides: Partial<BotContainerAgent> = {}, containerOverrides: Record<string, unknown> = {}): BotContainerAgent {
  return {
    agentId: "agent-a",
    adapterType: "hermes_gateway",
    adapterConfig: {
      container: {
        enabled: true,
        image: "myrmidon-hermes:1.1.0",
        memoryMb: 512,
        cpus: 1,
        pidsLimit: 128,
        ...containerOverrides,
      },
    },
    ...overrides,
  };
}

function fakeMaintenance() {
  return {
    enter: async () => ({ state: "on" as const, runningRuns: 0, owned: true }),
    status: async () => ({ state: "on" as const, runningRuns: 0 }),
    exit: async () => {},
  };
}

/** A driver whose every call is a no-op unless overridden per test — enough for
 *  tests that only care which bots get reconciled and when, not the reconcile's
 *  own mechanics (reconciler.myrmidon.test.ts covers those in depth). */
function minimalDriver(overrides: Partial<BotContainerDriver> = {}): BotContainerDriver {
  return {
    status: async (botKey) => ({ botKey, state: "running", restartHash: "r", filesHash: "f" }),
    list: async () => [],
    templateDrift: async () => false,
    create: async () => {},
    recreate: async () => {},
    writeProfile: async () => {},
    start: async () => {},
    restart: async () => {},
    stop: async () => {},
    ...overrides,
  };
}

function deps(driver: BotContainerDriver, extra: Partial<BotContainerRuntimeDeps> = {}): BotContainerRuntimeDeps {
  return {
    driver,
    compile: async (_agentId, botKey) => ({ botKey, files: [], restartHash: "r", filesHash: "f" }),
    maintenance: fakeMaintenance(),
    network: "myrmidon-bots",
    lock: createBotKeyLock(),
    ...extra,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const flush = async (times = 5) => {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("applyBotContainerNow", () => {
  it("is not applicable, and touches nothing, while MYRMIDON_BOT_CONTAINERS is off", async () => {
    const driver = minimalDriver({
      status: async () => {
        throw new Error("the driver must not be called while the feature is off");
      },
    });
    const compile = vi.fn(async () => ({ botKey: "agent-a", files: [], restartHash: "r", filesHash: "f" }));
    for (const env of [{}, { [BOT_CONTAINERS_ENV]: "0" }]) {
      const outcome = await applyBotContainerNow(agent(), deps(driver, { compile }), { env });
      expect(outcome).toEqual({ kind: "not_applicable", reason: `${BOT_CONTAINERS_ENV} is not enabled` });
    }
    expect(compile).not.toHaveBeenCalled();
  });

  it("reconciles when the flag is on", async () => {
    const outcome = await applyBotContainerNow(agent(), deps(minimalDriver()), { env: ENABLED });
    expect(outcome).toEqual({ kind: "unchanged" });
  });

  it("refuses a shared container.group card as not applicable", async () => {
    const statusCalls: string[] = [];
    const driver = minimalDriver({
      status: async (botKey) => {
        statusCalls.push(botKey);
        return { botKey, state: "running" };
      },
    });
    const outcome = await applyBotContainerNow(agent({}, { group: "team-b" }), deps(driver), { env: ENABLED });
    expect(outcome).toEqual({ kind: "not_applicable", reason: CONTAINER_GROUP_UNSUPPORTED_REASON });
    expect(statusCalls).toEqual([]);
  });

  it("never overlaps with a sweep's reconcile of the same bot: it waits for it to finish", async () => {
    // Without a shared per-bot lock, "apply now" during a slow sweep reconcile of
    // the same bot would run a second writeProfile/restart concurrently (same
    // helper container, same marker) and could exit the other's maintenance window.
    const events: string[] = [];
    const gate = deferred();
    let statusCalls = 0;
    const driver = minimalDriver({
      async status(botKey): Promise<BotContainerStatus> {
        statusCalls++;
        events.push(`status#${statusCalls}`);
        if (statusCalls === 1) await gate.promise;
        return { botKey, state: "running", restartHash: "r", filesHash: "f" };
      },
      async templateDrift() {
        events.push("drift");
        return false;
      },
    });
    const shared = deps(driver);
    const stop = startBotContainerReconciliation(async () => [agent()], shared, { env: ENABLED });
    try {
      await flush();
      expect(events).toEqual(["status#1"]); // the sweep's reconcile is in flight
      const applied = applyBotContainerNow(agent(), shared, { env: ENABLED });
      await flush();
      expect(events).toEqual(["status#1"]); // "apply now" is queued, not running
      gate.resolve();
      expect(await applied).toEqual({ kind: "unchanged" });
      expect(events).toEqual(["status#1", "drift", "status#2", "drift"]);
    } finally {
      stop();
    }
  });
});

describe("botMaintenancePortFromService", () => {
  function fakeService(enterResult: { changed: boolean; startedBy: { actorType: string; actorId: string } | null }) {
    const exits: unknown[] = [];
    const service: BotMaintenanceServiceSlice = {
      enter: async () => ({ state: "on", runningRuns: 0, ...enterResult }),
      status: async () => ({ windows: [] }),
      exit: async (scope, actor, reason) => {
        exits.push({ scope, actor, reason });
      },
    };
    return { service, exits };
  }

  it("owns a window its own enter() opened", async () => {
    const { service } = fakeService({ changed: true, startedBy: BOT_CONTAINER_ACTOR });
    expect((await botMaintenancePortFromService(service).enter("agent-a", "r", 60)).owned).toBe(true);
  });

  it("does not own a window that was already open and opened by someone else (changed: false)", async () => {
    const { service } = fakeService({ changed: false, startedBy: { actorType: "user", actorId: "operator-a" } });
    expect((await botMaintenancePortFromService(service).enter("agent-a", "r", 60)).owned).toBe(false);
  });

  it("does not own an already-open window with no recorded starter", async () => {
    const { service } = fakeService({ changed: false, startedBy: null });
    expect((await botMaintenancePortFromService(service).enter("agent-a", "r", 60)).owned).toBe(false);
  });

  it("adopts a window its own actor opened on an earlier, interrupted pass, so it can be closed", async () => {
    const { service } = fakeService({ changed: false, startedBy: { ...BOT_CONTAINER_ACTOR } });
    expect((await botMaintenancePortFromService(service).enter("agent-a", "r", 60)).owned).toBe(true);
  });

  it("reports 'off' with no running work when the agent has no window", async () => {
    const { service } = fakeService({ changed: true, startedBy: BOT_CONTAINER_ACTOR });
    expect(await botMaintenancePortFromService(service).status("agent-a")).toEqual({ state: "off", runningRuns: 0 });
  });
});

describe("startBotContainerReconciliation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("disabled by default: never calls listAgents and returns a no-op stop", async () => {
    const listAgents = vi.fn(async () => [agent()]);
    const stop = startBotContainerReconciliation(listAgents, deps({} as BotContainerDriver));
    stop();
    expect(listAgents).not.toHaveBeenCalled();
  });

  it("never starts a second sweep while the previous one is still in flight, and resumes once it finishes", async () => {
    vi.useFakeTimers();
    const gate = deferred();
    let statusCalls = 0;
    const driver = minimalDriver({
      async status(botKey): Promise<BotContainerStatus> {
        statusCalls++;
        if (statusCalls === 1) await gate.promise;
        return { botKey, state: "running", restartHash: "r", filesHash: "f" };
      },
    });
    const listAgents = vi.fn(async () => [agent()]);
    const stop = startBotContainerReconciliation(listAgents, deps(driver), { intervalMs: 1_000, env: ENABLED });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(statusCalls).toBe(1);

      // Five interval firings while the first sweep is still stuck: no second sweep.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(listAgents).toHaveBeenCalledTimes(1);
      expect(statusCalls).toBe(1);

      gate.resolve();
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(listAgents.mock.calls.length).toBeGreaterThan(1);
      expect(statusCalls).toBeGreaterThan(1);
    } finally {
      stop();
    }
  });

  it("reconciles independent bots concurrently: a slow bot's reconcile does not block a fast bot's in the same sweep", async () => {
    const slowGate = deferred();
    const fastBotDone = deferred();
    const driver = minimalDriver({
      async status(botKey) {
        if (botKey === "agent-slow") {
          await slowGate.promise;
          return { botKey, state: "missing" };
        }
        return { botKey, state: "running", restartHash: "old", filesHash: "old" };
      },
      async writeProfile(botKey) {
        if (botKey === "agent-fast") fastBotDone.resolve();
      },
    });
    const listAgents = vi.fn(async () => [agent({ agentId: "agent-slow" }), agent({ agentId: "agent-fast" })]);
    const stop = startBotContainerReconciliation(
      listAgents,
      deps(driver, { compile: async (_agentId, botKey) => ({ botKey, files: [], restartHash: "new", filesHash: "new" }) }),
      { env: ENABLED },
    );
    try {
      await Promise.race([
        fastBotDone.promise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("agent-fast never reconciled — it was blocked behind agent-slow")), 2_000),
        ),
      ]);
    } finally {
      slowGate.resolve();
      stop();
    }
  });

  it("skips agents asking for a shared container.group instead of reconciling the shared container per member", async () => {
    const statusCalls: string[] = [];
    const driver = minimalDriver({
      async status(botKey) {
        statusCalls.push(botKey);
        return { botKey, state: "running", restartHash: "r", filesHash: "f" };
      },
    });
    const listAgents = vi.fn(async () => [
      agent({ agentId: "agent-b" }, { group: "team-b" }),
      agent({ agentId: "agent-a" }, { group: "team-b" }),
      agent({ agentId: "agent-c" }),
    ]);
    const stop = startBotContainerReconciliation(listAgents, deps(driver), { env: ENABLED });
    try {
      await vi.waitFor(() => expect(statusCalls.length).toBeGreaterThan(0));
      await flush();
      expect(statusCalls).toEqual(["agent-c"]); // only the ungrouped bot, keyed by its own agent id
    } finally {
      stop();
    }
  });
});

describe("applyBotContainerNow: syncCard hook (W2a)", () => {
  function activitySink() {
    const entries: Array<{ level: string; message: string; details?: Record<string, unknown> }> = [];
    return { entries, record: (entry: { level: string; message: string; details?: Record<string, unknown> }) => void entries.push(entry) };
  }

  it("does not call syncCard while the flag is off", async () => {
    const syncCard = vi.fn(async () => ({ changedKeys: ["apiBaseUrl"] }));
    const outcome = await applyBotContainerNow(agent(), deps(minimalDriver(), { syncCard }), { env: {} });
    expect(outcome.kind).toBe("not_applicable");
    expect(syncCard).not.toHaveBeenCalled();
  });

  it("does not call syncCard for a card that is not in container mode", async () => {
    const syncCard = vi.fn(async () => ({ changedKeys: [] as string[] }));
    const outcome = await applyBotContainerNow(agent({ adapterConfig: {} }), deps(minimalDriver(), { syncCard }), { env: ENABLED });
    expect(outcome.kind).toBe("not_applicable");
    expect(syncCard).not.toHaveBeenCalled();
  });

  it("calls syncCard with the agent id and bot key after a pass that left the container applied, and logs a change", async () => {
    const cases: Array<[string, BotContainerDriver, string]> = [
      ["unchanged", minimalDriver(), "unchanged"],
      [
        "created",
        minimalDriver({ status: async (botKey) => ({ botKey, state: "missing" }) }),
        "created",
      ],
      [
        "applied_files",
        minimalDriver({ status: async (botKey) => ({ botKey, state: "running", restartHash: "r", filesHash: "old" }) }),
        "applied_files",
      ],
    ];
    for (const [label, driver, kind] of cases) {
      const syncCard = vi.fn(async () => ({ changedKeys: ["apiBaseUrl", "apiKey"] }));
      const sink = activitySink();
      const outcome = await applyBotContainerNow(agent(), deps(driver, { syncCard, activity: sink }), { env: ENABLED });
      expect(outcome.kind, label).toBe(kind);
      expect(syncCard, label).toHaveBeenCalledTimes(1);
      expect(syncCard, label).toHaveBeenCalledWith("agent-a", "agent-a");
      const synced = sink.entries.filter((entry) => entry.message === "agent card pointed at the bot container");
      expect(synced, label).toHaveLength(1);
      expect(synced[0]?.details).toEqual({ changedKeys: ["apiBaseUrl", "apiKey"] });
    }
  });

  it("stays quiet when the card already matches", async () => {
    const sink = activitySink();
    const syncCard = vi.fn(async () => ({ changedKeys: [] as string[] }));
    await applyBotContainerNow(agent(), deps(minimalDriver(), { syncCard, activity: sink }), { env: ENABLED });
    expect(syncCard).toHaveBeenCalledTimes(1);
    expect(sink.entries).toEqual([]);
  });

  it("skips syncCard when the reconcile failed", async () => {
    const syncCard = vi.fn(async () => ({ changedKeys: ["apiBaseUrl"] }));
    const outcome = await applyBotContainerNow(
      agent(),
      deps(minimalDriver(), {
        syncCard,
        compile: async () => {
          throw new Error("no hindsight bank");
        },
      }),
      { env: ENABLED },
    );
    expect(outcome).toEqual({ kind: "error", message: "no hindsight bank" });
    expect(syncCard).not.toHaveBeenCalled();
  });

  it("skips syncCard when the update is deferred to a later pass", async () => {
    const syncCard = vi.fn(async () => ({ changedKeys: ["apiBaseUrl"] }));
    const driver = minimalDriver({
      status: async (botKey) => ({ botKey, state: "running", restartHash: "old", filesHash: "f" }),
    });
    const foreignWindow = { ...fakeMaintenance(), enter: async () => ({ state: "on" as const, runningRuns: 0, owned: false }) };
    const outcome = await applyBotContainerNow(agent(), deps(driver, { syncCard, maintenance: foreignWindow }), { env: ENABLED });
    expect(outcome.kind).toBe("deferred");
    expect(syncCard).not.toHaveBeenCalled();
  });

  it("records a failing syncCard as an error but keeps the reconcile outcome", async () => {
    const sink = activitySink();
    const syncCard = vi.fn(async () => {
      throw new Error("database is down");
    });
    const outcome = await applyBotContainerNow(agent(), deps(minimalDriver(), { syncCard, activity: sink }), { env: ENABLED });
    expect(outcome).toEqual({ kind: "unchanged" });
    expect(sink.entries).toEqual([
      {
        level: "error",
        agentId: "agent-a",
        botKey: "agent-a",
        message: "failed to point the agent card at the bot container",
        details: { error: "database is down" },
      },
    ]);
  });

  it("runs inside the per-bot lock: a second apply for the same bot waits for the sync", async () => {
    const gate = deferred();
    const events: string[] = [];
    const syncCard = vi.fn(async () => {
      events.push("sync:start");
      await gate.promise;
      events.push("sync:end");
      return { changedKeys: [] as string[] };
    });
    const driver = minimalDriver({
      status: async (botKey) => {
        events.push("status");
        return { botKey, state: "running", restartHash: "r", filesHash: "f" };
      },
    });
    const shared = deps(driver, { syncCard });
    const first = applyBotContainerNow(agent(), shared, { env: ENABLED });
    await flush();
    const second = applyBotContainerNow(agent(), shared, { env: ENABLED });
    await flush();
    expect(events).toEqual(["status", "sync:start"]);
    gate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(["status", "sync:start", "sync:end", "status", "sync:start", "sync:end"]);
  });
});
