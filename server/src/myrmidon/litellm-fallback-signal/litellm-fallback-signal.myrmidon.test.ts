import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  cardModelSet,
  fallbackDedupKey,
  fallbackShares,
  fallbackSignalForShare,
  fallbackWhyNow,
  readFallbackSignalSettings,
  readModelFallbackSignals,
  recordModelFallbackSignals,
  resetModelFallbackSignals,
  shareClearsSignal,
  shareTripsSignal,
  type FallbackCall,
  type FallbackShare,
} from "./attention.js";
import {
  sweepModelFallbackSignals,
  type FallbackSweepDeps,
} from "./sweep.js";
import { gatewayKeyHash, type SpendLogEntry } from "../litellm-costs/litellm-costs.js";

// Neutral ids only: agent-a, example.com, no real keys or hosts.

const KEY_A = "sk-tes...gent-a";
const KEY_B = "sk-tes...gent-b";
const AGENT_A = "agent-a";
const AGENT_B = "agent-b";
const COMPANY = "company-a";

const CARD_A = {
  model: "model-primary",
  models: { vision: "model-vision", fallbacks: ["model-fb-1"] },
};

const CARD_EMPTY = {};

function entry(overrides: Partial<SpendLogEntry> = {}): SpendLogEntry {
  return {
    requestId: "req-1",
    apiKey: gatewayKeyHash(KEY_A),
    spend: 0.01,
    promptTokens: 100,
    completionTokens: 50,
    startTime: "2026-10-03T10:05:00.000Z",
    model: "model-primary",
    provider: "openai",
    ...overrides,
  };
}

function share(overrides: Partial<FallbackShare> = {}): FallbackShare {
  return {
    agentId: AGENT_A,
    total: 100,
    fallbacks: 30,
    sharePct: 30,
    servedModels: ["model-other"],
    ...overrides,
  };
}

const SETTINGS = readFallbackSignalSettings({ MYRMIDON_MODEL_FALLBACK_ENABLED: "1" });

