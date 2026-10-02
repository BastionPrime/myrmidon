import { describe, expect, it } from "vitest";
import {
  AUTO_RESUME_BACKOFF_MS_ENV,
  AUTO_RESUME_ENABLED_ENV,
  AUTO_RESUME_INTERVAL_SEC_ENV,
  AUTO_RESUME_MAX_ATTEMPTS_ENV,
  AUTO_RESUME_METADATA_KEY,
  AUTO_RESUME_WINDOW_MS_ENV,
  DEFAULT_AUTO_RESUME_BACKOFF_MS,
  backoffForAttempt,
  decideAutoResume,
  mergeAutoResumeState,
  readAutoResumeAttentionState,
  readAutoResumeEnabled,
  readAutoResumeSettings,
  readAutoResumeState,
  type AutoResumeSettings,
  type AutoResumeState,
} from "./auto-resume.js";

// AUTO-RESUME (1.4): the board brings an agent left in `error` back with a
// 1/5/15 min backoff and stops with an operator card after the attempt cap.
const SETTINGS: AutoResumeSettings = {
  enabled: true,
  backoffMs: [60_000, 300_000, 900_000],
  maxAttempts: 3,
  intervalSec: 60,
  failureWindowMs: 60 * 60 * 1000,
};

const ENTRY = new Date("2026-10-02T00:00:00.000Z");

function at(offsetMs: number): Date {
  return new Date(ENTRY.getTime() + offsetMs);
}

function decide(overrides: Partial<Parameters<typeof decideAutoResume>[0]> = {}) {
  return decideAutoResume({
    agent: { status: "error", updatedAt: ENTRY },
    state: null,
    settings: SETTINGS,
    now: ENTRY,
    invokable: true,
    underMaintenance: false,
    ...overrides,
  });
}

describe("settings readers", () => {
  it("defaults to on unless an explicit off value is set", () => {
    expect(readAutoResumeEnabled({})).toBe(true);
    expect(readAutoResumeEnabled({ [AUTO_RESUME_ENABLED_ENV]: "garbage" })).toBe(true);
    for (const raw of ["0", "false", "off", "no", "OFF", " No "]) {
      expect(readAutoResumeEnabled({ [AUTO_RESUME_ENABLED_ENV]: raw }), raw).toBe(false);
    }
  });

  it("uses the 1/5/15 min default backoff, cap 3, per-minute sweep and a 1 h window", () => {
    const settings = readAutoResumeSettings({});
    expect(settings).toEqual({
      enabled: true,
      backoffMs: [...DEFAULT_AUTO_RESUME_BACKOFF_MS],
      maxAttempts: 3,
      intervalSec: 60,
      failureWindowMs: 60 * 60 * 1000,
    });
  });

  it("parses a custom backoff list and drops invalid entries", () => {
    expect(readAutoResumeSettings({ [AUTO_RESUME_BACKOFF_MS_ENV]: "1000, 2000,3000" }).backoffMs).toEqual([1000, 2000, 3000]);
    expect(readAutoResumeSettings({ [AUTO_RESUME_BACKOFF_MS_ENV]: "1000,abc,-5,0,2000" }).backoffMs).toEqual([1000, 2000]);
    expect(readAutoResumeSettings({ [AUTO_RESUME_BACKOFF_MS_ENV]: "garbage" }).backoffMs).toEqual([...DEFAULT_AUTO_RESUME_BACKOFF_MS]);
  });

  it("falls back to defaults for invalid cap/window and clamps the interval up", () => {
    expect(readAutoResumeSettings({ [AUTO_RESUME_MAX_ATTEMPTS_ENV]: "0" }).maxAttempts).toBe(3);
    expect(readAutoResumeSettings({ [AUTO_RESUME_MAX_ATTEMPTS_ENV]: "-1" }).maxAttempts).toBe(3);
    expect(readAutoResumeSettings({ [AUTO_RESUME_MAX_ATTEMPTS_ENV]: "5" }).maxAttempts).toBe(5);
    expect(readAutoResumeSettings({ [AUTO_RESUME_WINDOW_MS_ENV]: "abc" }).failureWindowMs).toBe(60 * 60 * 1000);
    expect(readAutoResumeSettings({ [AUTO_RESUME_WINDOW_MS_ENV]: "120000" }).failureWindowMs).toBe(120_000);
    expect(readAutoResumeSettings({ [AUTO_RESUME_INTERVAL_SEC_ENV]: "1" }).intervalSec).toBe(10);
    expect(readAutoResumeSettings({ [AUTO_RESUME_INTERVAL_SEC_ENV]: "300" }).intervalSec).toBe(300);
  });
});

