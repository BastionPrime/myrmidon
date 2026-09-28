import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MAINTENANCE_DRAIN_TIMEOUT_SEC, reconcileBot, type BotMaintenancePort, type MaintenanceWindowView } from "./reconciler.js";
import type { BotContainerDriver, BotContainerSpec, BotContainerStatus } from "./driver.js";
import type { CompiledProfile } from "./types.js";

const SPEC: BotContainerSpec = {
  botKey: "agent-a",
  image: "myrmidon-hermes:1.1.0",
  memoryMb: 1536,
  cpus: 1,
  pidsLimit: 256,
  network: "myrmidon-bots",
};

function profile(overrides: Partial<CompiledProfile> = {}): CompiledProfile {
  return {
    botKey: "agent-a",
    files: [{ path: "hermes/config.yaml", content: "a: 1\n", mode: 0o644, secret: false }],
    restartHash: "restart-1",
    filesHash: "files-1",
    ...overrides,
  };
}

interface FakeDriver extends BotContainerDriver {
  calls: string[];
}

function fakeDriver(initial: BotContainerStatus, opts: { failRestart?: boolean; failWriteProfile?: boolean } = {}): FakeDriver {
  const calls: string[] = [];
  let current = initial;
  return {
    calls,
    async status() {
      calls.push("status");
      return current;
    },
    async list() {
      return [current];
    },
    async ensure(_spec, compiled) {
      calls.push("ensure");
      if (current.state === "missing") {
        // Mirrors the real docker-driver: a fresh create has no applied-marker yet.
        current = { botKey: compiled.botKey, state: "running", restartHash: undefined, filesHash: undefined };
      } else if (current.state === "stopped") {
        // Mirrors ensure()'s "not drifted, not running -> start" branch: profile
        // hashes are untouched, since they live on the host-mounted volume, not on
        // the container itself.
        current = { ...current, state: "running" };
      }
      // "unhealthy": the real driver's Docker-level state is already "running", so
      // ensure() does not touch it — matches leaving `current` alone here too.
    },
    async writeProfile(_botKey, compiled) {
      calls.push("writeProfile");
      if (opts.failWriteProfile) throw new Error("write failed");
      current = { ...current, restartHash: compiled.restartHash, filesHash: compiled.filesHash };
    },
    async restart() {
      calls.push("restart");
      if (opts.failRestart) throw new Error("restart never became healthy");
      current = { ...current, state: "running" };
    },
    async stop() {
      calls.push("stop");
      current = { ...current, state: "stopped" };
    },
  };
}

interface FakeMaintenance extends BotMaintenancePort {
  enterCalls: number;
  exitCalls: string[];
}

/** `runningSequence` is consumed one value per enter()/status() call; the last
 *  value repeats once the sequence is exhausted. */
function fakeMaintenance(runningSequence: number[]): FakeMaintenance {
  let index = 0;
  let enterCalls = 0;
  const exitCalls: string[] = [];
  function nextRunning(): number {
    const value = runningSequence[Math.min(index, runningSequence.length - 1)];
    index++;
    return value;
  }
  return {
    get enterCalls() {
      return enterCalls;
    },
    exitCalls,
    async enter(): Promise<MaintenanceWindowView> {
      enterCalls++;
      const running = nextRunning();
      return { state: running === 0 ? "on" : "entering", runningRuns: running };
    },
    async status(): Promise<MaintenanceWindowView> {
      const running = nextRunning();
      return { state: running === 0 ? "on" : "entering", runningRuns: running };
    },
    async exit(agentId, reason): Promise<void> {
      exitCalls.push(`${agentId}:${reason}`);
    },
  };
}

function fakeActivity() {
  const records: Array<{ level: string; message: string }> = [];
  return {
    records,
    record: vi.fn((entry: { level: "info" | "error"; message: string }) => {
      records.push({ level: entry.level, message: entry.message });
    }),
  };
}

