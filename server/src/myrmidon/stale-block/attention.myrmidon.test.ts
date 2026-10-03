// myrmidon(STALE-BLOCK): the lifted-block signal registry — pure, no database.

import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_STALE_BLOCK_SIGNAL_TTL_MS,
  readStaleBlockSignals,
  recordStaleBlockSignal,
  resetStaleBlockSignals,
  staleBlockSignalDedupKey,
  staleBlockSignalSeverity,
  staleBlockSignalWhyNow,
  type StaleBlockSignal,
} from "./attention.js";

const COMPANY = "b7d0a7b2-1111-4222-8333-444455556666";
const ISSUE = "0f1e2d3c-4b5a-4f6e-8a7b-9c0d1e2f3a4b";

function signal(overrides: Partial<StaleBlockSignal> = {}): StaleBlockSignal {
  return {
    issueId: ISSUE,
    companyId: COMPANY,
    identifier: "SB-1",
    title: "Task a",
    reasonTexts: ["the blocking task is done"],
    liftedAt: "2026-10-03T12:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  resetStaleBlockSignals();
});

describe("stale block signal registry", () => {
  it("records and reads one signal per company", () => {
    recordStaleBlockSignal(signal());
    expect(readStaleBlockSignals(COMPANY)).toHaveLength(1);
    expect(readStaleBlockSignals(COMPANY)[0]!.issueId).toBe(ISSUE);
  });

  it("is company-scoped: another company reads nothing", () => {
    recordStaleBlockSignal(signal());
    expect(readStaleBlockSignals("99999999-9999-4999-8999-999999999999")).toEqual([]);
  });

  it("re-recording the same issue replaces the signal (one card per task)", () => {
    recordStaleBlockSignal(signal());
    recordStaleBlockSignal(signal({ liftedAt: "2026-10-03T13:00:00.000Z" }));
    const signals = readStaleBlockSignals(COMPANY);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.liftedAt).toBe("2026-10-03T13:00:00.000Z");
  });

  it("expires a signal after the TTL and keeps a fresh one", () => {
    const now = new Date("2026-10-03T12:00:00.000Z");
    recordStaleBlockSignal(signal(), now);
    const afterTtl = new Date(now.getTime() + DEFAULT_STALE_BLOCK_SIGNAL_TTL_MS + 1);
    expect(readStaleBlockSignals(COMPANY, afterTtl)).toEqual([]);

    recordStaleBlockSignal(signal(), now);
    const insideTtl = new Date(now.getTime() + DEFAULT_STALE_BLOCK_SIGNAL_TTL_MS - 1);
    expect(readStaleBlockSignals(COMPANY, insideTtl)).toHaveLength(1);
  });

  it("honors a custom TTL from the env", () => {
    const recordedAt = new Date("2026-10-03T12:00:00.000Z");
    const justAfter = new Date("2026-10-03T12:00:01.000Z");
    recordStaleBlockSignal(signal(), recordedAt);
    // Reading prunes an expired signal; re-record before the longer-TTL read.
    expect(readStaleBlockSignals(COMPANY, justAfter, { MYRMIDON_STALE_BLOCK_SIGNAL_TTL_MS: "500" })).toEqual([]);
    recordStaleBlockSignal(signal(), recordedAt);
    expect(readStaleBlockSignals(COMPANY, justAfter, { MYRMIDON_STALE_BLOCK_SIGNAL_TTL_MS: "60000" })).toHaveLength(1);
  });

  it("the dedup key is stable per task and lift", () => {
    expect(staleBlockSignalDedupKey(signal())).toBe(`stale_block:${ISSUE}:2026-10-03T12:00:00.000Z`);
    expect(staleBlockSignalDedupKey(signal({ liftedAt: "2026-10-03T13:00:00.000Z" })))
      .not.toBe(staleBlockSignalDedupKey(signal()));
  });

  it("the why-now line names the reason and the return to in_progress", () => {
    const text = staleBlockSignalWhyNow(signal({ reasonTexts: ["the blocking task is cancelled"] }));
    expect(text).toContain("the blocking task is cancelled");
    expect(text).toContain("in_progress");
  });

  it("severity is medium: visible, not alarming", () => {
    expect(staleBlockSignalSeverity()).toBe("medium");
  });
});