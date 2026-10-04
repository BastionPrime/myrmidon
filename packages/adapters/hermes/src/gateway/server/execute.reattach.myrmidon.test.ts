import { describe, expect, it, vi, afterEach } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute, readReattachGatewayRunIdForTest, stopGatewayRunForBoard } from "./execute.js";

// myrmidon(HERMES-RUN-REATTACH): after a board restart, the reattach sweep
// re-dispatches the same heartbeat run with the gateway run id it persisted
// at create time. The adapter must attach to that run instead of creating a
// second one, and must report the id back through onExternalRunId so the row
// keeps it. A gateway that no longer knows the run (404) falls back to the
// ordinary create path with this attempt's own Idempotency-Key.

function makeCtx(config: Record<string, unknown>): AdapterExecutionContext {
  return {
    runId: "pc-run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Hermes",
      adapterType: "hermes_gateway",
      adapterConfig: config,
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config,
    context: {
      issueId: "issue-1",
      wakeReason: "manual",
      paperclipWake: {
        issue: { identifier: "PAP-1", title: "Do the thing" },
      },
    },
    onLog: vi.fn(async () => undefined),
    onMeta: vi.fn(async () => undefined),
    onExternalRunId: vi.fn(async () => undefined),
  };
}

function sseStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("execute — gateway run reattach (HERMES-RUN-REATTACH)", () => {
  it("reads the reattach id from the context", () => {
    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "k" });
    expect(readReattachGatewayRunIdForTest(ctx)).toBeNull();
    ctx.context = { ...ctx.context, reattachGatewayRunId: "run-live-1" };
    expect(readReattachGatewayRunIdForTest(ctx)).toBe("run-live-1");
  });

  it("attaches to a live gateway run instead of creating a second one", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        calls.push("create");
        return new Response(JSON.stringify({ run_id: "run-new", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        calls.push("events");
        return new Response(
          sseStream(["event: run.completed", "data: {\"status\":\"completed\",\"output\":\"reattached done\"}", ""].join("\n")),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      if (init?.method === "GET" && url.endsWith("/v1/runs/run-live-1")) {
        calls.push("probe");
        return new Response(JSON.stringify({ status: "running", run_id: "run-live-1" }), { status: 200 });
      }
      calls.push("status");
      return new Response(JSON.stringify({ status: "running" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "k",
      timeoutSec: 5,
    });
    ctx.context = { ...ctx.context, reattachGatewayRunId: "run-live-1" };

    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("reattached done");
    // The create was skipped entirely — the gateway run is the reattached one.
    expect(calls).not.toContain("create");
    expect(calls).toContain("probe");
    expect(calls).toContain("events");
    // The id is reported back so the run row keeps it.
    expect(ctx.onExternalRunId).toHaveBeenCalledWith("run-live-1");
    expect(result.sessionParams).toMatchObject({ hermesRunId: "run-live-1" });
  });

  it("attaches to an already-terminal gateway run and reads its result back", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        calls.push("create");
        return new Response(JSON.stringify({ run_id: "run-new", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        calls.push("events");
        return new Response("no stream", { status: 503 });
      }
      if (init?.method === "GET" && url.endsWith("/v1/runs/run-done-1")) {
        calls.push("probe");
        return new Response(
          JSON.stringify({ status: "completed", run_id: "run-done-1", output: "finished while down" }),
          { status: 200 },
        );
      }
      calls.push("status");
      return new Response(JSON.stringify({ status: "completed", output: "finished while down" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "k",
      timeoutSec: 5,
      pollIntervalMs: 250,
    });
    ctx.context = { ...ctx.context, reattachGatewayRunId: "run-done-1" };

    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("finished while down");
    expect(calls).not.toContain("create");
  });

  it("falls back to an ordinary create when the gateway no longer knows the run", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        calls.push("create");
        return new Response(JSON.stringify({ run_id: "run-new", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        calls.push("events");
        return new Response(
          sseStream(["event: run.completed", "data: {\"status\":\"completed\",\"output\":\"done\"}", ""].join("\n")),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      if (init?.method === "GET" && url.endsWith("/v1/runs/run-gone-1")) {
        calls.push("probe");
        return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      }
      calls.push("status");
      return new Response(JSON.stringify({ status: "completed" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "k",
      timeoutSec: 5,
    });
    ctx.context = { ...ctx.context, reattachGatewayRunId: "run-gone-1" };

    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(calls).toContain("probe");
    expect(calls).toContain("create");
    // The fallback create keeps this attempt's own Idempotency-Key.
    const createCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith("/v1/runs"));
    const init = createCall?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe("pc-run-1");
  });

  it("reports the gateway run id through onExternalRunId immediately after a create", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-fresh-1", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response(
          sseStream(["event: run.completed", "data: {\"status\":\"completed\",\"output\":\"done\"}", ""].join("\n")),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "k",
      timeoutSec: 5,
    });

    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(ctx.onExternalRunId).toHaveBeenCalledWith("run-fresh-1");
  });

  it("treats a 429 create rejection as a transient busy wait with the gateway's Retry-After", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: "gateway busy" }), {
        status: 429,
        headers: { "retry-after": "7" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "k",
    });

    const result = await execute(ctx);

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_rate_limited");
    expect(result.errorFamily).toBe("transient_upstream");
    // Retry-After is surfaced as the retry hint the bounded retry follows.
    expect(result.retryNotBefore).not.toBeNull();
  });

  it("stopGatewayRunForBoard posts a bounded stop for an unsupervised run", async () => {
    const seen: Array<{ url: string; method: string; auth: string }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        url: String(input),
        method: String(init?.method ?? "GET"),
        auth: (init?.headers as Record<string, string>).Authorization ?? "",
      });
      return new Response(JSON.stringify({ stopped: true }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const stopped = await stopGatewayRunForBoard({
      baseUrl: "http://127.0.0.1:8642",
      apiKey: "board-key",
      gatewayRunId: "gw-run-9",
    });

    expect(stopped.stopped).toBe(true);
    expect(seen).toEqual([
      {
        url: "http://127.0.0.1:8642/v1/runs/gw-run-9/stop",
        method: "POST",
        auth: "Bearer board-key",
      },
    ]);
  });

  it("stopGatewayRunForBoard reports not-stopped without throwing when the gateway forgot the run", async () => {
    const fetchMock = vi.fn(async () => new Response("gone", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    const stopped = await stopGatewayRunForBoard({
      baseUrl: "http://127.0.0.1:8642",
      apiKey: "board-key",
      gatewayRunId: "gw-run-gone",
    });

    expect(stopped.stopped).toBe(false);
  });

  it("stopGatewayRunForBoard rejects a malformed base URL instead of guessing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const stopped = await stopGatewayRunForBoard({
      baseUrl: "not a url",
      apiKey: "board-key",
      gatewayRunId: "gw-run-9",
    });

    expect(stopped.stopped).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