describe("reconcileBot", () => {
  it("missing: creates, writes the profile, then restarts — in that order", async () => {
    const driver = fakeDriver({ botKey: "agent-a", state: "missing" });
    const maintenance = fakeMaintenance([0]);
    const activity = fakeActivity();
    const outcome = await reconcileBot({
      agentId: "agent-a",
      botKey: "agent-a",
      spec: SPEC,
      compile: async () => profile(),
      driver,
      maintenance,
      activity,
    });
    expect(outcome).toEqual({ kind: "created" });
    expect(driver.calls).toEqual(["status", "ensure", "writeProfile", "restart"]);
    expect(maintenance.enterCalls).toBe(0); // a fresh container never pauses the agent
    expect(activity.records).toEqual([{ level: "info", message: "bot container created and profile applied" }]);
  });

  it("none: matching hashes on a running, healthy container do nothing beyond the drift check", async () => {
    const applied = profile();
    const driver = fakeDriver({
      botKey: "agent-a",
      state: "running",
      restartHash: applied.restartHash,
      filesHash: applied.filesHash,
    });
    const maintenance = fakeMaintenance([0]);
    const activity = fakeActivity();
    const outcome = await reconcileBot({
      agentId: "agent-a",
      botKey: "agent-a",
      spec: SPEC,
      compile: async () => applied,
      driver,
      maintenance,
      activity,
    });
    expect(outcome).toEqual({ kind: "unchanged" });
    // `ensure` always runs first so a template (image/resource) drift is picked up
    // even when the profile's own files have not changed (see driver.ts's `ensure`
    // contract) — it is a no-op here since nothing has drifted and the container is
    // already running.
    expect(driver.calls).toEqual(["status", "ensure"]);
    expect(maintenance.enterCalls).toBe(0);
    expect(activity.records).toEqual([]);
  });

  it("a spec that has drifted (e.g. image/resources changed on the card) recreates a running container via ensure()", async () => {
    // The fake's ensure() itself is a no-op for a "running" container beyond
    // logging the call, exactly like the real driver's own idempotent no-drift
    // path — this test only proves `ensure` is actually reached (unlike before the
    // fix, where it was skipped for every non-"missing" state) and that its
    // argument is `spec`, not some derived value.
    const applied = profile();
    const driver = fakeDriver({
      botKey: "agent-a",
      state: "running",
      restartHash: applied.restartHash,
      filesHash: applied.filesHash,
    });
    let ensureSpec: BotContainerSpec | undefined;
    const realEnsure = driver.ensure.bind(driver);
    driver.ensure = async (spec, compiled) => {
      ensureSpec = spec;
      return realEnsure(spec, compiled);
    };
    await reconcileBot({
      agentId: "agent-a",
      botKey: "agent-a",
      spec: SPEC,
      compile: async () => applied,
      driver,
      maintenance: fakeMaintenance([0]),
    });
    expect(ensureSpec).toEqual(SPEC);
  });

  it("propagates an ensure() failure (e.g. a rejected template) as an error outcome", async () => {
    const applied = profile();
    const driver = fakeDriver({
      botKey: "agent-a",
      state: "running",
      restartHash: applied.restartHash,
      filesHash: applied.filesHash,
    });
    driver.ensure = async () => {
      throw new Error("image not in allowlist");
    };
    const activity = fakeActivity();
    const outcome = await reconcileBot({
      agentId: "agent-a",
      botKey: "agent-a",
      spec: SPEC,
      compile: async () => applied,
      driver,
      maintenance: fakeMaintenance([0]),
      activity,
    });
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") expect(outcome.message).toContain("image not in allowlist");
    expect(activity.records.at(-1)).toEqual({ level: "error", message: "bot container reconcile failed" });
  });

  it("none: a stopped container with matching hashes gets ensure()d and explicitly restarted, not left down", async () => {
    const applied = profile();
    const driver = fakeDriver({
      botKey: "agent-a",
      state: "stopped",
      restartHash: applied.restartHash,
      filesHash: applied.filesHash,
    });
    const activity = fakeActivity();
    const outcome = await reconcileBot({
      agentId: "agent-a",
      botKey: "agent-a",
      spec: SPEC,
      compile: async () => applied,
      driver,
      maintenance: fakeMaintenance([0]),
      activity,
    });
    expect(outcome).toEqual({ kind: "applied_restart" });
    expect(driver.calls).toEqual(["status", "ensure", "restart"]);
    expect(driver.calls).not.toContain("writeProfile"); // the profile on disk is already correct
    expect(activity.records).toEqual([
      { level: "info", message: "bot container restarted to recover from a stopped/unhealthy state" },
    ]);
  });

  it("none: an unhealthy container with matching hashes is restarted to recover, not left unhealthy", async () => {
    const applied = profile();
    const driver = fakeDriver({
      botKey: "agent-a",
      state: "unhealthy",
      restartHash: applied.restartHash,
      filesHash: applied.filesHash,
    });
    const activity = fakeActivity();
    const outcome = await reconcileBot({
      agentId: "agent-a",
      botKey: "agent-a",
      spec: SPEC,
      compile: async () => applied,
      driver,
      maintenance: fakeMaintenance([0]),
      activity,
    });
    expect(outcome).toEqual({ kind: "applied_restart" });
    expect(driver.calls).toEqual(["status", "ensure", "restart"]);
    expect(driver.calls).not.toContain("writeProfile");
  });

  it("none: a failed recovery restart on an unhealthy container is reported as an error, not swallowed", async () => {
    const applied = profile();
    const driver = fakeDriver(
      { botKey: "agent-a", state: "unhealthy", restartHash: applied.restartHash, filesHash: applied.filesHash },
      { failRestart: true },
    );
    const activity = fakeActivity();
    const outcome = await reconcileBot({
      agentId: "agent-a",
      botKey: "agent-a",
      spec: SPEC,
      compile: async () => applied,
      driver,
      maintenance: fakeMaintenance([0]),
      activity,
    });
    expect(outcome.kind).toBe("error");
    expect(activity.records.at(-1)).toEqual({ level: "error", message: "bot container reconcile failed" });
  });

  it("files: same restartHash, different filesHash — writes without a restart or maintenance", async () => {
    const driver = fakeDriver({ botKey: "agent-a", state: "running", restartHash: "restart-1", filesHash: "files-old" });
    const maintenance = fakeMaintenance([0]);
    const activity = fakeActivity();
    const outcome = await reconcileBot({
      agentId: "agent-a",
      botKey: "agent-a",
      spec: SPEC,
      compile: async () => profile({ filesHash: "files-new" }),
      driver,
      maintenance,
      activity,
    });
    expect(outcome).toEqual({ kind: "applied_files" });
    expect(driver.calls).toEqual(["status", "ensure", "writeProfile"]);
    expect(maintenance.enterCalls).toBe(0);
  });

  it("restart: different restartHash — pauses only this agent, drains, writes, restarts, resumes", async () => {
    const driver = fakeDriver({ botKey: "agent-a", state: "running", restartHash: "restart-old", filesHash: "files-1" });
    const maintenance = fakeMaintenance([0]); // already zero running as soon as the window opens
    const activity = fakeActivity();
    const outcome = await reconcileBot({
      agentId: "agent-a",
      botKey: "agent-a",
      spec: SPEC,
      compile: async () => profile({ restartHash: "restart-new" }),
      driver,
      maintenance,
      activity,
    });
    expect(outcome).toEqual({ kind: "applied_restart" });
    expect(driver.calls).toEqual(["status", "ensure", "writeProfile", "restart"]);
    expect(maintenance.enterCalls).toBe(1);
    expect(maintenance.exitCalls).toEqual(["agent-a:bot container profile update (agent-a)"]);
  });

  it("restart: waits out running work before writing anything, using the injected sleep hook", async () => {
    const driver = fakeDriver({ botKey: "agent-a", state: "running", restartHash: "restart-old", filesHash: "files-1" });
    // 2 running, then 1, then 0 — three status() polls before the drain is done.
    const maintenance = fakeMaintenance([2, 1, 0]);
    const sleepCalls: number[] = [];
    const outcome = await reconcileBot({
      agentId: "agent-a",
      botKey: "agent-a",
      spec: SPEC,
      compile: async () => profile({ restartHash: "restart-new" }),
      driver,
      maintenance,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    });
    expect(outcome).toEqual({ kind: "applied_restart" });
    // enter() consumes the first value (2); the poll loop then reads 1 (sleeps), then 0 (stops).
    expect(sleepCalls.length).toBeGreaterThanOrEqual(1);
    expect(driver.calls).toEqual(["status", "ensure", "writeProfile", "restart"]);
  });

  it("restart: gives up and still exits maintenance when running work never drains", async () => {
    // A fully controlled fake clock instead of vitest's fake timers: `sleep`
    // advances it directly, so the test resolves instantly instead of waiting out
    // the real drain timeout + grace period.
    let fakeNow = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => fakeNow);
    try {
      const driver = fakeDriver({ botKey: "agent-a", state: "running", restartHash: "restart-old", filesHash: "files-1" });
      const maintenance = fakeMaintenance([3]); // always 3 running, never drains
      const activity = fakeActivity();
      const outcome = await reconcileBot({
        agentId: "agent-a",
        botKey: "agent-a",
        spec: SPEC,
        compile: async () => profile({ restartHash: "restart-new" }),
        driver,
        maintenance,
        activity,
        maintenanceDrainTimeoutSec: 5, // deadline ~= 5s + 30s grace on the fake clock
        sleep: async (ms) => {
          fakeNow += ms;
        },
      });
      expect(outcome.kind).toBe("error");
      expect(driver.calls).not.toContain("writeProfile");
      expect(driver.calls).not.toContain("restart");
      expect(maintenance.exitCalls).toHaveLength(1); // still cleaned up
      expect(activity.records.some((r) => r.level === "error")).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("propagates a writeProfile failure as an error outcome and logs it", async () => {
    const driver = fakeDriver(
      { botKey: "agent-a", state: "running", restartHash: "restart-1", filesHash: "files-old" },
      { failWriteProfile: true },
    );
    const maintenance = fakeMaintenance([0]);
    const activity = fakeActivity();
    const outcome = await reconcileBot({
      agentId: "agent-a",
      botKey: "agent-a",
      spec: SPEC,
      compile: async () => profile({ filesHash: "files-new" }),
      driver,
      maintenance,
      activity,
    });
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") expect(outcome.message).toContain("write failed");
    expect(activity.records.at(-1)).toEqual({ level: "error", message: "bot container reconcile failed" });
  });

  it("still exits maintenance when the restart itself fails health", async () => {
    const driver = fakeDriver(
      { botKey: "agent-a", state: "running", restartHash: "restart-old", filesHash: "files-1" },
      { failRestart: true },
    );
    const maintenance = fakeMaintenance([0]);
    const outcome = await reconcileBot({
      agentId: "agent-a",
      botKey: "agent-a",
      spec: SPEC,
      compile: async () => profile({ restartHash: "restart-new" }),
      driver,
      maintenance,
    });
    expect(outcome.kind).toBe("error");
    expect(maintenance.exitCalls).toHaveLength(1);
  });

  it("does not call exit when enter itself throws", async () => {
    const driver = fakeDriver({ botKey: "agent-a", state: "running", restartHash: "restart-old", filesHash: "files-1" });
    const maintenance = fakeMaintenance([0]);
    maintenance.enter = async () => {
      throw new Error("maintenance service unavailable");
    };
    const outcome = await reconcileBot({
      agentId: "agent-a",
      botKey: "agent-a",
      spec: SPEC,
      compile: async () => profile({ restartHash: "restart-new" }),
      driver,
      maintenance,
    });
    expect(outcome.kind).toBe("error");
    expect(maintenance.exitCalls).toEqual([]);
    expect(driver.calls).not.toContain("writeProfile");
  });

  it("never calls compile when the container status lookup itself fails", async () => {
    const driver: FakeDriver = {
      calls: [],
      async status() {
        this.calls.push("status");
        throw new Error("docker socket unreachable");
      },
      async list() {
        return [];
      },
      async ensure() {},
      async writeProfile() {},
      async restart() {},
      async stop() {},
    };
    const maintenance = fakeMaintenance([0]);
    const compile = vi.fn(async () => profile());
    const outcome = await reconcileBot({
      agentId: "agent-a",
      botKey: "agent-a",
      spec: SPEC,
      compile,
      driver,
      maintenance,
    });
    expect(outcome.kind).toBe("error");
    expect(compile).not.toHaveBeenCalled();
  });

  it("exposes its default drain timeout for callers to reference", () => {
    expect(DEFAULT_MAINTENANCE_DRAIN_TIMEOUT_SEC).toBe(300);
  });
});