describe("backoffForAttempt", () => {
  it("walks the steps and repeats the last one", () => {
    const backoff = [1000, 5000, 15000];
    expect(backoffForAttempt(backoff, 0)).toBe(1000);
    expect(backoffForAttempt(backoff, 1)).toBe(5000);
    expect(backoffForAttempt(backoff, 2)).toBe(15000);
    expect(backoffForAttempt(backoff, 9)).toBe(15000);
    expect(backoffForAttempt([], 0)).toBe(DEFAULT_AUTO_RESUME_BACKOFF_MS[0]);
  });
});

describe("state codec", () => {
  it("round-trips through metadata and preserves other keys", () => {
    const state: AutoResumeState = {
      failures: 2,
      lastFailureAt: ENTRY.toISOString(),
      nextAttemptAt: at(300_000).toISOString(),
      exhaustedAt: null,
      lastResumeAt: ENTRY.toISOString(),
    };
    const metadata = mergeAutoResumeState({ existing: "keep" }, state);
    expect(metadata.existing).toBe("keep");
    expect(readAutoResumeState(metadata)).toEqual(state);

    const cleared = mergeAutoResumeState(metadata, null);
    expect(cleared.existing).toBe("keep");
    expect(AUTO_RESUME_METADATA_KEY in cleared).toBe(false);
    expect(readAutoResumeState(cleared)).toBeNull();
  });

  it("ignores malformed state", () => {
    expect(readAutoResumeState(null)).toBeNull();
    expect(readAutoResumeState("nope")).toBeNull();
    expect(readAutoResumeState({ [AUTO_RESUME_METADATA_KEY]: { failures: 1 } })).toBeNull();
    expect(readAutoResumeState({ [AUTO_RESUME_METADATA_KEY]: "x" })).toBeNull();
  });

  it("exposes the attention slice", () => {
    expect(readAutoResumeAttentionState({})).toBeNull();
    const metadata = mergeAutoResumeState(null, {
      failures: 3,
      lastFailureAt: ENTRY.toISOString(),
      nextAttemptAt: null,
      exhaustedAt: at(1_000).toISOString(),
      lastResumeAt: ENTRY.toISOString(),
    });
    expect(readAutoResumeAttentionState(metadata)).toEqual({
      exhausted: true,
      failures: 3,
      exhaustedAt: at(1_000).toISOString(),
    });
  });
});

