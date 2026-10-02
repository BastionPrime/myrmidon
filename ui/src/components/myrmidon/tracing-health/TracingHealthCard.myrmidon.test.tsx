// @vitest-environment jsdom
// myrmidon(TRACING-HEALTH part D): tests for the "LLM tracing" status card —
// the states of part C's frozen contract rendered as one glanceable card.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TracingHealthCard, TracingHealthCardView } from "./TracingHealthCard";
import {
  evidenceLines,
  formatWindowLabel,
  stateView,
  type TracingHealthReport,
} from "./tracingHealthApi";

const mockApi = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("@/api/client", () => ({ api: mockApi }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function report(overrides: Partial<TracingHealthReport> = {}): TracingHealthReport {
  return {
    enabled: true,
    state: "ok",
    checkedAt: "2026-10-02T12:00:00.000Z",
    window: { from: "2026-10-02T11:45:00.000Z", to: "2026-10-02T12:00:00.000Z" },
    evidence: {
      eventsInWindow: 28,
      gatewayRequestsInWindow: 30,
      callbackErrorRate: 0,
      deliveryRatio: 0.93,
      legacyRejections: 0,
    },
    reason: "tracing events are flowing while the gateway serves traffic",
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root | null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = null;
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  vi.clearAllMocks();
});

function render(node: React.ReactNode) {
  root = createRoot(container);
  act(() => {
    root?.render(node);
  });
}

describe("stateView and formatters", () => {
  it("maps every state to a dot and a label", () => {
    expect(stateView("ok", true)).toEqual({ dot: "green", label: "ok" });
    expect(stateView("idle", true)).toEqual({ dot: "green", label: "ok (idle)" });
    expect(stateView("degraded", true)).toEqual({ dot: "red", label: "red" });
    expect(stateView("unknown", true)).toEqual({ dot: "red", label: "unknown" });
    expect(stateView("ok", false)).toEqual({ dot: "gray", label: "not enabled" });
  });

  it("labels the window and renders null-aware evidence lines", () => {
    expect(formatWindowLabel(report())).toBe("15 min");
    expect(
      evidenceLines(
        report().evidence,
      ),
    ).toEqual([
      "gateway requests in window: 30",
      "events in window: 28",
      "delivery ratio: 0.93",
      "callback error rate: 0.000",
      "legacy rejections: 0",
    ]);
    expect(evidenceLines(report({ evidence: { eventsInWindow: null, gatewayRequestsInWindow: null, callbackErrorRate: null, deliveryRatio: null, legacyRejections: null } }).evidence)).toEqual([
      "gateway requests: unknown",
      "events: unknown",
      "delivery ratio: unknown",
      "callback error rate: unknown",
      "legacy rejections: unknown",
    ]);
  });
});

describe("TracingHealthCardView", () => {
  it("renders a green ok card with the reason and the evidence lines", () => {
    render(<TracingHealthCardView report={report()} loading={false} error={null} />);
    expect(container.querySelector('[data-testid="myrmidon-tracing-health-card"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="myrmidon-tracing-health-status"]')?.textContent).toContain("ok");
    expect(container.querySelector('[data-testid="myrmidon-tracing-health-reason"]')?.textContent).toContain("flowing");
    expect(container.querySelectorAll('[data-testid="myrmidon-tracing-health-evidence"] li')).toHaveLength(5);
  });

  it("renders a red degraded card (the incident shape)", () => {
    render(
      <TracingHealthCardView
        report={report({
          state: "degraded",
          reason: "the gateway served traffic but no tracing events landed in the window",
          evidence: { eventsInWindow: 0, gatewayRequestsInWindow: 30, callbackErrorRate: 0, deliveryRatio: 0, legacyRejections: 0 },
        })}
        loading={false}
        error={null}
      />,
    );
    expect(container.querySelector('[data-testid="myrmidon-tracing-health-status"]')?.textContent).toContain("red");
    const reason = container.querySelector('[data-testid="myrmidon-tracing-health-reason"]')?.textContent ?? "";
    expect(reason).toContain("no tracing events");
  });

  it("renders ok (idle) for a quiet window, not red", () => {
    render(
      <TracingHealthCardView
        report={report({ state: "idle", reason: "the gateway served no traffic in the window" })}
        loading={false}
        error={null}
      />,
    );
    expect(container.querySelector('[data-testid="myrmidon-tracing-health-status"]')?.textContent).toContain("ok (idle)");
  });

  it("renders unknown for a blind check", () => {
    render(
      <TracingHealthCardView
        report={report({ state: "unknown", reason: "the ClickHouse events probe failed" })}
        loading={false}
        error={null}
      />,
    );
    expect(container.querySelector('[data-testid="myrmidon-tracing-health-status"]')?.textContent).toContain("unknown");
  });

  it("renders the not-enabled state without evidence lines", () => {
    render(
      <TracingHealthCardView
        report={report({
          enabled: false,
          state: "unknown",
          reason: "tracing health check is not configured",
          evidence: { eventsInWindow: null, gatewayRequestsInWindow: null, callbackErrorRate: null, deliveryRatio: null, legacyRejections: null },
        })}
        loading={false}
        error={null}
      />,
    );
    expect(container.querySelector('[data-testid="myrmidon-tracing-health-status"]')?.textContent).toContain("not enabled");
    expect(container.querySelector('[data-testid="myrmidon-tracing-health-evidence"]')).toBeNull();
  });

  it("renders the error state", () => {
    render(<TracingHealthCardView report={null} loading={false} error="Request failed" />);
    expect(container.querySelector('[data-testid="myrmidon-tracing-health-error"]')?.textContent).toContain("Request failed");
  });
});

describe("TracingHealthCard container", () => {
  it("loads the report through the API client", async () => {
    mockApi.get.mockResolvedValue(report());
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <TracingHealthCard />
      </QueryClientProvider>,
    );
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="myrmidon-tracing-health-reason"]')).not.toBeNull();
    });
    expect(mockApi.get).toHaveBeenCalledWith("/myrmidon/tracing/health");
    queryClient.clear();
  });
});
