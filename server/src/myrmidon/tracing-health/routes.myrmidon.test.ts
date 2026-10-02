// myrmidon(TRACING-HEALTH) route tests: the JSON contract, permissions, the
// disabled state, probe failures (never a 500), and the cache TTL. Express +
// supertest with fake deps — no postgres, no live network.

import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import { LITELLM_BASE_URL_ENV, LITELLM_KEY_SECRET_ENV } from "../litellm-costs/litellm-costs.js";
import { tracingHealthRoutes } from "./routes.js";
import { TRACING_CLICKHOUSE_URL_ENV } from "./probes.js";
import type { SpendLogEntry } from "../litellm-costs/litellm-costs.js";

const spendEntry = (): SpendLogEntry => ({
  requestId: "req-1",
  apiKey: null,
  spend: 0.01,
  promptTokens: 10,
  completionTokens: 5,
  startTime: "2026-10-02T09:50:00.000Z",
  model: "openai/example-model",
  provider: "openai",
});

const ENV_ON = {
  [LITELLM_BASE_URL_ENV]: "http://gateway.local:4000",
  [LITELLM_KEY_SECRET_ENV]: "gw-key",
  [TRACING_CLICKHOUSE_URL_ENV]: "http://clickhouse.local:8123",
  MYRMIDON_TRACING_CLICKHOUSE_USER: "ch-user",
  MYRMIDON_TRACING_CLICKHOUSE_PASSWORD: "ch-pass",
};

const NOW = () => new Date("2026-10-02T10:00:00Z");

function okCh(counts: { events?: number; rejections?: number }) {
  return async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.searchParams.get("query")?.includes("langfuse_ingestion_rejections")) {
      return new Response(JSON.stringify({ data: [{ "count()": counts.rejections ?? 0 }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: [{ "count()": counts.events ?? 0 }] }), { status: 200 });
  };
}

function gatewayClient(entries: SpendLogEntry[] | "error") {
  return {
    listSpendLogs: entries === "error" ? async () => {
      throw new Error("gateway unreachable");
    } : async () => entries,
  };
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    env: ENV_ON,
    now: NOW,
    readGatewayKey: vi.fn(async () => "sk-test"),
    listCompanyIds: vi.fn(async () => ["11111111-1111-4111-8111-111111111111"]),
    client: vi.fn(() => gatewayClient([spendEntry()])),
    fetchFn: vi.fn(okCh({ events: 5, rejections: 0 })),
    ...overrides,
  };
}

function app(actor: unknown, routeDeps: ReturnType<typeof deps>) {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  server.use("/api", tracingHealthRoutes({} as never, routeDeps));
  server.use(errorHandler);
  return server;
}

