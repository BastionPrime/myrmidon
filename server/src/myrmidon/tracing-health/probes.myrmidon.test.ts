// myrmidon(TRACING-HEALTH) probe tests: settings parsing, the ClickHouse
// query (window bounds, auth parameters, null on failure) and the gateway
// traffic count. Fake fetch only; no live network, no keys.

import { afterEach, describe, expect, it, vi } from "vitest";
import { LITELLM_BASE_URL_ENV, LITELLM_KEY_SECRET_ENV } from "../litellm-costs/litellm-costs.js";
import {
  callbackErrorRate,
  countEvents,
  countRejections,
  gatewayRequestCount,
  readTracingHealthSettings,
  TRACING_CACHE_TTL_SEC_ENV,
  TRACING_CLICKHOUSE_URL_ENV,
  TRACING_WINDOW_SEC_ENV,
} from "./probes.js";

const WINDOW = { from: new Date("2026-10-02T09:45:00Z"), to: new Date("2026-10-02T10:00:00Z") };

const CH = {
  clickhouseUrl: "http://clickhouse.local:8123",
  clickhouseUser: "ch-user",
  clickhousePassword: "ch-pass",
  clickhouseDatabase: "default",
};

function okResponse(data: Array<Record<string, unknown>>) {
  return new Response(JSON.stringify({ data }), { status: 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("myrmidon(TRACING-HEALTH) readTracingHealthSettings", () => {
  const baseEnv = {
    [LITELLM_BASE_URL_ENV]: "http://gateway.local:4000",
    [LITELLM_KEY_SECRET_ENV]: "gw-key",
    [TRACING_CLICKHOUSE_URL_ENV]: "http://clickhouse.local:8123",
  };

  it("is disabled by default (deployment-off) and without the ClickHouse URL", () => {
    expect(readTracingHealthSettings({})).toMatchObject({ enabled: false });
    const { [TRACING_CLICKHOUSE_URL_ENV]: _drop, ...gatewayOnly } = baseEnv;
    expect(readTracingHealthSettings(gatewayOnly)).toMatchObject({ enabled: false, clickhouseUrl: null });
  });

  it("is enabled with gateway + ClickHouse, with the default window and TTL", () => {
    expect(readTracingHealthSettings(baseEnv)).toMatchObject({
      enabled: true,
      windowMs: 15 * 60_000,
      cacheTtlMs: 60_000,
      clickhouseDatabase: "default",
    });
  });

  it("reads the window and TTL in seconds and clamps out-of-range values", () => {
    expect(
      readTracingHealthSettings({ ...baseEnv, [TRACING_WINDOW_SEC_ENV]: "300", [TRACING_CACHE_TTL_SEC_ENV]: "10" }),
    ).toMatchObject({ windowMs: 300_000, cacheTtlMs: 10_000 });
    for (const bad of ["1", "not-a-number", "999999"]) {
      expect(readTracingHealthSettings({ ...baseEnv, [TRACING_WINDOW_SEC_ENV]: bad })).toMatchObject({
        windowMs: 15 * 60_000,
      });
    }
  });
});

describe("myrmidon(TRACING-HEALTH) ClickHouse events probe", () => {
  it("queries events_core over the window and returns the count", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        calls.push(input);
        return okResponse([{ "count()": 40123 }]);
      }),
    );
    const count = await countEvents(WINDOW, CH);
    expect(count).toBe(40123);
    expect(calls).toHaveLength(1);
    const parsedQuery = new URL(calls[0]).searchParams.get("query") ?? "";
    expect(parsedQuery).toContain("count() FROM default.events_core");
    expect(calls[0]).toContain("user=ch-user");
    expect(calls[0]).toContain("password=ch-pass");
  });

  it("uses the configured database and the epoch-seconds window bounds", async () => {
    let query = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        query = new URL(input).searchParams.get("query") ?? "";
        return okResponse([{ "count()": 1 }]);
      }),
    );
    await countEvents(WINDOW, { ...CH, clickhouseDatabase: "langfuse" });
    expect(query).toContain("FROM langfuse.events_core");
    expect(query).toContain("toDateTime64(1790934300, 3)");
    expect(query).toContain("toDateTime64(1790935200, 3)");
  });

  it("returns null on HTTP failure, bad shape, and transport errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    expect(await countEvents(WINDOW, CH)).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => okResponse([{ unexpected: 1 }])));
    expect(await countEvents(WINDOW, CH)).toBeNull();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("socket unreachable");
      }),
    );
    expect(await countEvents(WINDOW, CH)).toBeNull();
    expect(await countEvents(WINDOW, { ...CH, clickhouseUrl: null })).toBeNull();
  });

  it("counts ingestion rejections from the same ClickHouse", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        calls.push(input);
        return okResponse([{ "count()": 3 }]);
      }),
    );
    expect(await countRejections(WINDOW, CH)).toBe(3);
    expect(calls[0]).toContain("langfuse_ingestion_rejections");
  });
});

describe("myrmidon(TRACING-HEALTH) gateway traffic and callback rate", () => {
  const span = { from: new Date("2026-10-02T09:45:00Z"), to: new Date("2026-10-02T10:00:00Z") };

  it("counts /spend/logs/v2 entries over the window; zero is a real zero", async () => {
    const client = {
      listSpendLogs: vi.fn(async () => [{}, {}, {}]),
    };
    expect(await gatewayRequestCount(client as never, span)).toBe(3);
    const empty = { listSpendLogs: vi.fn(async () => []) };
    expect(await gatewayRequestCount(empty as never, span)).toBe(0);
  });

  it("returns null when the gateway probe fails", async () => {
    const failing = {
      listSpendLogs: vi.fn(async () => {
        throw new Error("gateway unreachable");
      }),
    };
    expect(await gatewayRequestCount(failing as never, span)).toBeNull();
  });

  it("callbackErrorRate: 0 without rejections, null without traffic or on probe failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse([{ "count()": 0 }])));
    expect(await callbackErrorRate(WINDOW, 100, CH)).toBe(0);
    vi.stubGlobal("fetch", vi.fn(async () => okResponse([{ "count()": 5 }])));
    expect(await callbackErrorRate(WINDOW, 100, CH)).toBe(0.05);
    expect(await callbackErrorRate(WINDOW, 0, CH)).toBeNull();
    expect(await callbackErrorRate(WINDOW, null, CH)).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));
    expect(await callbackErrorRate(WINDOW, 100, CH)).toBeNull();
  });

  it("caps the callback error rate at 1", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse([{ "count()": 500 }])));
    expect(await callbackErrorRate(WINDOW, 100, CH)).toBe(1);
  });
});
