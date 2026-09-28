import { afterEach, describe, expect, it, vi } from "vitest";
import { BOT_CONTAINERS_ENV } from "./agent-config.js";
import type { BotContainerDriver, BotContainerStatus } from "./driver.js";
import { startBotContainerReconciliation, type BotContainerAgent, type BotContainerRuntimeDeps } from "./index.js";

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
    enter: async () => ({ state: "on" as const, runningRuns: 0 }),
    status: async () => ({ state: "on" as const, runningRuns: 0 }),
    exit: async () => {},
  };
}

/** A driver whose every non-status call is a fire-and-forget no-op, and whose
 *  `status`/`templateDrift` are supplied per test — enough for tests that only
 *  care which agents/botKeys get reconciled, not the reconcile's own mechanics
 *  (reconciler.myrmidon.test.ts covers those in depth). */
function minimalDriver(overrides: Partial<BotContainerDriver> = {}): BotContainerDriver {
  return {
    status: async () => ({ botKey: "unused", state: "running" }),
    list: async () => [],
    templateDrift: async () => false,
    ensure: async () => {},
    writeProfile: async () => {},
    restart: async () => {},
    stop: async () => {},
    ...overrides,
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
      async templateDrift() {
        return false;
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

  it("reconciles independent bots concurrently: a slow bot's reconcile does not block a fast bot's in the same sweep", async () => {
    // Reproduces the major-severity finding: the original sweep loop awaited each
    // agent fully before moving to the next, so one bot stuck draining (which can
    // legitimately take minutes) delayed every other bot behind it. Here
    // "agent-slow"'s `status` call hangs indefinitely on `slowGate`; "agent-fast"
    // must still be reconciled (proven by its own `writeProfile` call resolving)
    // without waiting for the slow one.
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let fastBotDone!: () => void;
    const fastBotDonePromise = new Promise<void>((resolve) => {
      fastBotDone = resolve;
    });
    const driver: BotContainerDriver = {
      async status(botKey) {
        if (botKey === "agent-slow") {
          await slowGate;
          return { botKey, state: "missing" };
        }
        return { botKey, state: "running", restartHash: "old", filesHash: "old" };
      },
      async list() {
        return [];
      },
      async templateDrift() {
        return false;
      },
      async ensure() {},
      async writeProfile(botKey) {
        if (botKey === "agent-fast") fastBotDone();
      },
      async restart() {},
      async stop() {},
    };
    const listAgents = vi.fn(async () => [agent({ agentId: "agent-slow" }), agent({ agentId: "agent-fast" })]);
    const deps: BotContainerRuntimeDeps = {
      driver,
      compile: async (_agentId, botKey) => ({ botKey, files: [], restartHash: "new", filesHash: "new" }),
      maintenance: fakeMaintenance(),
      network: "myrmidon-bots",
    };
    const stop = startBotContainerReconciliation(listAgents, deps, { env: { [BOT_CONTAINERS_ENV]: "1" } });
    try {
      await Promise.race([
        fastBotDonePromise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("agent-fast never reconciled — it was blocked behind agent-slow")), 2_000),
        ),
      ]);
    } finally {
      releaseSlow();
      stop();
    }
  });

  describe("shared container.group (containers-plan-senior-2026-09-28.md §1.2)", () => {
    it("reconciles the group's container exactly once per sweep, not once per member agent", async () => {
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
      ]);
      const deps: BotContainerRuntimeDeps = {
        driver,
        compile: async (_agentId, botKey) => ({ botKey, files: [], restartHash: "r", filesHash: "f" }),
        maintenance: fakeMaintenance(),
        network: "myrmidon-bots",
      };
      const stop = startBotContainerReconciliation(listAgents, deps, { env: { [BOT_CONTAINERS_ENV]: "1" } });
      try {
        await vi.waitFor(() => expect(statusCalls.length).toBeGreaterThan(0));
        // Give any (incorrect) second reconcile a chance to also fire before asserting.
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(statusCalls).toEqual(["team-b"]); // once, not twice
      } finally {
        stop();
      }
    });

    it("picks the same, lexicographically-first member deterministically — no oscillation across ticks", async () => {
      const specsSeen: number[] = [];
      const driver = minimalDriver({
        async status(botKey) {
          return { botKey, state: "running", restartHash: "r", filesHash: "f" };
        },
      });
      // "agent-a" sorts before "agent-b" regardless of listAgents' own order.
      const listAgents = vi.fn(async () => [
        agent({ agentId: "agent-b" }, { group: "team-b", memoryMb: 999 }),
        agent({ agentId: "agent-a" }, { group: "team-b", memoryMb: 512 }),
      ]);
      const deps: BotContainerRuntimeDeps = {
        driver,
        compile: async (agentId, botKey) => {
          specsSeen.push(agentId === "agent-a" ? 512 : 999);
          return { botKey, files: [], restartHash: "r", filesHash: "f" };
        },
        maintenance: fakeMaintenance(),
        network: "myrmidon-bots",
      };
      const stop = startBotContainerReconciliation(listAgents, deps, { env: { [BOT_CONTAINERS_ENV]: "1" } });
      try {
        await vi.waitFor(() => expect(specsSeen.length).toBeGreaterThan(0));
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(specsSeen).toEqual([512]); // agent-a's card, not agent-b's
      } finally {
        stop();
      }
    });

    it("flags (does not silently apply) a member whose config disagrees with the group's canonical member", async () => {
      const records: Array<{ level: string; message: string; agentId: string }> = [];
      const driver = minimalDriver({
        async status(botKey) {
          return { botKey, state: "running", restartHash: "r", filesHash: "f" };
        },
      });
      const listAgents = vi.fn(async () => [
        agent({ agentId: "agent-a" }, { group: "team-b", memoryMb: 512 }),
        agent({ agentId: "agent-b" }, { group: "team-b", memoryMb: 999 }), // disagrees
      ]);
      const deps: BotContainerRuntimeDeps = {
        driver,
        compile: async (_agentId, botKey) => ({ botKey, files: [], restartHash: "r", filesHash: "f" }),
        maintenance: fakeMaintenance(),
        network: "myrmidon-bots",
        activity: {
          record: (entry) => {
            records.push({ level: entry.level, message: entry.message, agentId: entry.agentId });
          },
        },
      };
      const stop = startBotContainerReconciliation(listAgents, deps, { env: { [BOT_CONTAINERS_ENV]: "1" } });
      try {
        await vi.waitFor(() =>
          expect(records.some((r) => r.message.includes("disagree on image/memoryMb/cpus/pidsLimit"))).toBe(true),
        );
        const mismatch = records.find((r) => r.message.includes("disagree on image/memoryMb/cpus/pidsLimit"));
        expect(mismatch?.level).toBe("error");
        expect(mismatch?.agentId).toBe("agent-b"); // the non-canonical member is named, not agent-a
      } finally {
        stop();
      }
    });
  });
});
