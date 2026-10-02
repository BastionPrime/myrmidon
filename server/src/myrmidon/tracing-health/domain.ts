// server/src/myrmidon/tracing-health/domain.ts
//
// myrmidon(TRACING-HEALTH): pure state machine for the LLM tracing health
// check. Computes the health state from probe evidence — no I/O, no clocks.
//
// Semantics (from the tracing-health plan):
//  - "ok": the gateway served traffic in the window AND events landed in
//    ClickHouse `events_core` AND the callback error rate is ~0.
//  - "idle": the gateway served no traffic in the window. A quiet window is
//    NOT "broken": the 02.10 incident class was tracing failing silently
//    while 40k events/day were still flowing, so the check must not cry wolf
//    on quiet periods.
//  - "degraded": the gateway served traffic but no tracing events landed in
//    the window (traces lost while traffic flowed — the incident), or the
//    callback error rate is at or above the threshold.
//  - "unknown": a probe failed (null evidence for the fields the state
//    depends on). The route reports it with a reason; it never 500s.
//
// The JSON contract below is frozen for part D (the attention/card side):
// changing a field name or a state label breaks a sibling part.

export type TracingHealthState = "ok" | "idle" | "degraded" | "unknown";

/** Probe evidence; `null` means "the probe failed or the source is absent". */
export interface TracingHealthEvidence {
  /** Events in ClickHouse `events_core` over the window; null = probe failed. */
  eventsInWindow: number | null;
  /** Requests the gateway served over the window; null = probe failed. */
  gatewayRequestsInWindow: number | null;
  /** LiteLLM callback error rate [0..1]; null = probe failed or no counter. */
  callbackErrorRate: number | null;
  /**
   * OTEL events delivered into `events_core` per gateway request over the
   * window (eventsInWindow / gatewayRequestsInWindow); null = no data
   * (either side missing or no traffic). Part D reads it for the dedup key.
   */
  deliveryRatio: number | null;
  /**
   * Count of "Rejected ... legacy" ingestion rejections over the window —
   * the 02.10 incident signature; null = counter unavailable. Any value
   * above zero means degraded.
   */
  legacyRejections: number | null;
}

export interface TracingHealthWindow {
  from: string;
  to: string;
}

export interface TracingHealthReport {
  enabled: boolean;
  state: TracingHealthState;
  checkedAt: string;
  window: TracingHealthWindow;
  evidence: TracingHealthEvidence;
  reason: string | null;
}

/** Callback error rate at or above this is "degraded" (~0 requirement). */
export const CALLBACK_ERROR_RATE_THRESHOLD = 0.02;

/**
 * Delivery ratio below this (OTEL events in `events_core` per gateway
 * request over the window) is "degraded", not "unknown" — the operator's
 * 02.10 finding: half the traces lost is an incident, not a broken check.
 */
export const DELIVERY_RATIO_THRESHOLD = 0.5;

/**
 * More than this many "API errors occurred" gateway log lines in the window
 * is "degraded" (mapped onto the callback error rate: lines/requests).
 */
export const GATEWAY_API_ERROR_LINES_THRESHOLD = 20;

export const REASONS = {
  ok: "tracing events are flowing while the gateway serves traffic",
  idle: "the gateway served no traffic in the window",
  degradedNoEvents: "the gateway served traffic but no tracing events landed in the window",
  degradedDeliveryRatio: "the tracing delivery ratio over the window is below the threshold",
  degradedCallbackErrors: "the tracing callback error rate is at or above the threshold",
  degradedLegacyRejections: "ingestion rejected legacy-format events in the window",
  unknownEvents: "the ClickHouse events probe failed",
  unknownGateway: "the gateway traffic probe failed",
  unknownBoth: "the ClickHouse events and gateway traffic probes failed",
} as const;

/**
 * The pure state machine: evidence -> state + reason. Total: any combination
 * of nulls yields a defined state; evidence fields left null (no source)
 * never block the computation.
 *
 * Precedence: probe failures (unknown) outrank everything — a broken check
 * must never read as healthy. Among failures, both > either. With live
 * probes: traffic decides idle vs ok/degraded; with traffic, no events at
 * all is degraded; with events, the delivery ratio decides, then legacy
 * rejections (any > 0 — the 02.10 incident signature), then the callback
 * error rate.
 */
export function computeTracingHealthState(
  evidence: TracingHealthEvidence,
  threshold: number = CALLBACK_ERROR_RATE_THRESHOLD,
): { state: TracingHealthState; reason: string | null } {
  const eventsKnown = evidence.eventsInWindow !== null;
  const gatewayKnown = evidence.gatewayRequestsInWindow !== null;
  if (!eventsKnown || !gatewayKnown) {
    if (!eventsKnown && !gatewayKnown) {
      return { state: "unknown", reason: REASONS.unknownBoth };
    }
    return eventsKnown
      ? { state: "unknown", reason: REASONS.unknownGateway }
      : { state: "unknown", reason: REASONS.unknownEvents };
  }
  const events = evidence.eventsInWindow as number;
  const requests = evidence.gatewayRequestsInWindow as number;
  if (requests <= 0) {
    return { state: "idle", reason: REASONS.idle };
  }
  if (events <= 0) {
    return { state: "degraded", reason: REASONS.degradedNoEvents };
  }
  if (evidence.deliveryRatio !== null && evidence.deliveryRatio < DELIVERY_RATIO_THRESHOLD) {
    return { state: "degraded", reason: REASONS.degradedDeliveryRatio };
  }
  if (evidence.legacyRejections !== null && evidence.legacyRejections > 0) {
    return { state: "degraded", reason: REASONS.degradedLegacyRejections };
  }
  if (evidence.callbackErrorRate !== null && evidence.callbackErrorRate >= threshold) {
    return { state: "degraded", reason: REASONS.degradedCallbackErrors };
  }
  return { state: "ok", reason: REASONS.ok };
}
