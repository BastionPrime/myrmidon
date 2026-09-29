import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { BOT_CONTAINERS_ENV } from "./agent-config.js";
import type { BotContainerDriver } from "./driver.js";
import type { DockerDriverConfig } from "./docker-driver.js";
import {
  DEFAULT_RECONCILE_INTERVAL_MS,
  type BotContainerAgent,
  type BotContainerRuntimeDeps,
  type startBotContainerReconciliation,
} from "./index.js";
import type { BotContainerActivitySink, BotMaintenancePort } from "./reconciler.js";
import {
  BOT_RECONCILE_INTERVAL_ENV,
  createBotContainerLogSink,
  readBotReconcileIntervalMs,
  startBotContainers,
  stopBotContainers,
  type BotContainersLog,
  type BotContainersStartupPorts,
} from "./startup.js";

const ENABLED = { [BOT_CONTAINERS_ENV]: "1" };
const DB = { marker: "db" } as unknown as Db;

const DRIVER_CONFIG: DockerDriverConfig = {
  socketPath: "/run/test-docker.sock",
  volumeRoot: "/var/lib/test-bots",
  network: "test-bots-net",
  allowlist: [],
};

function driver(): BotContainerDriver {
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
  };
}

type Ports = BotContainersStartupPorts;

function harness(
  opts: {
    readDriverConfig?: Ports["readDriverConfig"];
    startReconciliation?: typeof startBotContainerReconciliation;
  } = {},
) {
  let registered: BotContainerRuntimeDeps | null = null;
  const registrations: Array<BotContainerRuntimeDeps | null> = [];
  const stopSweep = vi.fn<() => void>();
  const theDriver = driver();
  const compile = vi.fn<BotContainerRuntimeDeps["compile"]>();
  const syncCard = vi.fn<NonNullable<BotContainerRuntimeDeps["syncCard"]>>();
  const maintenance: BotMaintenancePort = {
    enter: vi.fn<BotMaintenancePort["enter"]>(),
    status: vi.fn<BotMaintenancePort["status"]>(),
    exit: vi.fn<BotMaintenancePort["exit"]>(),
  };
  const sink = { record: vi.fn<BotContainerActivitySink["record"]>() };
  const agentsSweep = vi.fn<() => Promise<BotContainerAgent[]>>(async () => []);
  const spies = {
    readDriverConfig: vi.fn<Ports["readDriverConfig"]>(opts.readDriverConfig ?? (() => DRIVER_CONFIG)),
    createDriver: vi.fn<Ports["createDriver"]>(() => theDriver),
    profileWiring: vi.fn<Ports["profileWiring"]>(() => ({ compile, syncCard })),
    maintenancePort: vi.fn<Ports["maintenancePort"]>(() => maintenance),
    listAgents: vi.fn<Ports["listAgents"]>(() => agentsSweep),
    activitySink: vi.fn<Ports["activitySink"]>(() => sink),
    registerRuntime: vi.fn<Ports["registerRuntime"]>((runtime) => {
      registered = runtime;
      registrations.push(runtime);
    }),
    currentRuntime: vi.fn<Ports["currentRuntime"]>(() => registered),
    startReconciliation: vi.fn<typeof startBotContainerReconciliation>(opts.startReconciliation ?? (() => stopSweep)),
    log: {
      info: vi.fn<BotContainersLog["info"]>(),
      error: vi.fn<BotContainersLog["error"]>(),
    },
  };
  const ports: Ports = spies;
  return {
    ports,
    spies,
    stopSweep,
    theDriver,
    compile,
    syncCard,
    maintenance,
    sink,
    agentsSweep,
    registrations,
    registered: () => registered,
  };
}

describe("readBotReconcileIntervalMs", () => {
  it("defaults to the sweep's own default period", () => {
    expect(readBotReconcileIntervalMs({})).toBe(DEFAULT_RECONCILE_INTERVAL_MS);
    expect(DEFAULT_RECONCILE_INTERVAL_MS).toBe(60_000);
  });

  it("reads whole seconds within 5..3600", () => {
    expect(readBotReconcileIntervalMs({ [BOT_RECONCILE_INTERVAL_ENV]: "15" })).toBe(15_000);
    expect(readBotReconcileIntervalMs({ [BOT_RECONCILE_INTERVAL_ENV]: " 5 " })).toBe(5_000);
    expect(readBotReconcileIntervalMs({ [BOT_RECONCILE_INTERVAL_ENV]: "3600" })).toBe(3_600_000);
  });

  it.each(["", "abc", "0", "4", "3601", "1.5", "-10"])("falls back to the default for %j", (raw) => {
    expect(readBotReconcileIntervalMs({ [BOT_RECONCILE_INTERVAL_ENV]: raw })).toBe(DEFAULT_RECONCILE_INTERVAL_MS);
  });
});

