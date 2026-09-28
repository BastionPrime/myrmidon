import { describe, expect, it } from "vitest";
import { createRunAdmission, readRunAdmissionLimits } from "./run-admission.js";

describe("readRunAdmissionLimits", () => {
  it("treats unset, empty, zero and garbage as no limit", () => {
    expect(readRunAdmissionLimits({})).toEqual({ maxConcurrentRuns: null, maxStartsPerMinute: null });
    expect(
      readRunAdmissionLimits({ MYRMIDON_MAX_CONCURRENT_RUNS: "0", MYRMIDON_MAX_RUN_STARTS_PER_MINUTE: "x" }),
    ).toEqual({ maxConcurrentRuns: null, maxStartsPerMinute: null });
    expect(
      readRunAdmissionLimits({ MYRMIDON_MAX_CONCURRENT_RUNS: " 12 ", MYRMIDON_MAX_RUN_STARTS_PER_MINUTE: "6" }),
    ).toEqual({ maxConcurrentRuns: 12, maxStartsPerMinute: 6 });
  });
});

describe("createRunAdmission", () => {
  it("passes the per-agent slots through when no limit is set", async () => {
    const admission = createRunAdmission({
      limits: { maxConcurrentRuns: null, maxStartsPerMinute: null },
      countRunningRuns: async () => 1000,
    });
    expect(await admission.admit(3, async (allowed) => allowed)).toBe(3);
  });

  it("never starts more than the instance cap across concurrent agents", async () => {
    let running = 0;
    const admission = createRunAdmission({
      limits: { maxConcurrentRuns: 5, maxStartsPerMinute: null },
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
      limits: { maxConcurrentRuns: null, maxStartsPerMinute: 2 },
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
      limits: { maxConcurrentRuns: null, maxStartsPerMinute: 2 },
      countRunningRuns: async () => 0,
      now: () => clock,
    });
    expect(await admission.admit(2, async () => 0)).toBe(0);
    expect(await admission.admit(2, async (allowed) => allowed)).toBe(2);
  });

  it("keeps serving after a claim throws", async () => {
    const admission = createRunAdmission({
      limits: { maxConcurrentRuns: 3, maxStartsPerMinute: null },
      countRunningRuns: async () => 0,
    });
    await expect(admission.admit(1, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await admission.admit(1, async (allowed) => allowed)).toBe(1);
  });
});