describe("decideAutoResume policy", () => {
  it("skips without the gates", () => {
    expect(decide({ settings: { ...SETTINGS, enabled: false } })).toMatchObject({ action: "skip", reason: "disabled" });
    expect(decide({ agent: { status: "idle", updatedAt: ENTRY } })).toMatchObject({ action: "skip", reason: "not_error" });
    expect(decide({ invokable: false })).toMatchObject({ action: "skip", reason: "not_invokable" });
    expect(decide({ underMaintenance: true })).toMatchObject({ action: "skip", reason: "maintenance" });
  });

  it("waits one minute after the error entry, then resumes on the 1/5/15 steps", () => {
    // Before the first step: nothing yet.
    expect(decide({ now: at(59_000) })).toMatchObject({ action: "skip", reason: "not_due" });

    // First attempt at +1 min.
    const first = decide({ now: at(60_000) });
    expect(first.action).toBe("resume");
    expect(first.nextState).toMatchObject({
      failures: 1,
      lastFailureAt: at(60_000).toISOString(),
      nextAttemptAt: at(60_000 + 300_000).toISOString(),
      exhaustedAt: null,
    });

    // Second attempt: 5 min after the first.
    expect(decide({ state: first.nextState, now: at(60_000 + 299_000) })).toMatchObject({ action: "skip", reason: "not_due" });
    const second = decide({ state: first.nextState, now: at(60_000 + 300_000) });
    expect(second.action).toBe("resume");
    expect(second.nextState).toMatchObject({
      failures: 2,
      nextAttemptAt: at(60_000 + 300_000 + 900_000).toISOString(),
    });

    // Third attempt: 15 min after the second.
    const thirdAt = 60_000 + 300_000 + 900_000;
    const third = decide({ state: second.nextState, now: at(thirdAt) });
    expect(third.action).toBe("resume");
    expect(third.nextState).toMatchObject({ failures: 3, exhaustedAt: null });

    // Cap reached: give up immediately, no further wait.
    const exhausted = decide({ state: third.nextState, now: at(thirdAt + 1) });
    expect(exhausted.action).toBe("exhaust");
    expect(exhausted.reason).toBe("max_attempts");
    expect(exhausted.nextState?.exhaustedAt).toBe(at(thirdAt + 1).toISOString());
    expect(exhausted.nextState?.failures).toBe(3);

    // And it stays given up.
    expect(decide({ state: exhausted.nextState, now: at(thirdAt + 60 * 60 * 1000) })).toMatchObject({
      action: "skip",
      reason: "exhausted",
    });
  });

  it("honours a custom attempt cap", () => {
    const settings: AutoResumeSettings = { ...SETTINGS, maxAttempts: 1 };
    const first = decide({ settings, now: at(60_000) });
    expect(first.action).toBe("resume");
    expect(decide({ settings, state: first.nextState, now: at(120_000) })).toMatchObject({ action: "exhaust" });
  });

  it("re-arms when the agent record changed after the give-up point (operator acted)", () => {
    const exhausted: AutoResumeState = {
      failures: 3,
      lastFailureAt: at(60_000).toISOString(),
      nextAttemptAt: null,
      exhaustedAt: at(1_200_000).toISOString(),
      lastResumeAt: at(60_000).toISOString(),
    };
    // The record is older than the give-up: still given up.
    expect(decide({ state: exhausted, now: at(1_300_000) })).toMatchObject({ action: "skip", reason: "exhausted" });

    // The operator resumed/re-ran the agent afterwards: a new episode.
    const rearmed = decide({
      state: exhausted,
      now: at(3_600_000),
      agent: { status: "error", updatedAt: at(3_000_000) },
    });
    expect(rearmed.action).toBe("resume");
    expect(rearmed.nextState).toMatchObject({ failures: 1, exhaustedAt: null });
  });

  it("drops a streak whose last failure is older than the window", () => {
    const stale: AutoResumeState = {
      failures: 2,
      lastFailureAt: at(0).toISOString(),
      nextAttemptAt: at(300_000).toISOString(),
      exhaustedAt: null,
      lastResumeAt: at(0).toISOString(),
    };
    // Inside the window the streak continues (the cap is not reset).
    expect(decide({ state: stale, now: at(900_000) })).toMatchObject({ action: "resume" });
    // Past the window it is a fresh episode: failures start at one again.
    const fresh = decide({ state: stale, now: at(60 * 60 * 1000 + 1) });
    expect(fresh.action).toBe("resume");
    expect(fresh.nextState?.failures).toBe(1);
  });

  it("never resumes a non-error agent even with a due state", () => {
    const due: AutoResumeState = {
      failures: 1,
      lastFailureAt: at(0).toISOString(),
      nextAttemptAt: at(300_000).toISOString(),
      exhaustedAt: null,
      lastResumeAt: at(0).toISOString(),
    };
    expect(decide({ state: due, agent: { status: "idle", updatedAt: ENTRY }, now: at(600_000) })).toMatchObject({
      action: "skip",
      reason: "not_error",
    });
  });
});