describe("startBotContainers with the flag off", () => {
  it.each([{}, { [BOT_CONTAINERS_ENV]: "0" }, { [BOT_CONTAINERS_ENV]: "off" }])(
    "creates nothing and polls no agents (%j)",
    (env) => {
      const h = harness();
      const stop = startBotContainers(DB, { env, ports: h.ports });

      expect(h.spies.readDriverConfig).not.toHaveBeenCalled();
      expect(h.spies.createDriver).not.toHaveBeenCalled();
      expect(h.spies.profileWiring).not.toHaveBeenCalled();
      expect(h.spies.maintenancePort).not.toHaveBeenCalled();
      expect(h.spies.listAgents).not.toHaveBeenCalled();
      expect(h.spies.activitySink).not.toHaveBeenCalled();
      expect(h.spies.startReconciliation).not.toHaveBeenCalled();
      expect(h.spies.registerRuntime).not.toHaveBeenCalled();
      expect(h.agentsSweep).not.toHaveBeenCalled();
      expect(h.spies.log.info).not.toHaveBeenCalled();
      expect(h.spies.log.error).not.toHaveBeenCalled();
      expect(() => stop()).not.toThrow();
      expect(() => stopBotContainers()).not.toThrow();
    },
  );
});

describe("startBotContainers with the flag on", () => {
  it("builds the runtime and starts the sweep with the agents query", () => {
    const h = harness();
    startBotContainers(DB, { env: ENABLED, ports: h.ports });
    try {
      // Read the G3 settings from the same env, then build the driver over them.
      expect(h.spies.readDriverConfig).toHaveBeenCalledWith(ENABLED);
      expect(h.spies.createDriver).toHaveBeenCalledWith(DRIVER_CONFIG);
      expect(h.spies.profileWiring).toHaveBeenCalledWith(DB, { activity: h.sink, env: ENABLED });
      expect(h.spies.maintenancePort).toHaveBeenCalledWith(DB);
      expect(h.spies.listAgents).toHaveBeenCalledWith(DB);

      expect(h.spies.startReconciliation).toHaveBeenCalledTimes(1);
      const [listAgents, runtime, opts] = h.spies.startReconciliation.mock.calls[0];
      expect(listAgents).toBe(h.agentsSweep);
      expect(runtime).toEqual({
        driver: h.theDriver,
        compile: h.compile,
        syncCard: h.syncCard,
        maintenance: h.maintenance,
        activity: h.sink,
        network: DRIVER_CONFIG.network,
      });
      expect(opts).toEqual({ intervalMs: 60_000, env: ENABLED });
    } finally {
      stopBotContainers();
    }
  });

  it("uses the configured period", () => {
    const h = harness();
    const env = { ...ENABLED, [BOT_RECONCILE_INTERVAL_ENV]: "30" };
    startBotContainers(DB, { env, ports: h.ports });
    try {
      const [, , opts] = h.spies.startReconciliation.mock.calls[0];
      expect(opts?.intervalMs).toBe(30_000);
    } finally {
      stopBotContainers();
    }
  });

  it("registers the very runtime the sweep uses for the card's Apply now", () => {
    const h = harness();
    startBotContainers(DB, { env: ENABLED, ports: h.ports });
    try {
      const [, runtime] = h.spies.startReconciliation.mock.calls[0];
      expect(h.registrations).toEqual([runtime]);
      expect(h.registered()).toBe(runtime);
    } finally {
      stopBotContainers();
    }
  });

  it("hands the sweep a listAgents that asks the agents query, not a fixed list", async () => {
    const agent: BotContainerAgent = {
      agentId: "agent-a",
      adapterType: "hermes_gateway",
      adapterConfig: { container: { enabled: true } },
    };
    const h = harness();
    h.agentsSweep.mockResolvedValueOnce([agent]);
    startBotContainers(DB, { env: ENABLED, ports: h.ports });
    try {
      const [listAgents] = h.spies.startReconciliation.mock.calls[0];
      await expect(listAgents()).resolves.toEqual([agent]);
      expect(h.agentsSweep).toHaveBeenCalledTimes(1);
    } finally {
      stopBotContainers();
    }
  });

  it("logs that the sweep started", () => {
    const h = harness();
    startBotContainers(DB, { env: ENABLED, ports: h.ports });
    try {
      expect(h.spies.log.info).toHaveBeenCalledTimes(1);
      expect(h.spies.log.error).not.toHaveBeenCalled();
    } finally {
      stopBotContainers();
    }
  });
});

