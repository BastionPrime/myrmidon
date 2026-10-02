// myrmidon(TRACING-HEALTH part D): tests for the operator signal — the
// state-to-severity mapping, the dedup-by-state registry, the sweep's
// transition journal, and the attention feed card. Part C's report shape is
// the frozen contract; these tests never touch the network or a database.

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { TracingHealthReport } from "./domain.js";
import {
  readTracingHealthAttentionSignal,
  recordTracingHealthSignal,
  resetTracingHealthSignals,
  severityForState,
  TRACING_ATTENTION_DEDUP_KEY,
  tracingAttentionSignalForReport,
  whyNowForReport,
} from "./attention.js";
import {
  createTracingAttentionSweeper,
  readTracingSignalSweepIntervalMs,
  TRACING_SWEEP_INTERVAL_SEC_ENV,
} from "./attention-sweep.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-10-02T12:00:00.000Z";

function report(overrides: Partial<TracingHealthReport> = {}): TracingHealthReport {
  return {
    enabled: true,
    state: "ok",
    checkedAt: NOW,
    window: { from: "2026-10-02T11:45:00.000Z", to: NOW },
    evidence: {
      eventsInWindow: 28,
      gatewayRequestsInWindow: 30,
      callbackErrorRate: 0,
      deliveryRatio: 28 / 30,
      legacyRejections: 0,
    },
    reason: "tracing events are flowing while the gateway serves traffic",
    ...overrides,
  };
}

beforeEach(() => {
  resetTracingHealthSignals();
});

describe("myrmidon(TRACING-HEALTH D) severity and signal", () => {
  it("maps degraded to high, unknown to medium, ok/idle to none", () => {
    expect(severityForState("degraded")).toBe("high");
    expect(severityForState("unknown")).toBe("medium");
    expect(severityForState("ok")).toBeNull();
    expect(severityForState("idle")).toBeNull();
  });

  it("builds a signal for degraded and unknown, none for ok/idle/disabled", () => {
    const degraded = tracingAttentionSignalForReport(
      report({ state: "degraded", reason: "the gateway served traffic but no tracing events landed in the window" }),
    );
    expect(degraded).not.toBeNull();
    expect(degraded!.dedupKey).toBe(TRACING_ATTENTION_DEDUP_KEY);
    expect(degraded!.severity).toBe("high");
    expect(degraded!.whyNow).toContain("operator");
    expect(degraded!.activityAt).toBe(NOW);

    const unknown = tracingAttentionSignalForReport(
      report({ state: "unknown", reason: "the ClickHouse events probe failed" }),
    );
    expect(unknown!.severity).toBe("medium");
    expect(whyNowForReport(report({ state: "unknown", reason: "probe failed" }))).toContain("MYRMIDON_TRACING");

    expect(tracingAttentionSignalForReport(report())).toBeNull();
    expect(tracingAttentionSignalForReport(report({ state: "idle" }))).toBeNull();
    expect(tracingAttentionSignalForReport(report({ enabled: false, state: "unknown" }))).toBeNull();
  });
});

describe("myrmidon(TRACING-HEALTH D) registry dedup by state", () => {
  it("records one signal, stable dedupKey, and clears when the report turns ok", () => {
    recordTracingHealthSignal(COMPANY, report({ state: "degraded", reason: "no events" }));
    const first = readTracingHealthAttentionSignal(COMPANY);
    expect(first).not.toBeNull();
    expect(first!.dedupKey).toBe(TRACING_ATTENTION_DEDUP_KEY);
    expect(first!.state).toBe("degraded");

    // Still degraded: same signal object shape (one card, not a second).
    recordTracingHealthSignal(COMPANY, report({ state: "degraded", reason: "still no events" }));
    expect(readTracingHealthAttentionSignal(COMPANY)!.dedupKey).toBe(TRACING_ATTENTION_DEDUP_KEY);

    // Recovery: the card disappears without dismissal bookkeeping.
    recordTracingHealthSignal(COMPANY, report());
    expect(readTracingHealthAttentionSignal(COMPANY)).toBeNull();
  });

  it("keeps companies separate", () => {
    recordTracingHealthSignal(COMPANY, report({ state: "degraded" }));
    recordTracingHealthSignal("99999999-9999-4999-8999-999999999999", report());
    expect(readTracingHealthAttentionSignal(COMPANY)).not.toBeNull();
    expect(readTracingHealthAttentionSignal("99999999-9999-4999-8999-999999999999")).toBeNull();
  });
});

