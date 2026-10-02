// @vitest-environment jsdom

// myrmidon(TRACING-HEALTH) UI tests: the "LLM tracing" status card. The view
// is pinned by its testid set: state, evidence numbers (events, gateway
// requests, delivery ratio, callback errors, legacy rejections), the
// not-enabled surface, and the degraded emphasis (the 02.10 incident class:
// degraded tracing must be impossible to miss on the board).

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TracingStatusCardView } from "./TracingStatusCard";
import type { TracingHealthReportView } from "./tracingHealthApi";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

const REPORT: TracingHealthReportView = {
  enabled: true,
  state: "ok",
  checkedAt: "2026-10-02T10:00:00.000Z",
  window: { from: "2026-10-02T09:45:00.000Z", to: "2026-10-02T10:00:00.000Z" },
  evidence: {
    eventsInWindow: 1204,
    gatewayRequestsInWindow: 1500,
    callbackErrorRate: 0.001,
    deliveryRatio: 0.8,
    legacyRejections: 0,
  },
  reason: "tracing events are flowing while the gateway serves traffic",
};

function render(report: TracingHealthReportView | null) {
  flushSync(() => root.render(<TracingStatusCardView report={report} />));
  return container.querySelector('[data-testid="myrmidon-tracing-card"]');
}

describe("TracingStatusCard", () => {
  it("shows the state, the reason and the evidence numbers", () => {
    const card = render(REPORT);
    expect(card).not.toBeNull();
    expect(card!.querySelector('[data-testid="myrmidon-tracing-state"]')!.textContent).toContain("Tracing is flowing");
    expect(card!.textContent).toContain("tracing events are flowing");
    expect(card!.querySelector('[data-testid="myrmidon-tracing-events"]')!.textContent).toBe("1204");
    expect(card!.querySelector('[data-testid="myrmidon-tracing-requests"]')!.textContent).toBe("1500");
    expect(card!.querySelector('[data-testid="myrmidon-tracing-ratio"]')!.textContent).toBe("0.80");
    expect(card!.querySelector('[data-testid="myrmidon-tracing-errors"]')!.textContent).toBe("0.1%");
    expect(card!.querySelector('[data-testid="myrmidon-tracing-rejections"]')!.textContent).toBe("0");
    expect(card!.querySelector('[data-testid="myrmidon-tracing-checked-at"]')!.textContent).toContain("2026-10-02T10:00:00.000Z");
  });

  it("degraded is loud: state line and the incident reason render, not the ok wording", () => {
    const card = render({
      ...REPORT,
      state: "degraded",
      reason: "ingestion rejected legacy-format events in the window",
      evidence: {
        eventsInWindow: 3,
        gatewayRequestsInWindow: 1500,
        callbackErrorRate: 0,
        deliveryRatio: 0.002,
        legacyRejections: 41,
      },
    });
    const state = card!.querySelector('[data-testid="myrmidon-tracing-state"]')!;
    expect(state.textContent).toContain("Tracing is degraded");
    expect(card!.textContent).toContain("ingestion rejected legacy-format events");
    expect(card!.querySelector('[data-testid="myrmidon-tracing-rejections"]')!.textContent).toBe("41");
  });

  it("null evidence renders dashes, not zeros: a failed probe never reads as healthy zero", () => {
    const card = render({
      ...REPORT,
      state: "unknown",
      reason: "the ClickHouse events probe failed",
      evidence: {
        eventsInWindow: null,
        gatewayRequestsInWindow: 1500,
        callbackErrorRate: null,
        deliveryRatio: null,
        legacyRejections: null,
      },
    });
    expect(card!.querySelector('[data-testid="myrmidon-tracing-events"]')!.textContent).toBe("-");
    expect(card!.querySelector('[data-testid="myrmidon-tracing-ratio"]')!.textContent).toBe("-");
    expect(card!.querySelector('[data-testid="myrmidon-tracing-errors"]')!.textContent).toBe("-");
  });

  it("the graceful not-enabled state when the report is absent", () => {
    const card = render(null);
    expect(card!.querySelector('[data-testid="myrmidon-tracing-not-enabled"]')!.textContent)
      .toContain("not configured");
    expect(card!.querySelector('[data-testid="myrmidon-tracing-reason"]')).toBeNull();
  });

  it("idle says quiet, not broken", () => {
    const card = render({
      ...REPORT,
      state: "idle",
      reason: "the gateway served no traffic in the window",
      evidence: {
        eventsInWindow: 0,
        gatewayRequestsInWindow: 0,
        callbackErrorRate: null,
        deliveryRatio: null,
        legacyRejections: null,
      },
    });
    expect(card!.querySelector('[data-testid="myrmidon-tracing-state"]')!.textContent).toContain("No gateway traffic");
  });
});
