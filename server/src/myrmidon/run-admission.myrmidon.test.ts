import { describe, expect, it } from "vitest";
import { createRunAdmission, readCgroupFreeMemoryBytes, readRunAdmissionLimits } from "./run-admission.js";

const NO_MEMORY = { minFreeMemoryMb: null, runMemoryEstimateMb: 300 };
const MB = 1024 * 1024;

describe("readRunAdmissionLimits", () => {
  it("treats unset, empty, zero and garbage as no limit", () => {
    expect(readRunAdmissionLimits({})).toEqual({ maxConcurrentRuns: null, maxStartsPerMinute: null, ...NO_MEMORY });
    expect(
      readRunAdmissionLimits({ MYRMIDON_MAX_CONCURRENT_RUNS: "0", MYRMIDON_MAX_RUN_STARTS_PER_MINUTE: "x" }),
    ).toEqual({ maxConcurrentRuns: null, maxStartsPerMinute: null, ...NO_MEMORY });
    expect(
      readRunAdmissionLimits({ MYRMIDON_MAX_CONCURRENT_RUNS: " 12 ", MYRMIDON_MAX_RUN_STARTS_PER_MINUTE: "6" }),
    ).toEqual({ maxConcurrentRuns: 12, maxStartsPerMinute: 6, ...NO_MEMORY });
  });
});

describe("createRunAdmission", () => {
  it("passes the per-agent slots through when no limit is set", async () => {
    const admission = createRunAdmission({
      limits: { maxConcurrentRuns: null, maxStartsPerMinute: null, ...NO_MEMORY },
      countRunningRuns: async () => 1000,
    });
    expect(await admission.admit(3, async (allowed) => allowed)).toBe(3);
  });

  it("never starts more than the instance cap across concurrent agents", async () => {
    let running = 0;
    const admission = createRunAdmission({
      limits: { maxConcurrentRuns: 5, maxStartsPerMinute: null, ...NO_MEMORY },
      countRunningRuns: async () => running,
    });
    // 40 agents wake at once, each with one free per-agent slot.
    const started = await Promise.all(
      Array.from({ length: 40 }, () =>
        admission.admit(1, async (allowed) => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          running += allowed;
          return allowed;
        }),
      ),
    );
    expect(started.reduce((sum, n) => sum + n, 0)).toBe(5);
    expect(running).toBe(5);
  });

  it("limits starts per sliding minute", async () => {
    let clock = 0;
    const admission = createRunAdmission({
      limits: { maxConcurrentRuns: null, maxStartsPerMinute: 2, ...NO_MEMORY },
      countRunningRuns: async () => 0,
      now: () => clock,
    });
    const claim = async (allowed: number) => allowed;
    expect(await admission.admit(3, claim)).toBe(2);
    expect(await admission.admit(1, claim)).toBe(0);
    clock = 60_000;
    expect(await admission.admit(1, claim)).toBe(1);
  });

  it("counts only runs the claim actually started", async () => {
    let clock = 0;
    const admission = createRunAdmission({
      limits: { maxConcurrentRuns: null, maxStartsPerMinute: 2, ...NO_MEMORY },
      countRunningRuns: async () => 0,
      now: () => clock,
    });
    expect(await admission.admit(2, async () => 0)).toBe(0);
    expect(await admission.admit(2, async (allowed) => allowed)).toBe(2);
  });

  it("keeps serving after a claim throws", async () => {
    const admission = createRunAdmission({
      limits: { maxConcurrentRuns: 3, maxStartsPerMinute: null, ...NO_MEMORY },
      countRunningRuns: async () => 0,
    });
    await expect(admission.admit(1, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await admission.admit(1, async (allowed) => allowed)).toBe(1);
  });
});

describe("memory headroom", () => {
  it("starts only as many runs as fit above the free-memory floor", async () => {
    let free = 2500 * MB;
    const admission = createRunAdmission({
      limits: { maxConcurrentRuns: null, maxStartsPerMinute: null, minFreeMemoryMb: 1500, runMemoryEstimateMb: 300 },
      countRunningRuns: async () => 0,
      freeMemoryBytes: async () => free,
    });
    // 1000 MB above the floor fits three 300 MB runs.
    expect(await admission.admit(10, async (allowed) => allowed)).toBe(3);
    free = 1600 * MB;
    expect(await admission.admit(10, async (allowed) => allowed)).toBe(0);
  });

  it("leaves the other limits in charge when free memory is unknown", async () => {
    const admission = createRunAdmission({
      limits: { maxConcurrentRuns: 4, maxStartsPerMinute: null, minFreeMemoryMb: 1500, runMemoryEstimateMb: 300 },
      countRunningRuns: async () => 0,
      freeMemoryBytes: async () => null,
    });
    expect(await admission.admit(10, async (allowed) => allowed)).toBe(4);
  });

  it("reads cgroup v2 memory without reclaimable inactive cache", async () => {
    const files: Record<string, string> = {
      "/cg/memory.max": "8589934592\n",
      "/cg/memory.current": "7800532992\n",
      "/cg/memory.stat": "anon 4545642496\ninactive_file 2337927168\nactive_file 401641472\n",
    };
    const free = await readCgroupFreeMemoryBytes("/cg", async (path) => files[path]!);
    expect(free).toBe(8589934592 - (7800532992 - 2337927168));
    expect(await readCgroupFreeMemoryBytes("/cg", async (path) => (path.endsWith("max") ? "max" : "0"))).toBeNull();
    expect(await readCgroupFreeMemoryBytes("/none", async () => Promise.reject(new Error("ENOENT")))).toBeNull();
  });
});
