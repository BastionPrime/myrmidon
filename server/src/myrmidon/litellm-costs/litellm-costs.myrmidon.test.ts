import { describe, expect, it } from "vitest";

import {
  botKeyIndex,
  collectRows,
  gatewayKeyHash,
  readLitellmCostSettings,
  runWindowFor,
  spendUsdToCents,
  type RunWindow,
  type SpendLogEntry,
} from "./litellm-costs.js";

// Neutral ids only (no real agents, keys or hosts).

const KEY_A = "sk-test-key-agent-a";
const KEY_B = "sk-test-key-agent-b";

function entry(overrides: Partial<SpendLogEntry> = {}): SpendLogEntry {
  return {
    requestId: "req-1",
    apiKey: gatewayKeyHash(KEY_A),
    spend: 0.01,
    promptTokens: 100,
    completionTokens: 50,
    startTime: "2026-09-30T10:05:00.000Z",
    model: "openai/example-model",
    provider: "openai",
    ...overrides,
  };
}

function window(overrides: Partial<RunWindow> = {}): RunWindow {
  return {
    runId: "run-1",
    agentId: "agent-a",
    issueId: "issue-1",
    startedAt: new Date("2026-09-30T10:00:00Z"),
    finishedAt: new Date("2026-09-30T10:10:00Z"),
    ...overrides,
  };
}

describe("myrmidon(M2-A) readLitellmCostSettings", () => {
  it("is disabled without both the base URL and the key secret", () => {
    expect(readLitellmCostSettings({})).toMatchObject({ enabled: false });
    expect(readLitellmCostSettings({ MYRMIDON_LITELLM_BASE_URL: "http://example.com:4000" })).toMatchObject({
      enabled: false,
    });
    expect(readLitellmCostSettings({ MYRMIDON_LITELLM_KEY_SECRET: "gw-key" })).toMatchObject({
      enabled: false,
    });
  });

  it("is enabled with both, with the default interval", () => {
    expect(
      readLitellmCostSettings({ MYRMIDON_LITELLM_BASE_URL: "http://example.com:4000", MYRMIDON_LITELLM_KEY_SECRET: "gw-key" }),
    ).toMatchObject({ enabled: true, baseUrl: "http://example.com:4000", keySecret: "gw-key", intervalMs: 300_000 });
  });

  it("clamps an out-of-range interval back to the default", () => {
    for (const value of ["1", "not-a-number", "99999999"]) {
      expect(
        readLitellmCostSettings({
          MYRMIDON_LITELLM_BASE_URL: "http://example.com:4000",
          MYRMIDON_LITELLM_KEY_SECRET: "gw-key",
          MYRMIDON_LITELLM_COST_INTERVAL_SEC: value,
        }),
      ).toMatchObject({ intervalMs: 300_000 });
    }
    expect(
      readLitellmCostSettings({
        MYRMIDON_LITELLM_BASE_URL: "http://example.com:4000",
        MYRMIDON_LITELLM_KEY_SECRET: "gw-key",
        MYRMIDON_LITELLM_COST_INTERVAL_SEC: "60",
      }),
    ).toMatchObject({ intervalMs: 60_000 });
  });
});

describe("myrmidon(M2-A) attribution", () => {
  it("hashes a bot key the way the gateway ledger stores it", () => {
    // The gateway stores sha256(key); the index is keyed by that hash.
    const index = botKeyIndex([{ agentId: "agent-a", keyValue: KEY_A }]);
    expect(index.get(gatewayKeyHash(KEY_A))).toBe("agent-a");
    expect(index.get(gatewayKeyHash(KEY_B))).toBeUndefined();
  });

  it("collects a row with the run whose window covers the entry", () => {
    const { rows, skippedUnattributed } = collectRows(
      [entry()],
      botKeyIndex([{ agentId: "agent-a", keyValue: KEY_A }]),
      [window()],
    );
    expect(skippedUnattributed).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agentId: "agent-a",
      heartbeatRunId: "run-1",
      issueId: "issue-1",
      model: "openai/example-model",
      inputTokens: 100,
      outputTokens: 50,
      costCents: 1,
    });
  });

  it("leaves the run and issue null when no window covers the entry", () => {
    const { rows } = collectRows(
      [entry()],
      botKeyIndex([{ agentId: "agent-a", keyValue: KEY_A }]),
      [window({ startedAt: new Date("2026-09-30T11:00:00Z"), finishedAt: new Date("2026-09-30T11:10:00Z") })],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].heartbeatRunId).toBeNull();
    expect(rows[0].issueId).toBeNull();
  });

  it("counts entries whose key belongs to no bot as unattributed", () => {
    const { rows, skippedUnattributed } = collectRows(
      [entry(), entry({ apiKey: gatewayKeyHash(KEY_B) }), entry({ apiKey: null })],
      botKeyIndex([{ agentId: "agent-a", keyValue: KEY_A }]),
      [window()],
    );
    expect(rows).toHaveLength(1);
    expect(skippedUnattributed).toBe(2);
  });

  it("drops rows with neither spend nor tokens", () => {
    const { rows } = collectRows(
      [entry({ spend: 0, promptTokens: 0, completionTokens: 0 })],
      botKeyIndex([{ agentId: "agent-a", keyValue: KEY_A }]),
      [],
    );
    expect(rows).toHaveLength(0);
  });

  it("keeps a positive sub-cent spend as one cent, not zero", () => {
    expect(spendUsdToCents(0.004)).toBe(1);
    expect(spendUsdToCents(0)).toBe(0);
    expect(spendUsdToCents(-1)).toBe(0);
    expect(spendUsdToCents(Number.NaN)).toBe(0);
    expect(spendUsdToCents(1.234)).toBe(123);
  });

  it("picks the latest start among overlapping runs", () => {
    const when = new Date("2026-09-30T10:05:00Z");
    const early = window({ runId: "run-early", startedAt: new Date("2026-09-30T10:00:00Z") });
    const late = window({ runId: "run-late", startedAt: new Date("2026-09-30T10:03:00Z") });
    expect(runWindowFor(when, "agent-a", [early, late])?.runId).toBe("run-late");
    // A different agent's window never matches.
    expect(runWindowFor(when, "agent-b", [early, late])).toBeNull();
  });

  it("treats a running run (no finishedAt) as open-ended", () => {
    const when = new Date("2026-09-30T10:05:00Z");
    const open = window({ finishedAt: null });
    expect(runWindowFor(when, "agent-a", [open])?.runId).toBe("run-1");
  });
});
