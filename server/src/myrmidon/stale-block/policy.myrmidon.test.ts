// myrmidon(STALE-BLOCK): settings + reason + policy unit tests. No database:
// everything here is a pure function.

import { describe, expect, it } from "vitest";
import { readReasonRef } from "./reason.js";
import {
  collectStaleBlockReasons,
  describeStaleBlockReason,
  judgeStaleBlockReason,
  type StaleBlockReason,
} from "./policy.js";
import {
  DEFAULT_STALE_BLOCK_INTERVAL_SEC,
  readStaleBlockEnabled,
  readStaleBlockSettings,
} from "./settings.js";

const NOW = new Date("2026-10-03T12:00:00.000Z");

function reason(overrides: Partial<StaleBlockReason> = {}): StaleBlockReason {
  return { kind: "issue", issueId: "blocker-1", eventKey: null, dueAt: null, ...overrides };
}

describe("stale block settings (MYRMIDON_STALE_BLOCK_*)", () => {
  it("defaults to disabled with a 300 s interval", () => {
    expect(readStaleBlockEnabled({})).toBe(false);
    expect(DEFAULT_STALE_BLOCK_INTERVAL_SEC).toBe(300);
    expect(readStaleBlockSettings({})).toMatchObject({ enabled: false, intervalMs: 300_000 });
  });

  it("only explicit on values enable the sweep; a typo stays off (opt-in feature)", () => {
    for (const value of [undefined, "", "  ", "0", "false", "off", "no", "case", "maybe"]) {
      expect(readStaleBlockEnabled({ MYRMIDON_STALE_BLOCK_ENABLED: value as string }), JSON.stringify(value)).toBe(false);
    }
    for (const value of ["1", "true", "yes", "on"]) {
      expect(readStaleBlockEnabled({ MYRMIDON_STALE_BLOCK_ENABLED: value })).toBe(true);
    }
  });

  it("reads the interval with range clamping and fallback", () => {
    expect(readStaleBlockSettings({ MYRMIDON_STALE_BLOCK_INTERVAL_SEC: "60" }).intervalMs).toBe(60_000);
    expect(readStaleBlockSettings({ MYRMIDON_STALE_BLOCK_INTERVAL_SEC: "5" }).intervalMs).toBe(300_000);
    expect(readStaleBlockSettings({ MYRMIDON_STALE_BLOCK_INTERVAL_SEC: "10m" }).intervalMs).toBe(300_000);
    expect(readStaleBlockSettings({ MYRMIDON_STALE_BLOCK_INTERVAL_SEC: "-1" }).intervalMs).toBe(300_000);
  });
});

describe("readReasonRef (part A contract, structural read)", () => {
  it("reads a valid reasonRef of each kind", () => {
    expect(readReasonRef({ reasonRef: { kind: "issue", issueId: "b-1" } })).toEqual({ kind: "issue", issueId: "b-1" });
    expect(readReasonRef({ reasonRef: { kind: "event", eventKey: "gate-a" } })).toEqual({ kind: "event", eventKey: "gate-a" });
    expect(readReasonRef({ reasonRef: { kind: "date", dueAt: "2026-10-01T00:00:00.000Z" } })).toEqual({
      kind: "date",
      dueAt: "2026-10-01T00:00:00.000Z",
    });
  });

  it("null on anything malformed or absent", () => {
    expect(readReasonRef(null)).toBeNull();
    expect(readReasonRef({})).toBeNull();
    expect(readReasonRef({ reasonRef: null })).toBeNull();
    expect(readReasonRef({ reasonRef: "issue" })).toBeNull();
    expect(readReasonRef({ reasonRef: { kind: "weird" } })).toBeNull();
    expect(readReasonRef({ reasonRef: { kind: "issue", issueId: 7 } })).toEqual({ kind: "issue" });
  });
});

describe("judgeStaleBlockReason", () => {
  it("a done blocker is dead", () => {
    expect(judgeStaleBlockReason(reason(), { blockerStatus: "done", eventStillSet: false, now: NOW }))
      .toEqual({ kind: "dead", why: "blocker_done" });
  });

  it("a cancelled blocker is dead — it never wakes issue_blockers_resolved", () => {
    expect(judgeStaleBlockReason(reason(), { blockerStatus: "cancelled", eventStillSet: false, now: NOW }))
      .toEqual({ kind: "dead", why: "blocker_cancelled" });
  });

  it("an open blocker is live, and a gone blocker row is live (cannot judge)", () => {
    expect(judgeStaleBlockReason(reason(), { blockerStatus: "in_progress", eventStillSet: false, now: NOW }))
      .toEqual({ kind: "live" });
    expect(judgeStaleBlockReason(reason(), { blockerStatus: null, eventStillSet: false, now: NOW }))
      .toEqual({ kind: "live" });
  });

  it("a due date that passed is dead; a future one is live", () => {
    const past = reason({ kind: "date", issueId: null, dueAt: "2026-10-01T00:00:00.000Z" });
    const future = reason({ kind: "date", issueId: null, dueAt: "2026-10-05T00:00:00.000Z" });
    expect(judgeStaleBlockReason(past, { blockerStatus: null, eventStillSet: false, now: NOW }))
      .toEqual({ kind: "dead", why: "due_at_passed" });
    expect(judgeStaleBlockReason(future, { blockerStatus: null, eventStillSet: false, now: NOW }))
      .toEqual({ kind: "live" });
  });

  it("a cleared event is dead; a still-set event is live", () => {
    const event = reason({ kind: "event", issueId: null, eventKey: "gate-a" });
    expect(judgeStaleBlockReason(event, { blockerStatus: null, eventStillSet: false, now: NOW }))
      .toEqual({ kind: "dead", why: "event_cleared" });
    expect(judgeStaleBlockReason(event, { blockerStatus: null, eventStillSet: true, now: NOW }))
      .toEqual({ kind: "live" });
  });
});

describe("collectStaleBlockReasons", () => {
  it("reasonRef wins; blockedByIssueIds are the fallback reason set", () => {
    expect(collectStaleBlockReasons({ reasonRef: null, blockedByIssueIds: ["b-1", "b-2"] })).toEqual([
      { kind: "issue", issueId: "b-1", eventKey: null, dueAt: null },
      { kind: "issue", issueId: "b-2", eventKey: null, dueAt: null },
    ]);
    expect(collectStaleBlockReasons({ reasonRef: { kind: "date", dueAt: "2026-10-01T00:00:00.000Z" }, blockedByIssueIds: ["b-1"] })).toEqual([
      { kind: "date", issueId: null, eventKey: null, dueAt: "2026-10-01T00:00:00.000Z" },
    ]);
    expect(collectStaleBlockReasons({ reasonRef: null, blockedByIssueIds: [] })).toEqual([]);
  });
});

describe("describeStaleBlockReason", () => {
  it("stable text per dead-cause", () => {
    expect(describeStaleBlockReason("blocker_done")).toBe("the blocking task is done");
    expect(describeStaleBlockReason("blocker_cancelled")).toBe("the blocking task is cancelled");
    expect(describeStaleBlockReason("due_at_passed")).toBe("the due date passed");
    expect(describeStaleBlockReason("event_cleared")).toBe("the gate or event no longer applies");
  });
});
