// myrmidon(TRACING-HEALTH part D): API client for the "LLM tracing" status
// card. Server side: GET /api/myrmidon/tracing/health (part C, eng-2 — the
// JSON contract is frozen in server/src/myrmidon/tracing-health/domain.ts).

import { api } from "@/api/client";

export type TracingHealthState = "ok" | "idle" | "degraded" | "unknown";

/** Part C's frozen evidence block; null means "probe failed / no source". */
export interface TracingHealthEvidence {
  eventsInWindow: number | null;
  gatewayRequestsInWindow: number | null;
  callbackErrorRate: number | null;
  deliveryRatio: number | null;
  legacyRejections: number | null;
}

export interface TracingHealthReport {
  enabled: boolean;
  state: TracingHealthState;
  checkedAt: string;
  window: { from: string; to: string };
  evidence: TracingHealthEvidence;
  reason: string | null;
}

export const tracingHealthKey = ["myrmidon", "tracing", "health"] as const;

export const tracingHealthApi = {
  get: () => api.get<TracingHealthReport>("/myrmidon/tracing/health"),
};

/** "15 min" style window label from the report's window span. */
export function formatWindowLabel(report: TracingHealthReport): string {
  const ms = Math.max(0, Date.parse(report.window.to) - Date.parse(report.window.from));
  const minutes = Math.round(ms / 60_000);
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60} h`;
  return `${minutes} min`;
}

/** The dot + label pair the card shows per state. */
export function stateView(state: TracingHealthState, enabled: boolean): { dot: "green" | "red" | "gray"; label: string } {
  if (!enabled) return { dot: "gray", label: "not enabled" };
  switch (state) {
    case "ok":
      return { dot: "green", label: "ok" };
    case "idle":
      return { dot: "green", label: "ok (idle)" };
    case "degraded":
      return { dot: "red", label: "red" };
    default:
      return { dot: "red", label: "unknown" };
  }
}

/** One evidence line per probe, human-readable, null-aware. */
export function evidenceLines(evidence: TracingHealthEvidence): string[] {
  const events =
    evidence.eventsInWindow === null ? "events: unknown" : `events in window: ${evidence.eventsInWindow}`;
  const requests =
    evidence.gatewayRequestsInWindow === null
      ? "gateway requests: unknown"
      : `gateway requests in window: ${evidence.gatewayRequestsInWindow}`;
  const ratio =
    evidence.deliveryRatio === null ? "delivery ratio: unknown" : `delivery ratio: ${evidence.deliveryRatio.toFixed(2)}`;
  const rate =
    evidence.callbackErrorRate === null
      ? "callback error rate: unknown"
      : `callback error rate: ${evidence.callbackErrorRate.toFixed(3)}`;
  const rejections =
    evidence.legacyRejections === null
      ? "legacy rejections: unknown"
      : `legacy rejections: ${evidence.legacyRejections}`;
  return [requests, events, ratio, rate, rejections];
}
