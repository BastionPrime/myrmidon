// myrmidon(TRACING-HEALTH) attention tests: the operator signal semantics —
// entry (degraded only), dedup per state+reason, exit (ok/idle), and the
// operator (board) addressing. Pure unit tests over the generator contract:
// the feed recomputes items from the live report each poll, so the proofs
// below drive the generator twice and compare what it emitted.

import { describe, expect, it } from "vitest";
import type { AttentionItem } from "@paperclipai/shared";
import { ATTENTION_SOURCE_KINDS } from "@paperclipai/shared";
import { tracingHealthAttentionItem, tracingHealthAttentionItems } from "./attention.js";
import type { TracingHealthReport } from "./domain.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const CHECKED_AT = "2026-10-02T10:00:00.000Z";
const WINDOW = { from: "2026-10-02T09:45:00.000Z", to: CHECKED_AT };

function report(overrides: Partial<TracingHealthReport> = {}): TracingHealthReport {
  return {
    enabled: true,
    state: "ok",
    checkedAt: CHECKED_AT,
    window: WINDOW,
    evidence: {
      eventsInWindow: 40,
      gatewayRequestsInWindow: 50,
      callbackErrorRate: 0,
      deliveryRatio: 0.8,
      legacyRejections: 0,
    },
    reason: "tracing events are flowing while the gateway serves traffic",
    ...overrides,
  };
}

const degradedNoEvents = report({
  state: "degraded",
  reason: "the gateway served traffic but no tracing events landed in the window",
  evidence: {
    eventsInWindow: 0,
    gatewayRequestsInWindow: 50,
    callbackErrorRate: 0,
    deliveryRatio: 0,
    legacyRejections: 0,
  },
});

describe("tracing health attention generator", () => {
  it("emits exactly one card for a degraded report", () => {
    const items = tracingHealthAttentionItems(degradedNoEvents, COMPANY);
    expect(items).toHaveLength(1);
    const item = items[0] as AttentionItem;
    expect(item.sourceKind).toBe("tracing_health");
    expect(item.severity).toBe("high");
    expect(item.subject.title).toBe("LLM tracing is degraded");
    expect(item.whyNow).toContain(degradedNoEvents.reason);
    expect(item.subject.metadata).toMatchObject({
      eventsInWindow: 0,
      gatewayRequestsInWindow: 50,
      deliveryRatio: 0,
      legacyRejections: 0,
    });
  });

  it("same state and reason re-emit the same id: a same-state refresh never stacks a second card", () => {
    const first = tracingHealthAttentionItems(degradedNoEvents, COMPANY);
    // The next poll: window slid, checkedAt moved, numbers changed — but the
    // state and the degraded reason are the same.
    const refreshed = tracingHealthAttentionItems(
      report({
        ...degradedNoEvents,
        checkedAt: "2026-10-02T10:15:00.000Z",
        window: { from: "2026-10-02T10:00:00.000Z", to: "2026-10-02T10:15:00.000Z" },
        evidence: {
          eventsInWindow: 0,
          gatewayRequestsInWindow: 70,
          callbackErrorRate: 0,
          deliveryRatio: 0,
          legacyRejections: 0,
        },
      }),
      COMPANY,
    );
    expect(refreshed).toHaveLength(1);
    expect((refreshed[0] as AttentionItem).id).toBe((first[0] as AttentionItem).id);
    expect((refreshed[0] as AttentionItem).dedupKey).toBe((first[0] as AttentionItem).dedupKey);
  });

  it("a reason change opens a new card with new text (the old key disappears with the old state)", () => {
    const noEvents = tracingHealthAttentionItem(degradedNoEvents, COMPANY);
    const ratio = tracingHealthAttentionItem(
      report({
        state: "degraded",
        reason: "the tracing delivery ratio over the window is below the threshold",
        evidence: {
          eventsInWindow: 10,
          gatewayRequestsInWindow: 50,
          callbackErrorRate: 0,
          deliveryRatio: 0.2,
          legacyRejections: 0,
        },
      }),
      COMPANY,
    );
    expect(noEvents?.dedupKey).not.toBe(ratio?.dedupKey);
    expect(noEvents?.id).not.toBe(ratio?.id);
    expect(ratio?.whyNow).toContain("delivery ratio");
  });

  it("emits nothing for ok, idle, and unknown: quiet or unknown probes are not operator pages", () => {
    expect(tracingHealthAttentionItems(report(), COMPANY)).toHaveLength(0);
    expect(
      tracingHealthAttentionItems(
        report({
          state: "idle",
          reason: "the gateway served no traffic in the window",
          evidence: {
            eventsInWindow: 0,
            gatewayRequestsInWindow: 0,
            callbackErrorRate: null,
            deliveryRatio: null,
            legacyRejections: null,
          },
        }),
        COMPANY,
      ),
    ).toHaveLength(0);
    expect(
      tracingHealthAttentionItems(
        report({
          state: "unknown",
          reason: "the ClickHouse events probe failed",
          evidence: {
            eventsInWindow: null,
            gatewayRequestsInWindow: 50,
            callbackErrorRate: null,
            deliveryRatio: null,
            legacyRejections: null,
          },
        }),
        COMPANY,
      ),
    ).toHaveLength(0);
    // Unconfigured instances (enabled: false, state "unknown") stay quiet too.
    expect(
      tracingHealthAttentionItems(
        report({
          enabled: false,
          state: "unknown",
          reason: "tracing health check is not configured",
        }),
        COMPANY,
      ),
    ).toHaveLength(0);
  });

  it("addresses the operator role, never an agent or issue owner", () => {
    const item = tracingHealthAttentionItem(degradedNoEvents, COMPANY);
    expect(item).not.toBeNull();
    // No agent, no run, no issue assignment rides the card — the subject is
    // the instance-wide tracing component, so the only audience is the board
    // (operator) context the attention feed itself requires.
    expect(item?.subject.kind).toBe("issue");
    expect(item?.subject.metadata?.agentId).toBeUndefined();
    expect(item?.subject.metadata?.issueId).toBeUndefined();
    expect(item?.relatedIssue).toBeNull();
    expect(item?.originAgentName).toBeNull();
    expect(item?.inlineResolvable).toBe(false);
  });

  it("the exit rule text names ok/idle and dismissal, and the kind is registered in the shared contract", () => {
    const item = tracingHealthAttentionItem(degradedNoEvents, COMPANY);
    expect(item?.exitRule).toContain("ok/idle");
    expect(item?.exitRule).toContain("dismissed");
    // The sourceKind is part of the shared union: the feed, the queues and
    // the UI all type-check against the same string.
    expect(ATTENTION_SOURCE_KINDS).toContain("tracing_health");
  });
});
