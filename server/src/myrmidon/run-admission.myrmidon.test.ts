import { describe, expect, it, vi } from "vitest";
import {
  createRunAdmission,
  readCgroupFreeMemoryBytes,
  readRunAdmissionLimits,
  scheduleQueuedResweep,
} from "./run-admission.js";

const NO_MEMORY = { minFreeMemoryMb: null, runMemoryEstimateMb: 300 };
const MB = 1024 * 1024;

describe("readRunAdmissionLimits", () => {
  it("treats unset, empty, zero and garbage as no limit", () => {
    expect(readRunAdmissionLimits({})).toEqual({ maxConcurrentRuns: null, maxStartsPerMinute: null, ...NO_MEMORY });
    expect(
      readRunAdmissionLimits({ MYRMIDON_MAX_CONCURRENT_RUNS: "0", MYRMIDON_MAX_RUN_STARTS_PER_MINUTE: "x" }),
    ).toEqual({ maxConcurrentRuns: null, maxStartsPerMinute: null, ...NO_MEMORY });
    expect(
      readRunAdmissionLimits({
        MYRMIDON_MAX_CONCURRENT_RUNS: " 12 ",
        MYRMIDON_MAX_RUN_STARTS_PER_MINUTE: "6",
        MYRMIDON_MIN_FREE_MEMORY_MB: "1500",
        MYRMIDON_RUN_MEMORY_ESTIMATE_MB: "250",
      }),
    ).toEqual({ maxConcurrentRuns: 12, maxStartsPerMinute: 6, minFreeMemoryMb: 1500, runMemoryEstimateMb: 250 });
  });
});

describe("createRunAdmission", () => {
  it("passes the per-agent slots through when no limit is set", () => {
    const admission = createRunAdmission({ limits: { maxConcurrentRuns: null, maxStartsPerMinute: null, ...NO_MEMORY } });
    expect(admission.reserve(3)).toBe(3);
  });

  it("never admits more than the cap when 40 agents wake at once", async () => {
    const admission = createRunAdmission({ limits: { maxConcurrentRuns: 5, maxStartsPerMinute: null, ...NO_MEMORY } });
    // Each agent reserves one slot, then awaits its claim before the next one runs.
    const started = await Promise.all(
      Array.from({ length: 40 }, async () => {
        const slots = admission.reserve(1);
        await new Promise((resolve) => setTimeout(resolve, 1));
        return slots;
      }),
    );
    expect(started.reduce((sum, n) => sum + n, 0)).toBe(5);
  });

  it("frees a slot when a run finishes and when a reserved slot is unused", () => {
    const admission = createRunAdmission({ limits: { maxConcurrentRuns: 2, maxStartsPerMinute: null, ...NO_MEMORY } });
    expect(admission.reserve(3)).toBe(2);
    expect(admission.reserve(1)).toBe(0);
    admission.finish();
    expect(admission.reserve(1)).toBe(1);
    admission.release(1);
    expect(admission.reserve(1)).toBe(1);
  });

  it("limits starts per sliding minute and gives back unused starts", () => {
    let clock = 0;
    const admission = createRunAdmission({
      limits: { maxConcurrentRuns: null, maxStartsPerMinute: 2, ...NO_MEMORY },
      now: () => clock,
    });
    expect(admission.reserve(3)).toBe(2);
    admission.release(1);
    expect(admission.reserve(3)).toBe(1);
    expect(admission.reserve(1)).toBe(0);
    clock = 60_000;
    expect(admission.reserve(1)).toBe(1);
  });
});

describe("memory headroom", () => {
  it("admits only runs that fit above the floor, counting runs still settling", () => {
    let clock = 0;
    let free = 2500 * MB;
    const admission = createRunAdmission({
      limits: { maxConcurrentRuns: null, maxStartsPerMinute: null, minFreeMemoryMb: 1500, runMemoryEstimateMb: 300 },
      freeMemoryBytes: () => free,
      now: () => clock,
    });
    // 1000 MB above the floor fits three 300 MB runs.
    expect(admission.reserve(10)).toBe(3);
    // The cgroup has not grown yet, but the three runs are still settling.
    expect(admission.reserve(10)).toBe(0);
    clock = 30_000;
    free = 1600 * MB;
    expect(admission.reserve(10)).toBe(0);
  });

  it("leaves the other limits in charge when free memory is unknown", () => {
    const admission = createRunAdmission({
      limits: { maxConcurrentRuns: 4, maxStartsPerMinute: null, minFreeMemoryMb: 1500, runMemoryEstimateMb: 300 },
      freeMemoryBytes: () => null,
    });
    expect(admission.reserve(10)).toBe(4);
  });

  it("reads cgroup v2 memory without reclaimable inactive cache", () => {
    const files: Record<string, string> = {
      "/cg/memory.max": "8589934592\n",
      "/cg/memory.current": "7800532992\n",
      "/cg/memory.stat": "anon 4545642496\ninactive_file 2337927168\nactive_file 401641472\n",
    };
    expect(readCgroupFreeMemoryBytes("/cg", (path) => files[path]!)).toBe(8589934592 - (7800532992 - 2337927168));
    expect(readCgroupFreeMemoryBytes("/cg", (path) => (path.endsWith("max") ? "max" : "0"))).toBeNull();
    expect(
      readCgroupFreeMemoryBytes("/none", () => {
        throw new Error("ENOENT");
      }),
    ).toBeNull();
  });
});

describe("drift and resweep", () => {
  it("raises the count to the database but never lowers it", () => {
    const admission = createRunAdmission({ limits: { maxConcurrentRuns: 12, maxStartsPerMinute: null, ...NO_MEMORY } });
    expect(admission.reserve(2)).toBe(2);
    // An execution settled while its row still runs: the database says 12.
    admission.finish();
    admission.syncRunning(12);
    expect(admission.reserve(1)).toBe(0);
    admission.syncRunning(3);
    expect(admission.reserve(1)).toBe(0);
  });

  it("reports when a limit held runs back", () => {
    const admission = createRunAdmission({ limits: { maxConcurrentRuns: 1, maxStartsPerMinute: null, ...NO_MEMORY } });
    expect(admission.reserve(1)).toBe(1);
    expect(admission.limited()).toBe(false);
    expect(admission.reserve(2)).toBe(0);
    expect(admission.limited()).toBe(true);
  });

  it("schedules one resweep for many calls", () => {
    vi.useFakeTimers();
    try {
      const sweep = vi.fn();
      scheduleQueuedResweep(sweep, 1000);
      scheduleQueuedResweep(sweep, 1000);
      vi.advanceTimersByTime(1000);
      expect(sweep).toHaveBeenCalledTimes(1);
      scheduleQueuedResweep(sweep, 1000);
      vi.advanceTimersByTime(1000);
      expect(sweep).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
