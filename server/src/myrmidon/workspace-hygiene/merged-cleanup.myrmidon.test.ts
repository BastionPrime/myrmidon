import { describe, expect, it } from "vitest";
import {
  DEFAULT_MERGED_WORKSPACE_COOLDOWN_MS,
  DEFAULT_STUCK_WORKSPACE_SIGNAL_AFTER_MS,
  STUCK_WORKSPACE_SIGNAL_REPEAT_MS,
  WORKSPACE_STUCK_SIGNAL_METADATA_KEY,
  isMergedDeliveryState,
  isWorkspaceStuckLongEnough,
  markWorkspaceStuckSignal,
  readDurationMsFromEnv,
  readMergedWorkspaceCooldownMs,
  readStuckWorkspaceSignalAfterMs,
  readWorkspaceStuckSignalAt,
  resolveWorkspaceReaperCooldownMs,
  shouldEmitWorkspaceStuckSignal,
} from "./merged-cleanup.js";

// WORKSPACE-HYGIENE part B: the reaper logic that picks the cooldown for a
// merged copy and throttles the stuck-copy signal. These tests lock the pure
// rules; the reaper integration tests live in
// server/src/__tests__/workspace-hygiene-merged-cleanup.myrmidon.test.ts.

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

describe("merged copy cooldown", () => {
  it("uses the short merged cooldown for a copy merged via PR", () => {
    expect(resolveWorkspaceReaperCooldownMs({
      deliveryState: "merged_via_pr",
      defaultCooldownMs: SEVEN_DAYS_MS,
      mergedCooldownMs: 30 * 60 * 1000,
    })).toBe(30 * 60 * 1000);
  });

  it("uses the short merged cooldown for a copy merged by ancestry", () => {
    expect(resolveWorkspaceReaperCooldownMs({
      deliveryState: "merged_by_ancestry",
      defaultCooldownMs: SEVEN_DAYS_MS,
      mergedCooldownMs: 30 * 60 * 1000,
    })).toBe(30 * 60 * 1000);
  });

  it.each(["unmerged", "unknown", null, undefined])(
    "keeps the long default cooldown for delivery state %s",
    (deliveryState) => {
      expect(resolveWorkspaceReaperCooldownMs({
        deliveryState,
        defaultCooldownMs: SEVEN_DAYS_MS,
        mergedCooldownMs: 30 * 60 * 1000,
      })).toBe(SEVEN_DAYS_MS);
    },
  );

  it("never turns a negative cooldown into a wait", () => {
    expect(resolveWorkspaceReaperCooldownMs({
      deliveryState: "merged_via_pr",
      defaultCooldownMs: SEVEN_DAYS_MS,
      mergedCooldownMs: -1,
    })).toBe(0);
    expect(resolveWorkspaceReaperCooldownMs({
      deliveryState: "unmerged",
      defaultCooldownMs: -1,
      mergedCooldownMs: 30 * 60 * 1000,
    })).toBe(0);
  });

  it("recognizes only the two merged delivery states", () => {
    expect(isMergedDeliveryState("merged_via_pr")).toBe(true);
    expect(isMergedDeliveryState("merged_by_ancestry")).toBe(true);
    expect(isMergedDeliveryState("unmerged")).toBe(false);
    expect(isMergedDeliveryState("unknown")).toBe(false);
    expect(isMergedDeliveryState(null)).toBe(false);
  });
});

