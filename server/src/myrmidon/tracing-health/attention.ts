// server/src/myrmidon/tracing-health/attention.ts
//
// myrmidon(TRACING-HEALTH): operator attention signal for LLM tracing.
//
// The board attention feed IS the conveyor — no parallel notification store.
// This module turns the tracing health report (part C) into one feed item
// when tracing is degraded.
//
// Entry rule: state = "degraded" only. Quiet ("idle") and broken-probe
// ("unknown") windows are not operator pages — the 02.10 incident class was
// tracing failing SILENTLY while traffic flowed, not the check being loud.
// Severity: high.
//
// Dedup ("dedup per state"): one card per state+reason. The dedupKey carries
// the degraded reason, so a reason change lands on a NEW key — the operator
// sees the new cause as its own card, and the old card falls out of the feed
// as soon as its state leaves degraded (the feed is recomputed from live
// state each poll, no store to clean up). Within the same state+reason the
// generator emits the same id (`tracing_health:<dedupKey>`), so a same-state
// refresh replaces the row — it never stacks a second one.
//
// Exit rule: state returns to ok/idle (generator stops emitting the item and
// the ephemeral feed row is gone) or the operator dismisses the card (the
// dismissal rides the standard attention dismissalKey).
//
// Addressing: board-only by construction. The subject is an instance-wide
// component with no agent and no issue, so nothing routes this card to an
// agent or an owner: the attention routes are board-context (assertBoard),
// and the decision-queue read gate for `tracing_health` (decision-queues.ts)
// also requires the board actor.

import type { AttentionItem } from "@paperclipai/shared";
import { DEFAULT_DECISION_SHELF_DAYS } from "../../services/decision-retention.js";
import type { TracingHealthReport } from "./domain.js";

export const TRACING_HEALTH_SOURCE_KIND = "tracing_health" as const;

export const TRACING_HEALTH_SIGNAL_REASONS = {
  degraded: "LLM tracing is degraded",
} as const;

/** Build the tracing-health attention card for a degraded report. */
export function tracingHealthAttentionItem(
  report: Pick<TracingHealthReport, "state" | "reason" | "checkedAt" | "window" | "evidence">,
  companyId: string,
): AttentionItem | null {
  if (report.state !== "degraded") return null;
  const reason = report.reason ?? TRACING_HEALTH_SIGNAL_REASONS.degraded;
  const dedupKey = `tracing_health:degraded:${reason}`;
  const at = report.checkedAt;
  return {
    id: `${TRACING_HEALTH_SOURCE_KIND}:${dedupKey}`,
    companyId,
    sourceKind: TRACING_HEALTH_SOURCE_KIND,
    subject: {
      kind: "issue",
      id: "tracing-health",
      companyId,
      title: "LLM tracing is degraded",
      identifier: null,
      status: "degraded",
      href: null,
      metadata: {
        state: report.state,
        reason,
        checkedAt: report.checkedAt,
        windowFrom: report.window.from,
        windowTo: report.window.to,
        eventsInWindow: report.evidence.eventsInWindow,
        gatewayRequestsInWindow: report.evidence.gatewayRequestsInWindow,
        callbackErrorRate: report.evidence.callbackErrorRate,
        deliveryRatio: report.evidence.deliveryRatio,
        legacyRejections: report.evidence.legacyRejections,
      },
    },
    whyNow: `LLM tracing is degraded: ${reason}.`,
    decisionVerbs: [
      { id: "inspect", label: "Inspect", description: "Open the LLM tracing status card on the Costs page." },
      { id: "dismiss", label: "Dismiss", description: "Dismiss this tracing alert." },
    ],
    inlineResolvable: false,
    entryRule: "tracing health state is degraded.",
    exitRule: "tracing health state returns to ok/idle, or the row is dismissed.",
    dedupKey,
    dismissalKey: `attention:${dedupKey}`,
    dismissal: null,
    severity: "high",
    rank: 0,
    activityAt: at,
    createdAt: at,
    updatedAt: at,
    relatedIssue: null,
    project: null,
    workspace: null,
    expiresAt: null,
    ruleKey: null,
    originAgentName: null,
    queues: [],
    shelf: false,
    retentionDays: DEFAULT_DECISION_SHELF_DAYS,
    keep: false,
    archivedAt: null,
    retentionVersion: 0,
    decideBy: null,
    decideByAttribution: null,
    snoozedUntil: null,
    detail: {
      kind: "generic",
      summaryExcerpt: `LLM tracing is degraded: ${reason}.`,
      images: [],
    },
    trainingExampleId: null,
  };
}

/**
 * All feed items for a tracing health report: one card while degraded, none
 * otherwise (idle/unknown are deliberately quiet — see the header).
 */
export function tracingHealthAttentionItems(
  report: Pick<TracingHealthReport, "state" | "reason" | "checkedAt" | "window" | "evidence">,
  companyId: string,
): AttentionItem[] {
  const item = tracingHealthAttentionItem(report, companyId);
  return item ? [item] : [];
}