const admin = { type: "board", source: "session", userId: "admin-user", isInstanceAdmin: true, companyIds: [] };
const member = { type: "board", source: "session", userId: "user-a", isInstanceAdmin: false, companyIds: ["company-a"] };
const agentActor = { type: "agent", source: "agent_key", agentId: "agent-a", companyId: "company-a", keyId: "key-a" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("myrmidon(TRACING-HEALTH) GET /api/myrmidon/tracing/health", () => {
  it("answers 200 with the exact frozen JSON contract on ok", async () => {
    const res = await request(app(member, deps())).get("/api/myrmidon/tracing/health").expect(200);
    expect(res.body).toEqual({
      enabled: true,
      state: "ok",
      checkedAt: "2026-10-02T10:00:00.000Z",
      window: { from: "2026-10-02T09:45:00.000Z", to: "2026-10-02T10:00:00.000Z" },
      evidence: { eventsInWindow: 5, gatewayRequestsInWindow: 1, callbackErrorRate: 0, deliveryRatio: 5, legacyRejections: 0 },
      reason: "tracing events are flowing while the gateway serves traffic",
    });
  });

  it("idle: no gateway traffic is OK with a reason, not broken", async () => {
    const routeDeps = deps({ client: vi.fn(() => gatewayClient([])) });
    const res = await request(app(member, routeDeps)).get("/api/myrmidon/tracing/health").expect(200);
    expect(res.body).toMatchObject({
      state: "idle",
      evidence: { eventsInWindow: 5, gatewayRequestsInWindow: 0, deliveryRatio: null },
    });
    expect(res.body.reason).toContain("no traffic");
  });

  it("degraded: traffic but zero events (the 02.10 incident class)", async () => {
    const routeDeps = deps({ fetchFn: vi.fn(okCh({ events: 0, rejections: 0 })) });
    const res = await request(app(member, routeDeps)).get("/api/myrmidon/tracing/health").expect(200);
    expect(res.body).toMatchObject({
      state: "degraded",
      evidence: { eventsInWindow: 0, gatewayRequestsInWindow: 1, deliveryRatio: 0 },
    });
  });

  it("degraded: delivery ratio below 50% with traffic (half the traces lost)", async () => {
    // 40 requests, 5 events -> deliveryRatio 0.125 < 0.5
    const routeDeps = deps({ client: vi.fn(() => gatewayClient(Array.from({ length: 40 }, spendEntry))) });
    const res = await request(app(member, routeDeps)).get("/api/myrmidon/tracing/health").expect(200);
    expect(res.body).toMatchObject({
      state: "degraded",
      evidence: { eventsInWindow: 5, gatewayRequestsInWindow: 40, deliveryRatio: 0.125 },
    });
    expect(res.body.reason).toContain("delivery ratio");
  });

  it("degraded: any legacy rejection in the window (the 02.10 signature)", async () => {
    const routeDeps = deps({ fetchFn: vi.fn(okCh({ events: 5, rejections: 2 })) });
    const res = await request(app(member, routeDeps)).get("/api/myrmidon/tracing/health").expect(200);
    expect(res.body).toMatchObject({
      state: "degraded",
      evidence: { eventsInWindow: 5, gatewayRequestsInWindow: 1, legacyRejections: 2 },
    });
    expect(res.body.reason).toContain("legacy");
  });

  it("degraded: the callback error rate at or above the threshold", async () => {
    // 1 request, 5 rejections: callbackErrorRate capped at 1, legacy rejections 5
    const routeDeps = deps({ fetchFn: vi.fn(okCh({ events: 5, rejections: 5 })) });
    const res = await request(app(member, routeDeps)).get("/api/myrmidon/tracing/health").expect(200);
    expect(res.body).toMatchObject({ state: "degraded", evidence: { callbackErrorRate: 1, legacyRejections: 5 } });
  });

  it("unknown with a reason when a probe fails — never a 500", async () => {
    const routeDeps = deps({ fetchFn: vi.fn(async () => new Response("nope", { status: 500 })) });
    const res = await request(app(member, routeDeps)).get("/api/myrmidon/tracing/health").expect(200);
    expect(res.body).toMatchObject({
      state: "unknown",
      evidence: { eventsInWindow: null, gatewayRequestsInWindow: 1, callbackErrorRate: null },
    });
    expect(typeof res.body.reason).toBe("string");
  });

  it("unknown when the gateway probe fails and no previous report exists", async () => {
    const routeDeps = deps({ client: vi.fn(() => gatewayClient("error")) });
    const res = await request(app(member, routeDeps)).get("/api/myrmidon/tracing/health").expect(200);
    expect(res.body).toMatchObject({ state: "unknown", evidence: { gatewayRequestsInWindow: null } });
  });

  it("503 with enabled:false while the instance switch is off", async () => {
    const routeDeps = deps({ env: {} });
    const res = await request(app(member, routeDeps)).get("/api/myrmidon/tracing/health").expect(503);
    expect(res.body).toMatchObject({
      enabled: false,
      state: "unknown",
      reason: "tracing health check is not configured",
      evidence: { eventsInWindow: null, gatewayRequestsInWindow: null, callbackErrorRate: null, deliveryRatio: null, legacyRejections: null },
    });
    expect(res.body.window).toEqual({ from: "2026-10-02T09:45:00.000Z", to: "2026-10-02T10:00:00.000Z" });
  });

  it("a throwing probe keeps the previous cached report and answers 503 (stack-registry pattern)", async () => {
    // One router, a moving clock: first call measures OK, then the client
    // factory itself starts throwing past the TTL — the route catch keeps
    // the previous cached report and answers 503 with it.
    let clock = new Date("2026-10-02T10:00:00Z");
    const probes = deps({ now: () => clock });
    const server = app(member, probes);
    const first = await request(server).get("/api/myrmidon/tracing/health").expect(200);
    expect(first.body.state).toBe("ok");
    const boom = vi.fn(() => {
      throw new Error("probe exploded");
    });
    (probes as { client: unknown }).client = boom;
    clock = new Date("2026-10-02T10:05:00Z");
    const res = await request(server).get("/api/myrmidon/tracing/health").expect(503);
    expect(res.body).toMatchObject({ enabled: true, state: "ok", reason: first.body.reason });
  });

  it("agent tokens and anonymous callers are rejected (403)", async () => {
    await request(app(agentActor, deps())).get("/api/myrmidon/tracing/health").expect(403);
    await request(app({ type: "none" }, deps())).get("/api/myrmidon/tracing/health").expect(403);
  });

  it("any board org member can read; no gateway key in the response", async () => {
    const res = await request(app(admin, deps())).get("/api/myrmidon/tracing/health").expect(200);
    expect(res.body.state).toBeDefined();
    expect(JSON.stringify(res.body)).not.toContain("sk-test");
    expect(JSON.stringify(res.body)).not.toContain("ch-pass");
    expect(JSON.stringify(res.body)).not.toContain("gateway.local");
    expect(JSON.stringify(res.body)).not.toContain("clickhouse.local");
  });

  it("serves the cached report within the TTL and re-probes after it", async () => {
    const probes = deps();
    const server = app(member, probes);
    await request(server).get("/api/myrmidon/tracing/health").expect(200);
    const fetchMock = probes.fetchFn as { mock: { calls: unknown[][] } };
    const callsAfterFirst = fetchMock.mock.calls.length;
    await request(server).get("/api/myrmidon/tracing/health").expect(200);
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
    const later = { ...probes, now: () => new Date("2026-10-02T10:02:00Z") };
    await request(app(member, later)).get("/api/myrmidon/tracing/health").expect(200);
    expect((later.fetchFn as { mock: { calls: unknown[][] } }).mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it("the first company whose gateway key resolves is used; no key is an unknown traffic probe", async () => {
    const companyA = "11111111-1111-4111-8111-111111111111";
    const companyB = "22222222-2222-4222-8222-222222222222";
    const readGatewayKey = vi.fn(async (companyId: string) => (companyId === companyA ? null : "sk-second"));
    const client = vi.fn(() => gatewayClient([spendEntry()]));
    const routeDeps = deps({ readGatewayKey, client, listCompanyIds: vi.fn(async () => [companyA, companyB]) });
    const res = await request(app(member, routeDeps)).get("/api/myrmidon/tracing/health").expect(200);
    expect(readGatewayKey).toHaveBeenCalledTimes(2);
    expect(client).toHaveBeenCalledWith("http://gateway.local:4000", "sk-second");
    expect(res.body.evidence.gatewayRequestsInWindow).toBe(1);
    const noKey = deps({ readGatewayKey: vi.fn(async () => null) });
    const res2 = await request(app(member, noKey)).get("/api/myrmidon/tracing/health").expect(200);
    expect(res2.body).toMatchObject({ state: "unknown", evidence: { gatewayRequestsInWindow: null } });
  });
});
