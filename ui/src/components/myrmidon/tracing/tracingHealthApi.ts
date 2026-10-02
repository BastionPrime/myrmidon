// myrmidon(TRACING-HEALTH): LLM tracing health, GET /api/myrmidon/tracing/health.
// Mirrors the litellmCostsApi pattern: api client next to the component, the
// 503 "not enabled" body detected by the shared isNotEnabledError.
import { api } from "@/api/client";
import { isNotEnabledError } from "../litellm-costs/litellmCostsApi";

export type TracingHealthState = "ok" | "idle" | "degraded" | "unknown";

export interface TracingHealthEvidence {
  eventsInWindow: number | null;
  gatewayRequestsInWindow: number | null;
  callbackErrorRate: number | null;
  deliveryRatio: number | null;
  legacyRejections: number | null;
}

export interface TracingHealthReportView {
  enabled: boolean;
  state: TracingHealthState;
  checkedAt: string;
  window: { from: string; to: string };
  evidence: TracingHealthEvidence;
  reason: string | null;
}

export const tracingHealthQueryKey = ["myrmidon", "tracing", "health"] as const;

export const tracingHealthApi = {
  health: () => api.get<TracingHealthReportView>("/myrmidon/tracing/health"),
};

export { isNotEnabledError };

/** "5 of 12 requests" or "-" when the probe has no number. */
export function formatCount(value: number | null): string {
  return value == null ? "-" : String(value);
}

/** Delivery ratio as "0.42" or "-" when there is no data. */
export function formatRatio(value: number | null): string {
  if (value == null) return "-";
  if (value === 0) return "0";
  return value >= 0.01 ? value.toFixed(2) : value.toPrecision(2);
}

/** Callback error rate as "1.2%" or "-". */
export function formatRate(value: number | null): string {
  if (value == null) return "-";
  return `${(value * 100).toFixed(1)}%`;
}