describe("startBotContainers stop", () => {
  it("the returned stop halts the sweep and clears the registered runtime, once", () => {
    const h = harness();
    const stop = startBotContainers(DB, { env: ENABLED, ports: h.ports });
    expect(h.stopSweep).not.toHaveBeenCalled();
    stop();
    stop();
    expect(h.stopSweep).toHaveBeenCalledTimes(1);
    expect(h.registered()).toBeNull();
    expect(h.registrations.at(-1)).toBeNull();
  });

  it("stopBotContainers (the shutdown call) does the same", () => {
    const h = harness();
    startBotContainers(DB, { env: ENABLED, ports: h.ports });
    stopBotContainers();
    stopBotContainers();
    expect(h.stopSweep).toHaveBeenCalledTimes(1);
    expect(h.registered()).toBeNull();
  });

  it("leaves a runtime registered by somebody else alone", () => {
    const h = harness();
    const stop = startBotContainers(DB, { env: ENABLED, ports: h.ports });
    const other = { network: "other" } as unknown as BotContainerRuntimeDeps;
    h.ports.registerRuntime(other);
    stop();
    expect(h.stopSweep).toHaveBeenCalledTimes(1);
    expect(h.registered()).toBe(other);
  });

  it("a repeated start replaces the previous run", () => {
    const first = harness();
    const second = harness();
    startBotContainers(DB, { env: ENABLED, ports: first.ports });
    startBotContainers(DB, { env: ENABLED, ports: second.ports });
    try {
      expect(first.stopSweep).toHaveBeenCalledTimes(1);
      expect(second.stopSweep).not.toHaveBeenCalled();
    } finally {
      stopBotContainers();
    }
    expect(second.stopSweep).toHaveBeenCalledTimes(1);
  });

  it("stopBotContainers with nothing running does nothing", () => {
    expect(() => stopBotContainers()).not.toThrow();
  });
});

describe("startBotContainers when the runtime cannot be built", () => {
  it("logs the error, starts and registers nothing, and does not throw", () => {
    const h = harness({
      readDriverConfig: vi.fn(() => {
        throw new Error("MYRMIDON_BOT_VOLUME_ROOT must be set to use the bot container driver");
      }),
    });
    let stop: (() => void) | undefined;
    expect(() => {
      stop = startBotContainers(DB, { env: ENABLED, ports: h.ports });
    }).not.toThrow();
    expect(h.spies.log.error).toHaveBeenCalledTimes(1);
    expect(h.spies.startReconciliation).not.toHaveBeenCalled();
    expect(h.spies.registerRuntime).not.toHaveBeenCalled();
    expect(() => stop?.()).not.toThrow();
    expect(() => stopBotContainers()).not.toThrow();
  });

  it("does not register a runtime when starting the sweep fails", () => {
    const h = harness({
      startReconciliation: vi.fn(() => {
        throw new Error("boom");
      }),
    });
    expect(() => startBotContainers(DB, { env: ENABLED, ports: h.ports })).not.toThrow();
    expect(h.spies.log.error).toHaveBeenCalledTimes(1);
    expect(h.spies.registerRuntime).not.toHaveBeenCalled();
  });
});

describe("createBotContainerLogSink", () => {
  it("writes an error entry at error level and anything else at info, with the ids", () => {
    const log = { info: vi.fn(), error: vi.fn() };
    const sink = createBotContainerLogSink(log);
    sink.record({ level: "error", agentId: "a1", botKey: "b1", message: "reconcile failed", details: { error: "x" } });
    sink.record({ level: "info", agentId: "a2", botKey: "b2", message: "created" });

    expect(log.error).toHaveBeenCalledWith(
      { agentId: "a1", botKey: "b1", details: { error: "x" } },
      "bot containers: reconcile failed",
    );
    expect(log.info).toHaveBeenCalledWith({ agentId: "a2", botKey: "b2" }, "bot containers: created");
  });
});
