// server/src/myrmidon/tracing-health/attention.ts
//
// myrmidon(TRACING-HEALTH part D): the operator signal behind the "LLM
// tracing" status card.
//
// Part C (eng-2, OPE-3537) built the endpoint GET /api/myrmidon/tracing/health
// and froze its JSON contract. This module is the other half of the parent
// plan: WHO gets told when the check is not ok. The ticket's rule: the signal
// goes to the OPERATOR role, never the task owner — the 02.10 incident burned
// for days because nobody whose job it was to look ever looked.
//
// The bridge polls part C's report (server-side, TTL-bounded, injected fetch
// for tests) and turns a non-ok state into ONE attention card:
//  - state "ok" / "idle" → no card (a quiet window is not broken; part C's
//    own semantics);
//  - state "degraded" → severity high: tracing is lost while traffic flows;
//  - state "unknown" → severity medium: the check itself cannot see.
// Dedup is by state: one stable dedupKey while the failure persists, and the
// card disappears as soon as the report is ok/idle again — no dismissal
// bookkeeping, the same state-dedup the operator asked for in the parent
// thread.
//
// The attention feed reads the recorded signal (process-local registry, like
// the maintenance gate's document cache) instead of calling the probes on
// every desk read: a sweep (tracing-attention-sweep.ts) keeps it fresh.

import type { TracingHealthReport, TracingHealthState } from "./domain.js";

/** Stable per-instance dedup key: one card regardless of how many states passed. */
export const TRACING_ATTENTION_DEDUP_KEY = "tracing_health:llm-tracing";

/** Activity-log action for a state transition of the operator signal. */
export const TRACING_ATTENTION_ACTION_TRANSITION = "myrmidon.tracing.health_signal";

export interface TracingAttentionSignal {
  dedupKey: string;
  state: TracingHealthState;
  severity: "high" | "medium";
  title: string;
  whyNow: string;
  summary: string;
  /** ISO timestamp of the report the signal was built from. */
  activityAt: string;
}

/** Severity by state: degraded is the incident, unknown is a blind check. */
export function severityForState(state: TracingHealthState): "high" | "medium" | null {
  if (state === "degraded") return "high";
  if (state === "unknown") return "medium";
  return null;
}

/** Human line for the attention card, from the frozen report fields only. */
export function whyNowForReport(report: TracingHealthReport): string {
  const reason = report.reason?.trim() || "no reason given";
  if (report.state === "degraded") {
    return `LLM tracing is unhealthy: ${reason}. An operator must check the tracing pipeline (Langfuse ClickHouse events_core and the gateway callbacks); this is not a task-owner problem.`;
  }
  return `The LLM tracing health check cannot see the pipeline: ${reason}. An operator must check the probe configuration (MYRMIDON_TRACING_*, MYRMIDON_LITELLM_*).`;
}

/** The signal for a report, or null while ok/idle. */
export function tracingAttentionSignalForReport(
  report: TracingHealthReport,
): TracingAttentionSignal | null {
  if (!report.enabled) return null;
  const severity = severityForState(report.state);
  if (!severity) return null;
  return {
    dedupKey: TRACING_ATTENTION_DEDUP_KEY,
    state: report.state,
    severity,
    title: "LLM tracing",
    whyNow: whyNowForReport(report),
    summary: report.reason ?? "",
    activityAt: report.checkedAt,
  };
}

// ---------------------------------------------------------------------------
// Process-level registry the attention feed reads
// ---------------------------------------------------------------------------

const signalByCompany = new Map<string, TracingAttentionSignal>();

/** Record the latest report's signal; ok/idle/disabled clears it. */
export function recordTracingHealthSignal(companyId: string, report: TracingHealthReport): void {
  const signal = tracingAttentionSignalForReport(report);
  if (!signal) {
    signalByCompany.delete(companyId);
    return;
  }
  signalByCompany.set(companyId, signal);
}

/** The current operator signal, or null while healthy/idle/disabled. */
export function readTracingHealthAttentionSignal(companyId: string): TracingAttentionSignal | null {
  return signalByCompany.get(companyId) ?? null;
}

/** Test helper: forget every recorded signal. */
export function resetTracingHealthSignals(): void {
  signalByCompany.clear();
}