function deps(entries: SpendLogEntry[], cards = new Map<string, Record<string, unknown>>([
  [AGENT_A, CARD_A],
  [AGENT_B, CARD_A],
])): FallbackSweepDeps {
  return {
    async listSpendLogs() {
      return entries;
    },
    async listBotKeys() {
      return [
        { agentId: AGENT_A, keyValue: KEY_A },
        { agentId: AGENT_B, keyValue: KEY_B },
      ];
    },
    async readGatewayKey() {
      return null; // never read in tests: the client is mocked
    },
    async listAgentCards(companyId: string) {
      if (companyId !== COMPANY) return [];
      return [...cards.entries()].map(([agentId, adapterConfig]) => ({ agentId, adapterConfig }));
    },
    async listCompanyIds() {
      return [COMPANY];
    },
    now: () => new Date("2026-10-03T11:00:00.000Z"),
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

beforeEach(() => {
  resetModelFallbackSignals();
});

afterEach(() => {
  resetModelFallbackSignals();
});

describe("myrmidon(BOT-RUNTIME-TUNING D) settings", () => {
  it("is disabled by default and enabled only by an explicit switch", () => {
    expect(readFallbackSignalSettings({}).enabled).toBe(false);
    expect(readFallbackSignalSettings({ MYRMIDON_MODEL_FALLBACK_ENABLED: "0" }).enabled).toBe(false);
    expect(readFallbackSignalSettings({ MYRMIDON_MODEL_FALLBACK_ENABLED: "1" }).enabled).toBe(true);
    expect(readFallbackSignalSettings({ MYRMIDON_MODEL_FALLBACK_ENABLED: "true" }).enabled).toBe(true);
  });

  it("has the briefed defaults: 1h window, 20% threshold, 20 min calls, 5 min sweep", () => {
    expect(SETTINGS).toMatchObject({
      windowMs: 3_600_000,
      thresholdPct: 20,
      minCalls: 20,
      intervalMs: 300_000,
    });
  });

  it("clamps overrides into range", () => {
    const s = readFallbackSignalSettings({
      MYRMIDON_MODEL_FALLBACK_ENABLED: "1",
      MYRMIDON_MODEL_FALLBACK_THRESHOLD_PCT: "0",
      MYRMIDON_MODEL_FALLBACK_MIN_CALLS: "-5",
      MYRMIDON_MODEL_FALLBACK_WINDOW_SEC: "1",
      MYRMIDON_MODEL_FALLBACK_INTERVAL_SEC: "not-a-number",
    });
    expect(s.thresholdPct).toBe(1);
    expect(s.minCalls).toBe(1);
    expect(s.windowMs).toBe(300_000);
    expect(s.intervalMs).toBe(300_000);
  });
});

describe("myrmidon(BOT-RUNTIME-TUNING D) card model set", () => {
  it("collects the primary, auxiliary and fallback models, dropping default/auto", () => {
    const models = cardModelSet({
      model: " model-primary ",
      models: { vision: "model-vision", video: "auto", stt: "default", fallbacks: ["model-fb-1", " "] },
    });
    expect([...models].sort()).toEqual(["model-fb-1", "model-primary", "model-vision"]);
  });

  it("is empty for a card without model names", () => {
    expect(cardModelSet(CARD_EMPTY).size).toBe(0);
    expect(cardModelSet(null).size).toBe(0);
  });
});

describe("myrmidon(BOT-RUNTIME-TUNING D) fallback share", () => {
  const sets = new Map([[AGENT_A, cardModelSet(CARD_A)]]);

  function calls(spec: string[]): FallbackCall[] {
    // spec: "k" = in-card model, "o" = other model
    return spec.map((kind) => ({
      agentId: AGENT_A,
      model: kind === "k" ? "model-primary" : "model-other",
      startTime: "2026-10-03T10:05:00.000Z",
    }));
  }

  it("counts only out-of-card models as fallbacks", () => {
    const shares = fallbackShares(calls(["k", "k", "o", "o"]), sets);
    expect(shares).toHaveLength(1);
    expect(shares[0]).toMatchObject({ agentId: AGENT_A, total: 4, fallbacks: 2, sharePct: 50 });
    expect(shares[0].servedModels).toEqual(["model-other"]);
  });

  it("ignores an agent whose card decides (no model names)", () => {
    const shares = fallbackShares(calls(["o", "o"]), new Map([[AGENT_A, cardModelSet(CARD_EMPTY)]]));
    expect(shares).toHaveLength(0);
  });
});

describe("myrmidon(BOT-RUNTIME-TUNING D) entry/exit", () => {
  it("trips at or above the threshold once min calls are met", () => {
    expect(shareTripsSignal(share({ sharePct: 20, total: 20, fallbacks: 4 }), SETTINGS)).toBe(true);
    expect(shareTripsSignal(share({ sharePct: 19, total: 20, fallbacks: 4 }), SETTINGS)).toBe(false);
  });

  it("does not trip below min calls even at 100%", () => {
    expect(shareTripsSignal(share({ sharePct: 100, total: 2, fallbacks: 2 }), SETTINGS)).toBe(false);
  });

  it("clears only below half the threshold (hysteresis)", () => {
    expect(shareClearsSignal(share({ sharePct: 9, total: 50, fallbacks: 5 }), SETTINGS)).toBe(true);
    expect(shareClearsSignal(share({ sharePct: 10, total: 50, fallbacks: 5 }), SETTINGS)).toBe(false);
    expect(shareClearsSignal(share({ sharePct: 19, total: 50, fallbacks: 10 }), SETTINGS)).toBe(false);
    expect(shareClearsSignal(share({ total: 2, fallbacks: 0, sharePct: 0 }), SETTINGS)).toBe(true);
  });

  it("describes the share with the threshold and the served models", () => {
    const text = fallbackWhyNow(share({ total: 40, fallbacks: 10, sharePct: 25, servedModels: ["m-b", "m-a", "m-c", "m-d", "m-e"] }), SETTINGS);
    expect(text).toContain("25% of this bot's 40 gateway calls");
    expect(text).toContain("(threshold 20%)");
    expect(text).toContain("m-b, m-a, m-c (+2 more)");
  });

  it("builds a medium severity signal with a stable per-agent dedup key", () => {
    const signal = fallbackSignalForShare(share(), SETTINGS, "2026-10-03T11:00:00.000Z");
    expect(signal.severity).toBe("medium");
    expect(signal.dedupKey).toBe(fallbackDedupKey(AGENT_A));
    expect(signal.agentId).toBe(AGENT_A);
    expect(signal.whyNow).toContain("30% of this bot's 100 gateway calls");
  });
});

describe("myrmidon(BOT-RUNTIME-TUNING D) sweep", () => {
  it("raises one attention item when more than N% of the calls are fallbacks", async () => {
    const entries = [
      ...Array.from({ length: 15 }, (_, i) => entry({ requestId: `req-k-${i}`, model: "model-primary" })),
      ...Array.from({ length: 6 }, (_, i) => entry({ requestId: `req-o-${i}`, model: "model-swapped" })),
    ];
    const result = await sweepModelFallbackSignals(deps(entries), SETTINGS);
    expect(result.signals).toBe(1);
    const signals = readModelFallbackSignals(COMPANY);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      agentId: AGENT_A,
      sharePct: 29,
      fallbacks: 6,
      total: 21,
      severity: "medium",
    });
    expect(signals[0].servedModels).toEqual(["model-swapped"]);
  });

  it("raises no item when the fallback share is below the threshold", async () => {
    const entries = [
      ...Array.from({ length: 19 }, (_, i) => entry({ requestId: `req-k-${i}`, model: "model-primary" })),
      ...Array.from({ length: 4 }, (_, i) => entry({ requestId: `req-o-${i}`, model: "model-swapped" })),
    ];
    const result = await sweepModelFallbackSignals(deps(entries), SETTINGS);
    expect(result.signals).toBe(0);
    expect(readModelFallbackSignals(COMPANY)).toHaveLength(0);
  });

  it("raises no item below min calls (no signal on 2 calls)", async () => {
    const entries = [
      entry({ requestId: "req-k-1", model: "model-primary" }),
      entry({ requestId: "req-o-1", model: "model-swapped" }),
      entry({ requestId: "req-o-2", model: "model-swapped" }),
    ];
    const result = await sweepModelFallbackSignals(deps(entries), SETTINGS);
    expect(result.signals).toBe(0);
  });

  it("dedups by agent: two agents, one signal each", async () => {
    const entries = [
      // agent A: 10 of 25 calls off-card (40%) — trips
      ...Array.from({ length: 15 }, (_, i) => entry({ requestId: `req-a-${i}`, model: "model-primary" })),
      ...Array.from({ length: 10 }, (_, i) => entry({ requestId: `req-a-o-${i}`, model: "model-swapped" })),
      // agent B: 10 of 35 calls off-card (29%) — trips
      ...Array.from({ length: 25 }, (_, i) => entry({ requestId: `req-b-${i}`, apiKey: gatewayKeyHash(KEY_B), model: "model-primary" })),
      ...Array.from({ length: 10 }, (_, i) => entry({ requestId: `req-b-o-${i}`, apiKey: gatewayKeyHash(KEY_B), model: "model-swapped" })),
    ];
    const result = await sweepModelFallbackSignals(deps(entries), SETTINGS);
    expect(result.signals).toBe(2);
    const signals = readModelFallbackSignals(COMPANY).sort((a, b) => a.agentId.localeCompare(b.agentId));
    expect(signals.map((s) => s.agentId)).toEqual([AGENT_A, AGENT_B]);
  });

  it("exits: a healthy re-sweep replaces the signals and clears the agent", async () => {
    const bad = [
      ...Array.from({ length: 15 }, (_, i) => entry({ requestId: `req-k-${i}`, model: "model-primary" })),
      ...Array.from({ length: 10 }, (_, i) => entry({ requestId: `req-o-${i}`, model: "model-swapped" })),
    ];
    await sweepModelFallbackSignals(deps(bad), SETTINGS);
    expect(readModelFallbackSignals(COMPANY)).toHaveLength(1);

    // Share drops below N/2 (10%): 5 fallbacks of 40 = 12.5% -> no. Use 2 of 40 = 5%.
    const good = [
      ...Array.from({ length: 38 }, (_, i) => entry({ requestId: `req-k2-${i}`, model: "model-primary" })),
      ...Array.from({ length: 2 }, (_, i) => entry({ requestId: `req-o2-${i}`, model: "model-swapped" })),
    ];
    await sweepModelFallbackSignals(deps(good), SETTINGS);
    expect(readModelFallbackSignals(COMPANY)).toHaveLength(0);
  });

  it("leaves spend rows of unknown keys unattributed (no signal)", async () => {
    const entries = [
      ...Array.from({ length: 15 }, (_, i) => entry({ requestId: `req-x-${i}`, apiKey: gatewayKeyHash("sk-tes...unknown"), model: "model-swapped" })),
    ];
    const result = await sweepModelFallbackSignals(deps(entries), SETTINGS);
    expect(result.signals).toBe(0);
  });

  it("keeps sweeping when one company throws", async () => {
    const failing: FallbackSweepDeps = {
      ...deps([]),
      async listCompanyIds() {
        return ["company-broken", COMPANY];
      },
      async listSpendLogs(companyId) {
        if (companyId === "company-broken") throw new Error("gateway unreachable");
        return [
          ...Array.from({ length: 15 }, (_, i) => entry({ requestId: `req-k-${i}`, model: "model-primary" })),
          ...Array.from({ length: 10 }, (_, i) => entry({ requestId: `req-o-${i}`, model: "model-swapped" })),
        ];
      },
    };
    const result = await sweepModelFallbackSignals(failing, SETTINGS);
    expect(result.companies).toBe(2);
    expect(result.signals).toBe(1);
    expect(readModelFallbackSignals(COMPANY)).toHaveLength(1);
  });
});

describe("myrmidon(BOT-RUNTIME-TUNING D) registry", () => {
  it("records per company and clears on an empty sweep", () => {
    const signal = fallbackSignalForShare(share(), SETTINGS, "2026-10-03T11:00:00.000Z");
    recordModelFallbackSignals(COMPANY, [signal]);
    expect(readModelFallbackSignals(COMPANY)).toHaveLength(1);
    expect(readModelFallbackSignals("company-b")).toHaveLength(0);
    recordModelFallbackSignals(COMPANY, []);
    expect(readModelFallbackSignals(COMPANY)).toHaveLength(0);
  });
});
