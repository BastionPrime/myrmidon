import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAINTENANCE_DRAIN_TIMEOUT_SEC,
  reconcileBot,
  type BotMaintenancePort,
  type MaintenanceEnterResult,
  type MaintenanceWindowView,
} from "./reconciler.js";
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
  current(): BotContainerStatus;
}

/**
 * Models the real driver's contract, including what it deliberately does NOT
 * do: `create`/`recreate` leave the container stopped with no applied marker of
 * its own (hashes live on the volume, which a recreate keeps), `writeProfile` is
 * the only thing that sets the applied hashes, and it works whether or not the
 * container is running.
 */
function fakeDriver(
  initial: BotContainerStatus,
  opts: { drift?: boolean; fail?: Partial<Record<"create" | "recreate" | "writeProfile" | "start" | "restart", string>> } = {},
): FakeDriver {
  const calls: string[] = [];
  let current = initial;
  const maybeFail = (step: keyof NonNullable<typeof opts.fail>) => {
    const message = opts.fail?.[step];
    if (message) throw new Error(message);
  };
  return {
    calls,
    current: () => current,
    async status() {
      calls.push("status");
      return current;
    },
    async list() {
      return [current];
    },
    async templateDrift() {
      calls.push("templateDrift");
      return current.state !== "missing" && (opts.drift ?? false);
    },
    async create() {
      calls.push("create");
      maybeFail("create");
      current = { botKey: current.botKey, state: "stopped" };
    },
    async recreate() {
      calls.push("recreate");
      maybeFail("recreate");
      current = { ...current, state: "stopped" };
    },
    async writeProfile(_botKey, compiled) {
      calls.push("writeProfile");
      maybeFail("writeProfile");
      current = { ...current, restartHash: compiled.restartHash, filesHash: compiled.filesHash };
    },
    async start() {
      calls.push("start");
      maybeFail("start");
      current = { ...current, state: "running" };
    },
    async restart() {
      calls.push("restart");
      maybeFail("restart");
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
 *  value repeats once the sequence is exhausted. `owned: false` models a window
 *  that already existed for the agent and was opened by someone else. */
function fakeMaintenance(runningSequence: number[], opts: { owned?: boolean } = {}): FakeMaintenance {
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
    async enter(): Promise<MaintenanceEnterResult> {
      enterCalls++;
      const running = nextRunning();
      return { state: running === 0 ? "on" : "entering", runningRuns: running, owned: opts.owned ?? true };
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

function run(driver: FakeDriver, maintenance: FakeMaintenance, extra: Partial<Parameters<typeof reconcileBot>[0]> = {}) {
  return reconcileBot({
    agentId: "agent-a",
    botKey: "agent-a",
    spec: SPEC,
    compile: async () => profile(),
    driver,
    maintenance,
    ...extra,
  });
}

describe("reconcileBot", () => {
  describe("missing", () => {
    it("creates the container stopped, writes the profile, and only then starts it", async () => {
      const driver = fakeDriver({ botKey: "agent-a", state: "missing" });
      const maintenance = fakeMaintenance([0]);
      const activity = fakeActivity();
      const outcome = await run(driver, maintenance, { activity });
      expect(outcome).toEqual({ kind: "created" });
      expect(driver.calls).toEqual(["status", "create", "writeProfile", "start"]);
      expect(maintenance.enterCalls).toBe(0); // nothing was running, nothing to drain
      expect(activity.records).toEqual([{ level: "info", message: "bot container created and profile applied" }]);
    });

    it("a failed first profile write is retried on the next pass (idempotent recovery), never left as 'applied'", async () => {
      // First pass: create succeeds, writeProfile fails.
      const driver = fakeDriver({ botKey: "agent-a", state: "missing" }, { fail: { writeProfile: "archive PUT failed" } });
      const first = await run(driver, fakeMaintenance([0]));
      expect(first.kind).toBe("error");
      expect(driver.current()).toEqual({ botKey: "agent-a", state: "stopped" }); // no hashes: nothing applied

      // Second pass on the same container, write now works: the missing marker
      // classifies as "restart" (not "none"), so the profile is written and the
      // container started — without a maintenance window, since it is stopped.
      const retry = fakeDriver(driver.current());
      const maintenance = fakeMaintenance([0]);
      const second = await run(retry, maintenance);
      expect(second).toEqual({ kind: "applied_restart" });
      expect(retry.calls).toEqual(["status", "templateDrift", "writeProfile", "start"]);
      expect(maintenance.enterCalls).toBe(0);

      // Third pass: converged.
      const third = await run(fakeDriver(retry.current()), fakeMaintenance([0]));
      expect(third).toEqual({ kind: "unchanged" });
    });
  });

  describe("stopped", () => {
    it("with the profile already applied: just starts it, no write, no window", async () => {
      const applied = profile();
      const driver = fakeDriver({ botKey: "agent-a", state: "stopped", ...hashesOf(applied) });
      const maintenance = fakeMaintenance([0]);
      const outcome = await run(driver, maintenance);
      expect(outcome).toEqual({ kind: "applied_restart" });
      expect(driver.calls).toEqual(["status", "templateDrift", "start"]);
      expect(maintenance.enterCalls).toBe(0);
    });

    it("with a changed profile: writes it while stopped (no exec needed), then starts", async () => {
      const driver = fakeDriver({ botKey: "agent-a", state: "stopped", restartHash: "old", filesHash: "old" });
      const outcome = await run(driver, fakeMaintenance([0]));
      expect(outcome).toEqual({ kind: "applied_restart" });
      expect(driver.calls).toEqual(["status", "templateDrift", "writeProfile", "start"]);
    });

    it("with a drifted template: recreates, then starts — no maintenance window for a container that runs nothing", async () => {
      const applied = profile();
      const driver = fakeDriver({ botKey: "agent-a", state: "stopped", ...hashesOf(applied) }, { drift: true });
      const maintenance = fakeMaintenance([0]);
      const outcome = await run(driver, maintenance);
      expect(outcome).toEqual({ kind: "applied_restart" });
      expect(driver.calls).toEqual(["status", "templateDrift", "recreate", "start"]);
      expect(maintenance.enterCalls).toBe(0);
    });
  });

  describe("running", () => {
    it("none: matching hashes on a healthy container do nothing beyond the drift check", async () => {
      const applied = profile();
      const driver = fakeDriver({ botKey: "agent-a", state: "running", ...hashesOf(applied) });
      const maintenance = fakeMaintenance([0]);
      const activity = fakeActivity();
      const outcome = await run(driver, maintenance, { activity });
      expect(outcome).toEqual({ kind: "unchanged" });
      expect(driver.calls).toEqual(["status", "templateDrift"]);
      expect(maintenance.enterCalls).toBe(0);
      expect(activity.records).toEqual([]);
    });

    it("no applied marker (hashes absent) is a restart-class change, never 'none'", async () => {
      // The driver reports hashes only from the marker the last successful write
      // moved into place; a container whose marker is missing has nothing
      // verified applied, whatever it was created with.
      const driver = fakeDriver({ botKey: "agent-a", state: "running" });
      const maintenance = fakeMaintenance([0]);
      const outcome = await run(driver, maintenance);
      expect(outcome).toEqual({ kind: "applied_restart" });
      expect(driver.calls).toEqual(["status", "templateDrift", "writeProfile", "restart"]);
      expect(maintenance.enterCalls).toBe(1);
    });

    it("files: same restartHash, different filesHash — writes without a restart or maintenance", async () => {
      const driver = fakeDriver({ botKey: "agent-a", state: "running", restartHash: "restart-1", filesHash: "files-old" });
      const maintenance = fakeMaintenance([0]);
      const outcome = await run(driver, maintenance, { compile: async () => profile({ filesHash: "files-new" }) });
      expect(outcome).toEqual({ kind: "applied_files" });
      expect(driver.calls).toEqual(["status", "templateDrift", "writeProfile"]);
      expect(maintenance.enterCalls).toBe(0);
    });

    it("restart: different restartHash — pauses only this agent, drains, writes, restarts, resumes", async () => {
      const driver = fakeDriver({ botKey: "agent-a", state: "running", restartHash: "restart-old", filesHash: "files-1" });
      const maintenance = fakeMaintenance([0]);
      const outcome = await run(driver, maintenance, { compile: async () => profile({ restartHash: "restart-new" }) });
      expect(outcome).toEqual({ kind: "applied_restart" });
      expect(driver.calls).toEqual(["status", "templateDrift", "writeProfile", "restart"]);
      expect(maintenance.enterCalls).toBe(1);
      expect(maintenance.exitCalls).toEqual(["agent-a:bot container profile update (agent-a)"]);
    });

    it("restart: waits out running work before writing anything, using the injected sleep hook", async () => {
      const driver = fakeDriver({ botKey: "agent-a", state: "running", restartHash: "restart-old", filesHash: "files-1" });
      const maintenance = fakeMaintenance([2, 1, 0]);
      let callsAtFirstDrainPoll: string[] | undefined;
      const outcome = await run(driver, maintenance, {
        compile: async () => profile({ restartHash: "restart-new" }),
        sleep: async () => {
          callsAtFirstDrainPoll ??= [...driver.calls];
        },
      });
      expect(outcome).toEqual({ kind: "applied_restart" });
      expect(callsAtFirstDrainPoll).toEqual(["status", "templateDrift"]); // nothing written while draining
      expect(driver.calls).toEqual(["status", "templateDrift", "writeProfile", "restart"]);
    });

    it("restart: gives up and still exits maintenance when running work never drains", async () => {
      let fakeNow = 0;
      const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => fakeNow);
      try {
        const driver = fakeDriver({ botKey: "agent-a", state: "running", restartHash: "restart-old", filesHash: "files-1" });
        const maintenance = fakeMaintenance([3]); // always 3 running, never drains
        const activity = fakeActivity();
        const outcome = await run(driver, maintenance, {
          compile: async () => profile({ restartHash: "restart-new" }),
          activity,
          maintenanceDrainTimeoutSec: 5,
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

    it("still exits maintenance when the restart itself fails health", async () => {
      const driver = fakeDriver(
        { botKey: "agent-a", state: "running", restartHash: "restart-old", filesHash: "files-1" },
        { fail: { restart: "never became healthy" } },
      );
      const maintenance = fakeMaintenance([0]);
      const outcome = await run(driver, maintenance, { compile: async () => profile({ restartHash: "restart-new" }) });
      expect(outcome.kind).toBe("error");
      expect(maintenance.exitCalls).toHaveLength(1);
    });
  });

  describe("unhealthy (Docker's own health check gave up)", () => {
    it("is restarted only inside a drained maintenance window, never directly", async () => {
      const applied = profile();
      const driver = fakeDriver({ botKey: "agent-a", state: "unhealthy", ...hashesOf(applied) });
      const maintenance = fakeMaintenance([1, 1, 0]);
      let callsAtFirstDrainPoll: string[] | undefined;
      const outcome = await run(driver, maintenance, {
        sleep: async () => {
          callsAtFirstDrainPoll ??= [...driver.calls];
        },
      });
      expect(outcome).toEqual({ kind: "applied_restart" });
      expect(maintenance.enterCalls).toBe(1);
      expect(callsAtFirstDrainPoll).toEqual(["status", "templateDrift"]); // no restart before the drain
      expect(driver.calls).toEqual(["status", "templateDrift", "restart"]); // profile already applied: no write
      expect(maintenance.exitCalls).toEqual(["agent-a:bot container health recovery (agent-a)"]);
    });

    it("writes a changed profile inside the same window before restarting", async () => {
      const driver = fakeDriver({ botKey: "agent-a", state: "unhealthy", restartHash: "restart-1", filesHash: "files-old" });
      const maintenance = fakeMaintenance([0]);
      const outcome = await run(driver, maintenance);
      expect(outcome).toEqual({ kind: "applied_restart" });
      expect(driver.calls).toEqual(["status", "templateDrift", "writeProfile", "restart"]);
      expect(maintenance.enterCalls).toBe(1);
    });

    it("a failed recovery restart is reported as an error, and the window is still closed", async () => {
      const applied = profile();
      const driver = fakeDriver({ botKey: "agent-a", state: "unhealthy", ...hashesOf(applied) }, { fail: { restart: "boom" } });
      const maintenance = fakeMaintenance([0]);
      const activity = fakeActivity();
      const outcome = await run(driver, maintenance, { activity });
      expect(outcome.kind).toBe("error");
      expect(maintenance.exitCalls).toHaveLength(1);
      expect(activity.records.at(-1)).toEqual({ level: "error", message: "bot container reconcile failed" });
    });
  });

  describe("template drift on a live container (image/resources changed on the card)", () => {
    it("recreates only inside a drained maintenance window, then starts the new container", async () => {
      const applied = profile();
      const driver = fakeDriver({ botKey: "agent-a", state: "running", ...hashesOf(applied) }, { drift: true });
      const maintenance = fakeMaintenance([1, 1, 0]);
      const activity = fakeActivity();
      let callsAtFirstDrainPoll: string[] | undefined;
      const outcome = await run(driver, maintenance, {
        activity,
        sleep: async () => {
          callsAtFirstDrainPoll ??= [...driver.calls];
        },
      });
      expect(outcome).toEqual({ kind: "applied_restart" });
      expect(callsAtFirstDrainPoll).toEqual(["status", "templateDrift"]); // recreate not reached while draining
      expect(driver.calls).toEqual(["status", "templateDrift", "recreate", "start"]);
      expect(maintenance.exitCalls).toEqual(["agent-a:bot container template update (agent-a)"]);
      expect(activity.records.at(-1)).toEqual({
        level: "info",
        message: "bot container recreated for a template change (image, resource limits or network)",
      });
    });

    it("also writes a changed profile to the recreated container before starting it", async () => {
      const driver = fakeDriver({ botKey: "agent-a", state: "running", restartHash: "old", filesHash: "old" }, { drift: true });
      const outcome = await run(driver, fakeMaintenance([0]));
      expect(outcome).toEqual({ kind: "applied_restart" });
      expect(driver.calls).toEqual(["status", "templateDrift", "recreate", "writeProfile", "start"]);
    });

    it("passes `spec` itself to recreate", async () => {
      const applied = profile();
      const driver = fakeDriver({ botKey: "agent-a", state: "running", ...hashesOf(applied) }, { drift: true });
      const seen: BotContainerSpec[] = [];
      const realRecreate = driver.recreate.bind(driver);
      driver.recreate = async (spec) => {
        seen.push(spec);
        return realRecreate(spec);
      };
      await run(driver, fakeMaintenance([0]));
      expect(seen).toEqual([SPEC]);
    });

    it("never recreates when running work never drains, and still exits maintenance", async () => {
      let fakeNow = 0;
      const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => fakeNow);
      try {
        const applied = profile();
        const driver = fakeDriver({ botKey: "agent-a", state: "running", ...hashesOf(applied) }, { drift: true });
        const maintenance = fakeMaintenance([3]);
        const outcome = await run(driver, maintenance, {
          maintenanceDrainTimeoutSec: 5,
          sleep: async (ms) => {
            fakeNow += ms;
          },
        });
        expect(outcome.kind).toBe("error");
        expect(driver.calls).not.toContain("recreate");
        expect(driver.calls).not.toContain("start");
        expect(maintenance.exitCalls).toHaveLength(1);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it("a failed recreate (e.g. image not present) is an error outcome; the window is still exited", async () => {
      const applied = profile();
      const driver = fakeDriver(
        { botKey: "agent-a", state: "running", ...hashesOf(applied) },
        { drift: true, fail: { recreate: 'image "myrmidon-hermes:1.2.0" is not present on the Docker host' } },
      );
      const maintenance = fakeMaintenance([0]);
      const activity = fakeActivity();
      const outcome = await run(driver, maintenance, { activity });
      expect(outcome.kind).toBe("error");
      if (outcome.kind === "error") expect(outcome.message).toContain("is not present");
      expect(driver.calls).not.toContain("start");
      expect(maintenance.exitCalls).toHaveLength(1);
    });
  });

  describe("maintenance windows the reconciler did not open", () => {
    it("defers a restart-class change instead of applying it inside someone else's window, and never exits that window", async () => {
      const driver = fakeDriver({ botKey: "agent-a", state: "running", restartHash: "restart-old", filesHash: "files-1" });
      const maintenance = fakeMaintenance([0], { owned: false });
      const activity = fakeActivity();
      const outcome = await run(driver, maintenance, { activity, compile: async () => profile({ restartHash: "restart-new" }) });
      expect(outcome.kind).toBe("deferred");
      expect(maintenance.exitCalls).toEqual([]); // the operator's window stays open
      expect(driver.calls).toEqual(["status", "templateDrift"]); // nothing written, nothing restarted
      expect(activity.records.at(-1)).toEqual({ level: "info", message: "bot container update deferred" });
    });

    it("defers a template recreate the same way", async () => {
      const applied = profile();
      const driver = fakeDriver({ botKey: "agent-a", state: "running", ...hashesOf(applied) }, { drift: true });
      const maintenance = fakeMaintenance([0], { owned: false });
      const outcome = await run(driver, maintenance);
      expect(outcome.kind).toBe("deferred");
      expect(driver.calls).not.toContain("recreate");
      expect(maintenance.exitCalls).toEqual([]);
    });

    it("applies on a later pass once the reconciler can open its own window", async () => {
      const status: BotContainerStatus = { botKey: "agent-a", state: "running", restartHash: "restart-old", filesHash: "files-1" };
      const compile = async () => profile({ restartHash: "restart-new" });
      expect((await run(fakeDriver(status), fakeMaintenance([0], { owned: false }), { compile })).kind).toBe("deferred");
      const later = fakeDriver(status);
      const maintenance = fakeMaintenance([0]);
      expect(await run(later, maintenance, { compile })).toEqual({ kind: "applied_restart" });
      expect(maintenance.exitCalls).toHaveLength(1);
    });
  });

  it("does not call exit when enter itself throws", async () => {
    const driver = fakeDriver({ botKey: "agent-a", state: "running", restartHash: "restart-old", filesHash: "files-1" });
    const maintenance = fakeMaintenance([0]);
    maintenance.enter = async () => {
      throw new Error("maintenance service unavailable");
    };
    const outcome = await run(driver, maintenance, { compile: async () => profile({ restartHash: "restart-new" }) });
    expect(outcome.kind).toBe("error");
    expect(maintenance.exitCalls).toEqual([]);
    expect(driver.calls).not.toContain("writeProfile");
  });

  it("propagates a writeProfile failure as an error outcome and logs it", async () => {
    const driver = fakeDriver(
      { botKey: "agent-a", state: "running", restartHash: "restart-1", filesHash: "files-old" },
      { fail: { writeProfile: "write failed" } },
    );
    const activity = fakeActivity();
    const outcome = await run(driver, fakeMaintenance([0]), { activity, compile: async () => profile({ filesHash: "files-new" }) });
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") expect(outcome.message).toContain("write failed");
    expect(activity.records.at(-1)).toEqual({ level: "error", message: "bot container reconcile failed" });
  });

  it("never calls compile when the container status lookup itself fails", async () => {
    const driver = fakeDriver({ botKey: "agent-a", state: "running" });
    driver.status = async () => {
      throw new Error("docker socket unreachable");
    };
    const compile = vi.fn(async () => profile());
    const outcome = await run(driver, fakeMaintenance([0]), { compile });
    expect(outcome.kind).toBe("error");
    expect(compile).not.toHaveBeenCalled();
  });

  it("exposes its default drain timeout for callers to reference", () => {
    expect(DEFAULT_MAINTENANCE_DRAIN_TIMEOUT_SEC).toBe(300);
  });
});

function hashesOf(applied: CompiledProfile): Pick<BotContainerStatus, "restartHash" | "filesHash"> {
  return { restartHash: applied.restartHash, filesHash: applied.filesHash };
}