describe("myrmidon(TRACING-HEALTH D) sweep", () => {
  it("sweeps companies, records signals, and writes one activity row per TRANSITION", async () => {
    const writes: Array<{ companyId: string; state: string; severity: string | null; reason: string | null }> = [];
    let state: "ok" | "degraded" = "ok";
    const sweeper = createTracingAttentionSweeper(
      {
        report: async () => report({ state, reason: state === "degraded" ? "no events" : "flowing" }),
        listCompanyIds: async () => [COMPANY],
        writeActivity: async (input) => {
          writes.push({ companyId: input.companyId, state: input.state, severity: input.severity, reason: input.reason });
        },
        log: { warn: () => {}, error: () => {} },
      },
      60_000,
    );

    // First sweep: ok state, no signal, one "none" transition row (baseline).
    const first = await sweeper.sweep();
    expect(first).toEqual({ companies: 1, signals: 0, transitions: 1 });
    expect(readTracingHealthAttentionSignal(COMPANY)).toBeNull();

    // The incident: state degrades — a signal appears and a transition is written.
    state = "degraded";
    const second = await sweeper.sweep();
    expect(second.signals).toBe(1);
    expect(second.transitions).toBe(1);
    expect(readTracingHealthAttentionSignal(COMPANY)?.severity).toBe("high");

    // Steady red: the signal stays, but NO new journal row (no spam).
    const third = await sweeper.sweep();
    expect(third.signals).toBe(1);
    expect(third.transitions).toBe(0);

    // Recovery: one more transition row (the recorded state clears to
    // "none" — no signal), and the signal registry empties.
    state = "ok";
    const fourth = await sweeper.sweep();
    expect(fourth.signals).toBe(0);
    expect(fourth.transitions).toBe(1);
    expect(readTracingHealthAttentionSignal(COMPANY)).toBeNull();

    expect(writes.map((w) => w.state)).toEqual(["none", "degraded", "none"]);
    expect(writes[1]!.severity).toBe("high");
    expect(writes[1]!.reason).toBe("no events");
    sweeper.stop();
  });

  it("one company's probe failure does not stop the others", async () => {
    const seen: string[] = [];
    const sweeper = createTracingAttentionSweeper(
      {
        report: async (companyId) => {
          seen.push(companyId);
          if (companyId === COMPANY) throw new Error("probe unreachable");
          return report({ state: "degraded" });
        },
        listCompanyIds: async () => [COMPANY, "99999999-9999-4999-8999-999999999999"],
        writeActivity: async () => {},
        log: { warn: () => {}, error: () => {} },
      },
      60_000,
    );
    const result = await sweeper.sweep();
    expect(seen).toHaveLength(2);
    expect(result.signals).toBe(1);
    expect(readTracingHealthAttentionSignal("99999999-9999-4999-8999-999999999999")).not.toBeNull();
    sweeper.stop();
  });

  it("clamps the sweep interval back to the default on invalid input", () => {
    expect(readTracingSignalSweepIntervalMs({})).toBe(300_000);
    expect(readTracingSignalSweepIntervalMs({ [TRACING_SWEEP_INTERVAL_SEC_ENV]: "10" })).toBe(300_000);
    expect(readTracingSignalSweepIntervalMs({ [TRACING_SWEEP_INTERVAL_SEC_ENV]: "120" })).toBe(120_000);
  });
});
