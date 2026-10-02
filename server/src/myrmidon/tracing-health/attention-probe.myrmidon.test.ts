// myrmidon(TRACING-HEALTH) probe tests: the report shape the attention
// generator consumes — enabled gating, evidence wiring (delivery ratio,
// legacy rejections, callback error rate), and the TTL cache the sweep uses
// so the feed does not hammer the gateway and ClickHouse on every poll.

import { describe, expect, it, vi } from "vitest";
import { probeTracingHealthReport, createTracingHealthAttentionProbe } from "./attention-probe.js";
import { readTracingHealthSettings } from "./probes.js";
import { LITELLM_BASE_URL_ENV, LITELLM_KEY_SECRET_ENV } from "../litellm-costs/litellm-costs.js";
import { TRACING_CLICKHOUSE_URL_ENV } from "./probes.js";

const ENV_ON = {
  [LITELLM_BASE_URL_ENV]: "http://gateway.example:4000",
  [LITELLM_KEY_SECRET_ENV]: "gw-key",
  [TRACING_CLICKHOUSE_URL_ENV]: "http://clickhouse.example:8123",
};

const NOW = new Date("2026-10-02T10:00:00Z");

function okCh(counts: { events?: number; rejections?: number }) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.searchParams.get("query")?.includes("langfuse_ingestion_rejections")) {
      return new Response(JSON.stringify({ data: [{ "count()": counts.rejections ?? 0 }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: [{ "count()": counts.events ?? 0 }] }), { status: 200 });
  });
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    env: ENV_ON,
    now: () => NOW,
    readGatewayKey: vi.fn(async () => "sk-test"),
    listCompanyIds: vi.fn(async () => ["11111111-1111-4111-8111-111111111111"]),
    client: vi.fn(() => ({ listSpendLogs: async () => [1, 2, 3] })),
    fetchFn: okCh({ events: 5, rejections: 0 }),
    ...overrides,
  } as Parameters<typeof probeTracingHealthReport>[2];
}

describe("tracing health attention probe", () => {
  it("reports enabled:false state unknown as data when unconfigured (no exception, no card)", async () => {
    const settings = readTracingHealthSettings({} as NodeJS.ProcessEnv);
    const report = await probeTracingHealthReport(settings, NOW, deps({ env: {} }));
    expect(report.enabled).toBe(false);
    expect(report.state).toBe("unknown");
    expect(report.reason).toContain("not configured");
    expect(report.evidence.eventsInWindow).toBeNull();
  });

  it("wires the evidence: events, requests, delivery ratio, rejections, callback rate", async () => {
    const settings = readTracingHealthSettings(ENV_ON);
    const report = await probeTracingHealthReport(settings, NOW, deps());
    expect(report.enabled).toBe(true);
    expect(report.state).toBe("ok");
    expect(report.evidence.eventsInWindow).toBe(5);
    expect(report.evidence.gatewayRequestsInWindow).toBe(3);
    expect(report.evidence.deliveryRatio).toBeCloseTo(5 / 3);
    expect(report.evidence.legacyRejections).toBe(0);
    expect(report.evidence.callbackErrorRate).toBe(0);
  });

  it("a legacy-rejection window is degraded with the incident reason", async () => {
    const settings = readTracingHealthSettings(ENV_ON);
    const report = await probeTracingHealthReport(
      settings,
      NOW,
      deps({ fetchFn: okCh({ events: 5, rejections: 2 }) }),
    );
    expect(report.state).toBe("degraded");
    expect(report.reason).toContain("legacy");
    expect(report.evidence.legacyRejections).toBe(2);
  });

  it("probe failures yield state unknown — the sweep stays silent, never throws", async () => {
    const settings = readTracingHealthSettings(ENV_ON);
    const report = await probeTracingHealthReport(settings, NOW, deps({ fetchFn: vi.fn(async () => {
      throw new Error("clickhouse unreachable");
    }) }));
    expect(report.state).toBe("unknown");
  });

  it("the TTL cache: within maxAge the same report object is returned, after it the probes run again", async () => {
    let clock = new Date("2026-10-02T10:00:00Z").getTime();
    const fetchFn = okCh({ events: 5, rejections: 0 });
    const probe = createTracingHealthAttentionProbe({
      ...deps({ fetchFn }),
      now: () => new Date(clock),
    });
    const first = await probe.report();
    expect(fetchFn.mock.calls.length).toBeGreaterThanOrEqual(2); // events + rejections
    const afterFirst = fetchFn.mock.calls.length;
    const second = await probe.report();
    expect(second).toBe(first); // cached: same object, no extra probe
    expect(fetchFn.mock.calls.length).toBe(afterFirst);
    clock += 61_000;
    await probe.report();
    expect(fetchFn.mock.calls.length).toBe(afterFirst * 2); // TTL expired: probes again
  });
});
