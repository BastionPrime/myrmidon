import { afterEach, describe, expect, it, vi } from "vitest";
import { BOT_CONTAINERS_ENV } from "./agent-config.js";
import type { BotContainerDriver, BotContainerStatus } from "./driver.js";
import { startBotContainerReconciliation, type BotContainerAgent, type BotContainerRuntimeDeps } from "./index.js";

function agent(): BotContainerAgent {
  return {
    agentId: "agent-a",
    adapterType: "hermes_gateway",
    adapterConfig: { container: { enabled: true, image: "myrmidon-hermes:1.1.0", memoryMb: 512, cpus: 1, pidsLimit: 128 } },
  };
}

function fakeMaintenance() {
  return {
    enter: async () => ({ state: "on" as const, runningRuns: 0 }),
    status: async () => ({ state: "on" as const, runningRuns: 0 }),
    exit: async () => {},
  };
}

describe("startBotContainerReconciliation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("disabled by default: never calls listAgents and returns a no-op stop", async () => {
    const listAgents = vi.fn(async () => [agent()]);
    const stop = startBotContainerReconciliation(listAgents, {
      driver: {} as BotContainerDriver,
      compile: async () => ({ botKey: "agent-a", files: [], restartHash: "r", filesHash: "f" }),
      maintenance: fakeMaintenance(),
      network: "myrmidon-bots",
    });
    stop();
    expect(listAgents).not.toHaveBeenCalled();
  });

  it("never starts a second sweep while the previous one is still in flight, and resumes once it finishes", async () => {
    // Reproduces the race two independent reviewers flagged: a "restart"-class
    // reconcile (drain + restart health wait) can run well past `intervalMs`
    // (default 60s), and without a guard the next `setInterval` firing would start
    // an overlapping sweep over the same bot. Here `driver.status` for the FIRST
    // call hangs on `gate` — standing in for a slow in-flight reconcile — while
    // several interval ticks fire; without the fix, each of those would call
    // `listAgents`/`driver.status` again concurrently.
    vi.useFakeTimers();
    let releaseFirstCall!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirstCall = resolve;
    });
    let statusCalls = 0;
    const driver: BotContainerDriver = {
      async status(): Promise<BotContainerStatus> {
        statusCalls++;
        if (statusCalls === 1) await gate;
        return { botKey: "agent-a", state: "missing" };
      },
      async list() {
        return [];
      },
      async ensure() {},
      async writeProfile() {},
      async restart() {},
      async stop() {},
    };
    const listAgents = vi.fn(async () => [agent()]);
    const deps: BotContainerRuntimeDeps = {
      driver,
      compile: async () => ({ botKey: "agent-a", files: [], restartHash: "r", filesHash: "f" }),
      maintenance: fakeMaintenance(),
      network: "myrmidon-bots",
    };
    const stop = startBotContainerReconciliation(listAgents, deps, {
      intervalMs: 1_000,
      env: { [BOT_CONTAINERS_ENV]: "1" },
    });
    try {
      // Let the initial `void tick()` (fired synchronously by the call above) reach
      // and suspend on `gate` before advancing any interval.
      await vi.advanceTimersByTimeAsync(0);
      expect(statusCalls).toBe(1);

      // Five interval firings while the first sweep is still stuck: a second sweep
      // must NOT start.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(listAgents).toHaveBeenCalledTimes(1);
      expect(statusCalls).toBe(1);

      // Unblock the first sweep and let it finish.
      releaseFirstCall();
      await vi.advanceTimersByTimeAsync(0);

      // The next interval firing now starts a fresh sweep.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(listAgents.mock.calls.length).toBeGreaterThan(1);
      expect(statusCalls).toBeGreaterThan(1);
    } finally {
      stop();
    }
  });
});