describe("workspace hygiene environment parsing", () => {
  it("defaults the merged cooldown to 30 minutes and the signal wait to 24 hours", () => {
    expect(DEFAULT_MERGED_WORKSPACE_COOLDOWN_MS).toBe(30 * 60 * 1000);
    expect(DEFAULT_STUCK_WORKSPACE_SIGNAL_AFTER_MS).toBe(24 * 60 * 60 * 1000);
    expect(readMergedWorkspaceCooldownMs({})).toBe(30 * 60 * 1000);
    expect(readStuckWorkspaceSignalAfterMs({})).toBe(24 * 60 * 60 * 1000);
  });

  it("reads explicit millisecond values, including 0", () => {
    expect(readMergedWorkspaceCooldownMs({
      MYRMIDON_WORKSPACE_MERGED_COOLDOWN_MS: "0",
    })).toBe(0);
    expect(readMergedWorkspaceCooldownMs({
      MYRMIDON_WORKSPACE_MERGED_COOLDOWN_MS: "  3600000  ",
    })).toBe(3_600_000);
    expect(readStuckWorkspaceSignalAfterMs({
      MYRMIDON_WORKSPACE_STUCK_SIGNAL_AFTER_MS: "172800000",
    })).toBe(172_800_000);
  });

  it.each(["", "   ", "-1", "1.5", "soon", "10m"])(
    "falls back to the default for the invalid value %j",
    (raw) => {
      expect(readDurationMsFromEnv(raw, 42)).toBe(42);
    },
  );
});

describe("stuck-copy signal throttle", () => {
  const nowMs = Date.UTC(2026, 5, 1);

  it("signals a copy with no recorded signal", () => {
    expect(shouldEmitWorkspaceStuckSignal({
      metadata: null,
      nowMs,
      repeatAfterMs: STUCK_WORKSPACE_SIGNAL_REPEAT_MS,
    })).toBe(true);
  });

  it("does not signal again inside the repeat window", () => {
    const metadata = markWorkspaceStuckSignal(null, nowMs - DAY_MS / 2);
    expect(shouldEmitWorkspaceStuckSignal({
      metadata,
      nowMs,
      repeatAfterMs: STUCK_WORKSPACE_SIGNAL_REPEAT_MS,
    })).toBe(false);
  });

  it("signals again once the repeat window has passed", () => {
    const metadata = markWorkspaceStuckSignal(null, nowMs - DAY_MS - 1);
    expect(shouldEmitWorkspaceStuckSignal({
      metadata,
      nowMs,
      repeatAfterMs: STUCK_WORKSPACE_SIGNAL_REPEAT_MS,
    })).toBe(true);
  });

  it("keeps unrelated metadata keys and records the signal as an ISO timestamp", () => {
    const marked = markWorkspaceStuckSignal({ keep: "me" }, nowMs);
    expect(marked).toEqual({
      keep: "me",
      [WORKSPACE_STUCK_SIGNAL_METADATA_KEY]: new Date(nowMs).toISOString(),
    });
    expect(readWorkspaceStuckSignalAt(marked)).toBe(nowMs);
  });

  it("treats a missing or unparsable recorded signal as no signal", () => {
    expect(readWorkspaceStuckSignalAt(null)).toBeNull();
    expect(readWorkspaceStuckSignalAt({ [WORKSPACE_STUCK_SIGNAL_METADATA_KEY]: 12 })).toBeNull();
    expect(readWorkspaceStuckSignalAt({ [WORKSPACE_STUCK_SIGNAL_METADATA_KEY]: "not-a-date" })).toBeNull();
  });
});

describe("stuck-copy age gate", () => {
  const nowMs = Date.UTC(2026, 5, 1);

  it("does not signal before the threshold", () => {
    expect(isWorkspaceStuckLongEnough({
      anchorMs: nowMs - DAY_MS + 1,
      nowMs,
      stuckAfterMs: DAY_MS,
    })).toBe(false);
  });

  it("signals at and past the threshold", () => {
    expect(isWorkspaceStuckLongEnough({
      anchorMs: nowMs - DAY_MS,
      nowMs,
      stuckAfterMs: DAY_MS,
    })).toBe(true);
    expect(isWorkspaceStuckLongEnough({
      anchorMs: nowMs - 2 * DAY_MS,
      nowMs,
      stuckAfterMs: DAY_MS,
    })).toBe(true);
  });

  it("never signals without a terminal anchor", () => {
    expect(isWorkspaceStuckLongEnough({
      anchorMs: null,
      nowMs,
      stuckAfterMs: DAY_MS,
    })).toBe(false);
  });
});