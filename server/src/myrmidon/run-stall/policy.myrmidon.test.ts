import { describe, expect, it } from "vitest";
import {
  classifyRunStall,
  hasLiveExecutionStage,
  progressAnchorAt,
  progressSilenceMs,
  shouldReturnIssueToTodo,
  type RunProgressTimestamps,
} from "./policy.js";

const NOW = new Date("2026-10-02T00:00:00.000Z");
const MINUTE = 60 * 1000;
const THRESHOLD = 20 * MINUTE;

function at(minutesAgo: number): Date {
  return new Date(NOW.getTime() - minutesAgo * MINUTE);
}

function progress(overrides: Partial<RunProgressTimestamps> = {}): RunProgressTimestamps {
  return {
    lastOutputAt: null,
    lastUsefulActionAt: null,
    lastEventAt: null,
    processStartedAt: null,
    startedAt: null,
    ...overrides,
  };
}

describe("run stall policy: the progress anchor", () => {
  it("takes the newest recorded progress of every kind", () => {
    expect(progressAnchorAt(progress({ lastOutputAt: at(30), startedAt: at(90) }))).toEqual(at(30));
    expect(progressAnchorAt(progress({ lastUsefulActionAt: at(20), lastEventAt: at(25) }))).toEqual(at(20));
    expect(progressAnchorAt(progress({ lastEventAt: at(21), lastOutputAt: at(22) }))).toEqual(at(21));
  });

  it("falls back to the claim timestamps only while no progress exists", () => {
    expect(progressAnchorAt(progress({ startedAt: at(10) }))).toEqual(at(10));
    expect(progressAnchorAt(progress({ processStartedAt: at(5), startedAt: at(10) }))).toEqual(at(5));
    expect(progressAnchorAt(progress({ lastOutputAt: at(50), startedAt: at(5) }))).toEqual(at(5));
  });

  it("is unknown, never stalled, when the run records no timestamp at all", () => {
    expect(progressAnchorAt(progress())).toBeNull();
    expect(progressSilenceMs(progress(), NOW)).toBeNull();
    expect(classifyRunStall({ run: progress(), now: NOW, thresholdMs: THRESHOLD })).toBe("unknown");
  });

  it("ignores an invalid date instead of reading it as 1970", () => {
    const invalid = new Date("not a date");
    expect(progressAnchorAt(progress({ lastOutputAt: invalid, startedAt: at(10) }))).toEqual(at(10));
  });
});

describe("run stall policy: quiet but alive versus stalled", () => {
  it("is active while the newest recorded progress is inside the threshold", () => {
    expect(classifyRunStall({ run: progress({ lastOutputAt: at(19) }), now: NOW, thresholdMs: THRESHOLD })).toBe("active");
  });

  it("turns stalled exactly at the threshold", () => {
    expect(classifyRunStall({ run: progress({ lastOutputAt: at(20) }), now: NOW, thresholdMs: THRESHOLD })).toBe("stalled");
    expect(classifyRunStall({ run: progress({ lastOutputAt: at(19.99) }), now: NOW, thresholdMs: THRESHOLD })).toBe("active");
  });

  it("is stalled once the newest recorded progress is older than the threshold", () => {
    expect(classifyRunStall({ run: progress({ lastOutputAt: at(45) }), now: NOW, thresholdMs: THRESHOLD })).toBe("stalled");
  });

  it("counts a fresh event as progress even when the last output is old", () => {
    expect(
      classifyRunStall({
        run: progress({ lastOutputAt: at(120), lastEventAt: at(1) }),
        now: NOW,
        thresholdMs: THRESHOLD,
      }),
    ).toBe("active");
  });

  it("counts a fresh useful action as progress even when everything else is old", () => {
    expect(
      classifyRunStall({
        run: progress({ lastOutputAt: at(120), lastEventAt: at(120), lastUsefulActionAt: at(2) }),
        now: NOW,
        thresholdMs: THRESHOLD,
      }),
    ).toBe("active");
  });

  it("does not turn stalled merely because the run has been running long: 10 hours with fresh output", () => {
    expect(
      classifyRunStall({
        run: progress({ startedAt: at(600), lastOutputAt: at(3) }),
        now: NOW,
        thresholdMs: THRESHOLD,
      }),
    ).toBe("active");
  });

  it("scales with the configured threshold", () => {
    const run = progress({ lastOutputAt: at(45) });
    expect(classifyRunStall({ run, now: NOW, thresholdMs: 60 * MINUTE })).toBe("active");
    expect(classifyRunStall({ run, now: NOW, thresholdMs: 30 * MINUTE })).toBe("stalled");
  });

  it("never reports negative silence when a timestamp is in the future", () => {
    const future = new Date(NOW.getTime() + 5 * MINUTE);
    expect(progressSilenceMs(progress({ lastOutputAt: future }), NOW)).toBe(0);
    expect(classifyRunStall({ run: progress({ lastOutputAt: future }), now: NOW, thresholdMs: THRESHOLD })).toBe("active");
  });
});

describe("run stall policy: does the task go back to todo", () => {
  it("moves an in-progress task with no live workflow", () => {
    expect(shouldReturnIssueToTodo({ status: "in_progress", executionState: null })).toBe(true);
    expect(shouldReturnIssueToTodo({ status: "in_progress", executionState: { status: "idle" } })).toBe(true);
  });

  it("keeps every other status as it is", () => {
    expect(shouldReturnIssueToTodo({ status: "in_review" })).toBe(false);
    expect(shouldReturnIssueToTodo({ status: "blocked" })).toBe(false);
    expect(shouldReturnIssueToTodo({ status: "todo" })).toBe(false);
    expect(shouldReturnIssueToTodo({ status: "done" })).toBe(false);
    expect(shouldReturnIssueToTodo({ status: "cancelled" })).toBe(false);
  });

  it("keeps a task whose review or monitor workflow owns the next step", () => {
    expect(hasLiveExecutionStage({ status: "awaiting_review" })).toBe(true);
    expect(hasLiveExecutionStage({ status: "running" })).toBe(true);
    expect(hasLiveExecutionStage({ monitor: { kind: "external_service" } })).toBe(true);
    expect(shouldReturnIssueToTodo({ status: "in_progress", executionState: { status: "awaiting_approval" } })).toBe(false);
    expect(hasLiveExecutionStage({ status: "idle", monitor: null })).toBe(false);
    expect(hasLiveExecutionStage(undefined)).toBe(false);
  });
});