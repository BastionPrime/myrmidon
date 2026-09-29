import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi, afterEach } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute, mapFinalResultForTest, parseSseFramesForTest, resolveSessionKey } from "./execute.js";
import { testEnvironment } from "./test.js";
import {
  CREATE_CANCEL_GRACE_MS,
  CREATE_REQUEST_TIMEOUT_MS,
  DEFAULT_TIMEOUT_SEC,
  STOP_GRACE_MS,
  STOP_REQUEST_TIMEOUT_MS,
} from "../shared/constants.js";
// myrmidon(G4): parse compact log lines through the real shared parser
// (rather than substring-matching the raw line) so a regression that changes
// the line's *shape* without changing its substrings still fails this test —
// see the tool.completed preview-caching test below.
import { parseHermesStdoutLine } from "../../ui/parse-stdout.js";

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

/** myrmidon(G4): AbortSignal.timeout() runs on Node's own timers, which
 * vi.useFakeTimers() does not fake. Replace the signal for one specific
 * timeout length with an AbortController driven by the (faked) setTimeout,
 * and hand back every signal created that way so a test can assert each one
 * really fired with a TimeoutError. */
function fakeAbortSignalTimeout(matchMs: number): { signals: AbortSignal[]; restore: () => void } {
  const signals: AbortSignal[] = [];
  const realTimeout = AbortSignal.timeout.bind(AbortSignal);
  const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
    if (ms !== matchMs) return realTimeout(ms);
    const requestController = new AbortController();
    setTimeout(
      () => requestController.abort(new DOMException("The operation timed out.", "TimeoutError")),
      ms,
    ).unref();
    signals.push(requestController.signal);
    return requestController.signal;
  });
  return { signals, restore: () => spy.mockRestore() };
}

/** A fetch() reply that never arrives, but honours the request's own signal
 * the way a real fetch does (rejects with the signal's reason on abort). */
function hangUntilAborted(init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    signal.addEventListener(
      "abort",
      () => reject(signal.reason ?? new DOMException("aborted", "AbortError")),
      { once: true },
    );
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  // myrmidon(G4): a no-op when timers are already real — belt-and-braces so
  // a test that uses vi.useFakeTimers() (the request-timeout tests below)
  // can never leak fake timers into a later test if it exits early.
  vi.useRealTimers();
});

describe("resolveSessionKey", () => {
  it("derives issue-scoped session keys by default", () => {
    expect(
      resolveSessionKey({
        strategy: "issue",
        companyId: "company-1",
        agentId: "agent-1",
        runId: "run-1",
        issueId: "issue-1",
      }),
    ).toBe("paperclip:company:company-1:agent:agent-1:issue:issue-1");
  });

  it("omits the session key for none strategy", () => {
    expect(
      resolveSessionKey({
        strategy: "none",
        companyId: "company-1",
        agentId: "agent-1",
        runId: "run-1",
        issueId: "issue-1",
      }),
    ).toBeNull();
  });
});

describe("parseSseFramesForTest", () => {
  it("parses event and data lines while preserving partial frames", () => {
    const parsed = parseSseFramesForTest("event: message.delta\ndata: {\"delta\":\"hi\"}\n\n:data\ndata: later");
    expect(parsed.frames).toEqual([{ event: "message.delta", data: "{\"delta\":\"hi\"}" }]);
    expect(parsed.rest).toBe(":data\ndata: later");
  });
});

describe("execute", () => {
  it("rejects remote plain HTTP unless the unsafe dev escape hatch is enabled", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ run_id: "unexpected" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(makeCtx({
      apiBaseUrl: "http://192.168.1.25:8642",
      apiKey: "secret-key",
    }));

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_plain_http_remote_denied");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports dispatch before starting the remote run create request", async () => {
    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      timeoutSec: 5,
    });
    const onDispatch = vi.fn();
    ctx.onDispatch = onDispatch;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        expect(onDispatch).toHaveBeenCalledTimes(1);
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response(
          sseStream(["event: run.completed", "data: {\"status\":\"completed\",\"output\":\"done\"}", ""].join("\n")),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(onDispatch).toHaveBeenCalledTimes(1);
  });

  it("constructs POST /v1/runs with auth, idempotency, and Hermes session headers", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response(
          sseStream(
            [
              "event: message.delta",
              "data: {\"delta\":\"done\"}",
              "",
              "event: run.completed",
              "data: {\"status\":\"completed\",\"output\":\"done\",\"session_id\":\"session-1\",\"usage\":{\"input_tokens\":3,\"output_tokens\":2},\"model\":\"hermes-agent\"}",
              "",
            ].join("\n"),
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      timeoutSec: 5,
    }));

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("done");
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2 });

    const calls = fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
    const createCall = calls.find(([input]) => String(input).endsWith("/v1/runs"));
    expect(createCall).toBeTruthy();
    const init = createCall?.[1] as RequestInit;
    expect(init.headers).toMatchObject({
      Authorization: "Bearer secret-key",
      "Content-Type": "application/json",
      "Idempotency-Key": "pc-run-1",
      "X-Hermes-Session-Key": "paperclip:company:company-1:agent:agent-1:issue:issue-1",
    });
    const body = JSON.parse(String(init.body));
    expect(body.input).toContain("Do the thing");
    expect(body.session_id).toBe("paperclip:company:company-1:agent:agent-1:issue:issue-1");
  });

  it.each([false, true])("preserves chat handoff policy on gateway turns (resumed=%s)", async (resumed) => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(
      String(input).endsWith("/v1/runs")
        ? { run_id: "run-hermes-1", status: "started" }
        : { status: "completed", output: "done" },
    ), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 5 });
    ctx.config.payloadTemplate = { input: "Custom gateway instruction." };
    const directive = "Chat directive: clarify goals and hand plans off to project tasks.";
    ctx.context = {
      conversationMode: true,
      issueId: "issue-1",
      paperclipTaskMarkdown: directive,
      paperclipTaskMarkdownCompact: directive,
      paperclipWake: {
        reason: "issue_commented",
        issue: { id: "issue-1", workMode: "planning", status: "in_progress" },
        interactionKind: "request_confirmation",
        interactionStatus: "accepted",
      },
    };
    if (resumed) ctx.runtime.sessionId = "prior-session";
    await execute(ctx);
    const calls = fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
    const call = calls.find(([input]) => String(input).endsWith("/v1/runs"));
    const prompt = JSON.parse(String(call?.[1]?.body)).input as string;
    expect(prompt).toContain("Custom gateway instruction.");
    expect(prompt).toContain(directive);
    expect(prompt).not.toContain("Execution contract:");
    expect(prompt).not.toContain("clear final disposition");
    expect(prompt).not.toContain("Create child issues");
  });

  it("sends the task brief once on fresh runs and compacts it on stable-session resumes", async () => {
    const description = "Update launch-card.svg and change the CTA to Try Team free.";
    const fullTaskMarkdown = [
      "Paperclip task context:",
      '- Issue: "PAP-1"',
      "",
      "Issue description:",
      "```text",
      description,
      "```",
    ].join("\n");
    const compactTaskMarkdown = ["Paperclip task context:", '- Issue: "PAP-1"'].join("\n");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const wakeContext = (reason: string) => ({
      issueId: "issue-1",
      wakeReason: reason,
      paperclipTaskMarkdown: fullTaskMarkdown,
      paperclipTaskMarkdownCompact: compactTaskMarkdown,
      paperclipWake: {
        reason,
        issue: {
          id: "issue-1",
          identifier: "PAP-1",
          title: "Do the thing",
          description,
          descriptionTruncated: false,
          status: "in_progress",
        },
        commentWindow: { requestedCount: 0, includedCount: 0, missingCount: 0 },
        comments: [],
        fallbackFetchNeeded: false,
      },
    });

    const freshCtx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 5 });
    freshCtx.context = wakeContext("issue_assigned");
    await execute(freshCtx);

    const resumeCtx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 5 });
    resumeCtx.context = wakeContext("issue_commented");
    resumeCtx.runtime = {
      sessionId: "session-1",
      sessionParams: null,
      sessionDisplayId: "session-1",
      taskKey: "PAP-1",
    };
    await execute(resumeCtx);

    const calls = fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
    const runBodies = calls
      .filter(([input]) => String(input).endsWith("/v1/runs"))
      .map(([, init]) => JSON.parse(String(init?.body)) as { input: string });
    expect(runBodies).toHaveLength(2);
    // Fresh run: brief exactly once (task markdown only; wake-prompt copy suppressed).
    expect(runBodies[0]!.input.split(description)).toHaveLength(2);
    // Stable-session resume: compact task markdown, no re-sent brief.
    expect(runBodies[1]!.input).toContain("Paperclip task context:");
    expect(runBodies[1]!.input).not.toContain(description);
  });

  it("routes a bare Hermes dashboard URL on port 9119 through the API prefix", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "http://127.0.0.1:9119/api/v1/runs") {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      if (url === "http://127.0.0.1:9119/api/v1/runs/run-hermes-1/events") {
        return new Response(
          sseStream(
            [
              "event: run.completed",
              "data: {\"status\":\"completed\",\"output\":\"done\"}",
              "",
            ].join("\n"),
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:9119",
      apiKey: "secret-key",
      timeoutSec: 5,
    });
    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(ctx.onMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        commandArgs: ["http://127.0.0.1:9119/api/v1/runs"],
      }),
    );
    expect((ctx.onLog as ReturnType<typeof vi.fn>).mock.calls.map(([, line]) => String(line)).join("\n"))
      .toContain("creating run at http://127.0.0.1:9119/api/v1/runs");
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual(
      expect.arrayContaining([
        "http://127.0.0.1:9119/api/v1/runs",
        "http://127.0.0.1:9119/api/v1/runs/run-hermes-1/events",
      ]),
    );
  });

  it("routes the default Hermes dashboard chat URL on port 9119 through the API prefix", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "http://127.0.0.1:9119/api/v1/runs") {
        return new Response(JSON.stringify({ run_id: "run-hermes-chat", status: "started" }), { status: 200 });
      }
      if (url === "http://127.0.0.1:9119/api/v1/runs/run-hermes-chat/events") {
        return new Response(
          sseStream(
            [
              "event: run.completed",
              "data: {\"status\":\"completed\",\"output\":\"done\"}",
              "",
            ].join("\n"),
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:9119/chat",
      apiKey: "secret-key",
      timeoutSec: 5,
    });
    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(ctx.onMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        commandArgs: ["http://127.0.0.1:9119/api/v1/runs"],
      }),
    );
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual(
      expect.arrayContaining([
        "http://127.0.0.1:9119/api/v1/runs",
        "http://127.0.0.1:9119/api/v1/runs/run-hermes-chat/events",
      ]),
    );
  });

  it("redacts echoed auth material from stream logs and summaries", async () => {
    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      timeoutSec: 5,
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response(
          sseStream(
            [
              "event: message.delta",
              "data: {\"delta\":\"Authorization: Bearer secret-key\\nX-Hermes-Session-Key: paperclip:company:company-1:agent:agent-1:issue:issue-1\"}",
              "",
              "event: run.completed",
              "data: {\"status\":\"completed\",\"output\":\"Authorization: Bearer secret-key\\nraw key secret-key\\nX-Hermes-Session-Key: paperclip:company:company-1:agent:agent-1:issue:issue-1\"}",
              "",
            ].join("\n"),
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(ctx);
    const logText = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls.map(([, line]) => String(line)).join("\n");

    expect(result.exitCode).toBe(0);
    expect(result.summary).toContain("Bearer [redacted]");
    expect(result.summary).toContain("raw key [redacted len=10]");
    expect(result.summary).toContain("X-Hermes-Session-Key: [redacted]");
    expect(result.summary).not.toContain("secret-key");
    expect(result.summary).not.toContain("paperclip:company:company-1:agent:agent-1:issue:issue-1");
    expect(result.resultJson?.output).toBe(result.summary);
    expect(logText).toContain("Bearer [redacted]");
    expect(logText).toContain("X-Hermes-Session-Key: [redacted]");
    expect(logText).not.toContain("secret-key");
    expect(logText).not.toContain("paperclip:company:company-1:agent:agent-1:issue:issue-1");
  });

  it("redacts agent-scoped Paperclip session keys from logs and public result metadata", async () => {
    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      sessionKeyStrategy: "agent",
      timeoutSec: 5,
    });
    const agentSessionKey = "paperclip:company:company-1:agent:agent-1";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response(
          sseStream(
            [
              "event: message.delta",
              `data: {"delta":"session ${agentSessionKey}"}`,
              "",
              "event: run.completed",
              `data: {"status":"completed","output":"session ${agentSessionKey}","session_id":"${agentSessionKey}"}`,
              "",
            ].join("\n"),
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(ctx);
    const logText = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls.map(([, line]) => String(line)).join("\n");

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("session [redacted-session-key]");
    expect(result.sessionId).toBe("[redacted-session-key]");
    expect(result.sessionDisplayId).toBe("[redacted-session-key]");
    expect(result.resultJson?.session_id).toBe("[redacted-session-key]");
    expect(result.sessionParams).toEqual({
      hermesRunId: "run-hermes-1",
      strategy: "agent",
    });
    expect(logText).toContain("[redacted-session-key]");
    expect(logText).not.toContain(agentSessionKey);
  });

  it("falls back to polling when SSE is unavailable", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response("no stream", { status: 503 });
      }
      return new Response(JSON.stringify({
        status: "completed",
        output: "polled done",
        session_id: "session-polled",
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      timeoutSec: 5,
      pollIntervalMs: 250,
    }));

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("polled done");
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/v1/runs/run-hermes-1"))).toBe(true);
  });

  it("maps HTTP auth failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "bad key" }), { status: 401 })));
    const result = await execute(makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
    }));
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_auth_failed");
    expect(result.errorMessage).toContain("Check adapterConfig.apiKey matches the Hermes API_SERVER_KEY");
  });

  it("includes network causes in connection failure messages", async () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND host.docker.internal"), { code: "ENOTFOUND" });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw Object.assign(new Error("fetch failed"), { cause });
    }));

    const result = await execute(makeCtx({
      apiBaseUrl: "http://host.docker.internal:8642",
      apiKey: "secret-key",
      dangerouslyAllowInsecureRemoteHttp: true,
    }));

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_connect_failed");
    expect(result.errorMessage).toContain("ENOTFOUND");
    expect(result.errorMessage).toContain("host.docker.internal");
  });

  it("redacts echoed auth material from HTTP error payloads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            message: "Authorization rejected: Bearer secret-key raw secret-key",
            detail: "X-Hermes-Session-Key: paperclip:company:company-1:agent:agent-1:issue:issue-1",
            nested: {
              note: "session paperclip:company:company-1:agent:agent-1",
            },
          }),
          { status: 401 },
        )),
    );

    const result = await execute(makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
    }));

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_auth_failed");
    expect(result.errorMeta?.body).toEqual({
      message: "Authorization rejected: Bearer [redacted] raw [redacted len=10]",
      detail: "X-Hermes-Session-Key: [redacted]",
      nested: {
        note: "session [redacted-session-key]",
      },
    });
    expect(result.errorMessage).not.toContain("secret-key");
    expect(result.errorMessage).not.toContain("paperclip:company:company-1:agent:agent-1:issue:issue-1");
  });

  it("calls stop on timeout", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-slow", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Promise<Response>(() => {});
      }
      if (url.endsWith("/stop")) {
        return new Response(JSON.stringify({ status: "stopping" }), { status: 200 });
      }
      if (init?.method === "GET") {
        return new Response(JSON.stringify({ status: "cancelled", last_event: "run.cancelled" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "running" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      timeoutSec: 0.001,
    }));

    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("hermes_gateway_timeout");
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/stop"))).toBe(true);
  });
});

describe("testEnvironment", () => {
  it("fails remote plain HTTP before probing health", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "hermes_gateway",
      config: {
        apiBaseUrl: "http://hermes.example:8642",
        apiKey: "secret-key",
      },
    });

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_plain_http_remote_denied",
          level: "error",
        }),
      ]),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows remote plain HTTP only with the unsafe dev escape hatch", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "hermes_gateway",
      config: {
        apiBaseUrl: "http://hermes.example:8642",
        apiKey: "secret-key",
        dangerouslyAllowInsecureRemoteHttp: true,
      },
    });

    expect(result.status).toBe("warn");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_plain_http_remote_unsafe_allowed",
          level: "warn",
        }),
        expect.objectContaining({
          code: "hermes_gateway_health_ok",
        }),
      ]),
    );
    expect(fetchMock).toHaveBeenCalled();
  });

  it("fails test environment checks when Hermes health is unreachable", async () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND host.docker.internal"), { code: "ENOTFOUND" });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw Object.assign(new Error("fetch failed"), { cause });
    }));

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "hermes_gateway",
      config: {
        apiBaseUrl: "http://host.docker.internal:8642",
        apiKey: "secret-key",
        dangerouslyAllowInsecureRemoteHttp: true,
      },
    });

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_health_unreachable",
          level: "error",
          detail: expect.stringContaining("ENOTFOUND"),
        }),
      ]),
    );
  });

  it("fails test environment checks when Hermes health returns a non-ok status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad key", { status: 401 })));

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "hermes_gateway",
      config: {
        apiBaseUrl: "http://127.0.0.1:8642",
        apiKey: "wrong-key",
      },
    });

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_health_failed",
          level: "error",
          message: "Hermes Gateway health endpoint returned HTTP 401.",
        }),
      ]),
    );
  });

  it("tests a bare Hermes dashboard URL on port 9119 through the API prefix", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "hermes_gateway",
      config: {
        apiBaseUrl: "http://127.0.0.1:9119",
        apiKey: "secret-key",
      },
    });

    expect(result.status).toBe("pass");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_dashboard_root_mapped",
          level: "info",
          message: "Default Hermes dashboard root mapped to API base http://127.0.0.1:9119/api.",
          hint: expect.stringContaining("/api/v1/runs"),
        }),
      ]),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:9119/api/health",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("tests a Hermes dashboard chat URL on port 9119 through the API prefix", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "hermes_gateway",
      config: {
        apiBaseUrl: "http://127.0.0.1:9119/chat",
        apiKey: "secret-key",
      },
    });

    expect(result.status).toBe("pass");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_dashboard_root_mapped",
          level: "info",
          message: "Default Hermes dashboard root mapped to API base http://127.0.0.1:9119/api.",
        }),
      ]),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:9119/api/health",
      expect.objectContaining({ method: "GET" }),
    );
  });
});

describe("mapFinalResultForTest", () => {
  it("maps failed statuses into adapter errors", () => {
    const result = mapFinalResultForTest({
      terminal: {
        runId: "run-1",
        status: "failed",
        payload: { status: "failed", error: "boom" },
      },
      outputChunks: [],
      sessionKey: "session-key",
      strategy: "issue",
    });
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_run_failed");
    expect(result.errorMessage).toBe("boom");
  });
});

// myrmidon(G4): defaults, cancellation, approvals, per-run model, instructions
// bundle, compact progress logging, and idempotent retry attach.

describe("gateway defaults (G4)", () => {
  it("defaults timeoutSec to 1800, matching hermes_local", () => {
    expect(DEFAULT_TIMEOUT_SEC).toBe(1800);
  });
});

describe("execute — operator cancellation (G4)", () => {
  it("registers onCancellationReady before POST /v1/runs, then stops and reports a verified cancellation on operator abort", async () => {
    // myrmidon(G4): types.ts's contract is "opt in ... before starting
    // provider work" — onCancellationReady must fire before the create
    // request, not after it.
    const controller = new AbortController();
    const callOrder: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        callOrder.push("create");
        return new Response(JSON.stringify({ run_id: "run-cancel-1", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        // The operator's abort arrives once the run is under way (after
        // create, while the adapter is listening for events) — not during
        // onCancellationReady's own handshake.
        controller.abort();
        return new Promise<Response>(() => {}); // never resolves
      }
      if (url.endsWith("/stop")) {
        callOrder.push("stop");
        return new Response(JSON.stringify({ status: "stopping" }), { status: 200 });
      }
      if (init?.method === "GET") {
        return new Response(JSON.stringify({ status: "cancelled", last_event: "run.cancelled" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "running" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 30 });
    ctx.signal = controller.signal;
    ctx.onCancellationReady = vi.fn(async () => {
      expect(callOrder).toEqual([]);
      callOrder.push("ready");
    });

    const result = await execute(ctx);

    expect(callOrder).toEqual(["ready", "create", "stop"]);
    expect(ctx.onCancellationReady).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(false);
    expect(result.errorCode).toBe("hermes_gateway_cancelled");
    // myrmidon(G4): the platform's cancelRun (heartbeat.ts) 409s the pause
    // request unless the adapter's own resultJson confirms
    // executionCancellation.state === "acknowledged"; omitting it (the
    // previous behavior, unconditionally) made every clean stop 409 anyway.
    expect(result.resultJson?.executionCancellation).toMatchObject({
      state: "acknowledged",
      forced: false,
    });
  });

  it("does not claim cancellation acknowledged when the post-stop status check cannot verify termination", async () => {
    // The mirror image of the test above: fetchFinalStatus never observes a
    // terminal Hermes status (the GET keeps failing), so the adapter must
    // not claim "acknowledged" — an honest "unverified" lets the platform's
    // own 409 stand instead of a false all-clear. It only gives up once
    // STOP_GRACE_MS is used up, not on the first failed GET, hence the fake
    // clock: the real one would make this test sit out the whole grace period.
    vi.useFakeTimers();
    const controller = new AbortController();
    let stopped = false;
    let statusChecksAfterStop = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-cancel-2", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        controller.abort();
        return new Promise<Response>(() => {});
      }
      if (url.endsWith("/stop")) {
        stopped = true;
        return new Response(JSON.stringify({ status: "stopping" }), { status: 200 });
      }
      if (init?.method === "GET") {
        if (stopped) statusChecksAfterStop += 1;
        return new Response(JSON.stringify({ error: "unreachable" }), { status: 503 });
      }
      return new Response(JSON.stringify({ status: "running" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 30 });
    ctx.signal = controller.signal;
    ctx.onCancellationReady = vi.fn(async () => undefined);

    let settled = false;
    const resultPromise = execute(ctx).finally(() => {
      settled = true;
    });
    for (let advanced = 0; !settled && advanced <= 2 * STOP_GRACE_MS; advanced += 500) {
      await vi.advanceTimersByTimeAsync(500);
    }
    const result = await resultPromise;
    vi.useRealTimers();

    expect(result.errorCode).toBe("hermes_gateway_cancelled");
    expect(result.resultJson?.executionCancellation).toBeUndefined();
    // Kept asking for the whole grace period instead of giving up on the
    // first failed check.
    expect(statusChecksAfterStop).toBeGreaterThan(2);
  });

  it("keeps polling the run status after one failed check and confirms the stop once a later check sees it terminal", async () => {
    // myrmidon(G4): fetchFinalStatus used to `return null` on the first
    // thrown GET (a 5xx, or its own request timeout), so a single blip
    // dropped the confirmation, the platform's Stop 409'd, and the run went
    // to manual reconciliation although the very next check would have seen
    // the run stopped.
    const controller = new AbortController();
    let stopped = false;
    let statusChecksAfterStop = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-cancel-blip", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        controller.abort();
        return new Promise<Response>(() => {});
      }
      if (url.endsWith("/stop")) {
        stopped = true;
        return new Response(JSON.stringify({ status: "stopping" }), { status: 200 });
      }
      if (init?.method === "GET" && stopped) {
        statusChecksAfterStop += 1;
        if (statusChecksAfterStop === 1) {
          return new Response(JSON.stringify({ error: "unreachable" }), { status: 503 });
        }
        return new Response(JSON.stringify({ status: "cancelled", last_event: "run.cancelled" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "running" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 30 });
    ctx.signal = controller.signal;
    ctx.onCancellationReady = vi.fn(async () => undefined);

    const result = await execute(ctx);

    expect(statusChecksAfterStop).toBe(2);
    expect(result.errorCode).toBe("hermes_gateway_cancelled");
    expect(result.resultJson?.status).toBe("cancelled");
    expect(result.resultJson?.executionCancellation).toMatchObject({
      state: "acknowledged",
      forced: false,
    });
  });

  it("acknowledges cancellation without creating a run when ctx.signal is already aborted", async () => {
    // myrmidon(G4): a signal aborted before or during onCancellationReady
    // must stop the adapter from ever creating a Hermes run for a Paperclip
    // run that is already cancelled.
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn(async () => {
      throw new Error("must not call the Hermes gateway once the run is already cancelled");
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 30 });
    ctx.signal = controller.signal;
    ctx.onCancellationReady = vi.fn(async () => undefined);

    const result = await execute(ctx);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(ctx.onCancellationReady).toHaveBeenCalledTimes(1);
    expect(result.errorCode).toBe("hermes_gateway_cancelled");
    expect(result.executionRecovery).toEqual({ kind: "bootstrap", providerWorkStarted: false });
    expect(result.resultJson?.executionCancellation).toMatchObject({
      state: "acknowledged",
      forced: false,
    });
  });

  it("still honors an already-aborted ctx.signal when the caller supplies no onCancellationReady", async () => {
    // ctx.signal is the actual cancellation mechanism; onCancellationReady is
    // only the readiness handshake back to the platform. A caller that sets
    // ctx.signal without also providing onCancellationReady (unusual, but the
    // field is optional) still gets a clean, immediate cancellation instead
    // of a hang, a crash, or an orphaned Hermes run.
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn(async () => {
      throw new Error("must not call the Hermes gateway once the run is already cancelled");
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 5 });
    ctx.signal = controller.signal;
    // onCancellationReady intentionally left undefined.

    const result = await execute(ctx);
    expect(result.errorCode).toBe("hermes_gateway_cancelled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bounds the stop and status-check requests with a request timeout, well inside the platform's 60s stop deadline", async () => {
    // myrmidon(G4): stopRun/fetchFinalStatus previously issued their POST
    // .../stop and GET .../{runId} requests with no signal at all, so a
    // gateway that accepted the TCP connection but never responded could
    // block execute()'s return past the platform's 60s waitForAdapterStop
    // deadline (adapter-execution-control.ts) instead of returning inside
    // STOP_GRACE_MS. The previous version of this test only asserted that
    // *some* AbortSignal was passed — a signal that is never aborted would
    // satisfy that too — so it never actually redlined without the fix.
    vi.useFakeTimers();
    const opCancel = new AbortController();
    const stopTimeouts = fakeAbortSignalTimeout(STOP_REQUEST_TIMEOUT_MS);

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-cancel-3", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        opCancel.abort();
        return new Promise<Response>(() => {});
      }
      // /stop, fetchFinalStatus's GET, and pollStatus's own background GET
      // all hang until their own signal fires — none of them get a response
      // from this fixture.
      return hangUntilAborted(init);
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 30 });
    ctx.signal = opCancel.signal;
    ctx.onCancellationReady = vi.fn(async () => undefined);

    const before = Date.now();
    const timing = { finishedAt: null as number | null };
    const resultPromise = execute(ctx).then((value) => {
      timing.finishedAt = Date.now();
      return value;
    });
    // The /stop request times out first, then each of fetchFinalStatus's GETs
    // in turn until STOP_GRACE_MS is used up (a failed check no longer ends
    // the confirmation early), so the last GET can start just inside the
    // deadline and still run out its own request timeout.
    const worstCaseMs = STOP_REQUEST_TIMEOUT_MS + STOP_GRACE_MS + STOP_REQUEST_TIMEOUT_MS;
    for (let advanced = 0; timing.finishedAt === null && advanced <= worstCaseMs; advanced += 500) {
      await vi.advanceTimersByTimeAsync(500);
    }
    const result = await resultPromise;
    const elapsedMs = (timing.finishedAt ?? Date.now()) - before;

    stopTimeouts.restore();
    vi.useRealTimers();

    expect(stopTimeouts.signals.length).toBeGreaterThanOrEqual(2);
    for (const signal of stopTimeouts.signals) {
      expect(signal.aborted).toBe(true);
      expect((signal.reason as DOMException | undefined)?.name).toBe("TimeoutError");
    }
    expect(elapsedMs).toBeLessThan(60_000);
    expect(elapsedMs).toBeLessThanOrEqual(worstCaseMs);
    expect(result.errorCode).toBe("hermes_gateway_cancelled");
    // Every /stop and status-check request timed out — fetchFinalStatus
    // never observed a terminal Hermes status, so termination is
    // unverified and this must not claim acknowledged.
    expect(result.resultJson?.executionCancellation).toBeUndefined();
  });

  it("cuts off an in-flight create request once cancellation arrives, without claiming the outcome verified", async () => {
    // myrmidon(G4): POST /v1/runs previously carried no signal at all —
    // onCancellationReady had already fired, but a hung gateway (TCP
    // accepted, never answers) could still block execute()'s return past
    // the platform's 60s waitForAdapterStop deadline. See
    // CREATE_REQUEST_TIMEOUT_MS/CREATE_CANCEL_GRACE_MS.
    vi.useFakeTimers();
    const opCancel = new AbortController();
    const createSignals: Array<AbortSignal | undefined> = [];
    const requestedUrls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requestedUrls.push(url);
      if (!url.endsWith("/v1/runs")) throw new Error(`unexpected request to ${url}`);
      createSignals.push(init?.signal ?? undefined);
      // The operator cancels while this request is still outstanding —
      // Hermes never gets a chance to answer within this test.
      opCancel.abort();
      return hangUntilAborted(init);
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 30 });
    ctx.signal = opCancel.signal;
    ctx.onCancellationReady = vi.fn(async () => undefined);

    const before = Date.now();
    const resultPromise = execute(ctx);
    // Still inside the grace window: the request must not have been cut off
    // yet (its response, with a run_id, may already be on the wire).
    await vi.advanceTimersByTimeAsync(CREATE_CANCEL_GRACE_MS - 1);
    expect(createSignals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await resultPromise;
    const elapsedMs = Date.now() - before;
    vi.useRealTimers();

    expect(createSignals[0]?.aborted).toBe(true);
    // Only the create request was ever issued: no /stop for a run id that
    // was never returned.
    expect(requestedUrls).toEqual(["http://127.0.0.1:8642/v1/runs"]);
    // Well inside the platform's 60s waitForAdapterStop deadline: bounded by
    // the grace window itself, not by undici's own (300s) default.
    expect(elapsedMs).toBeLessThanOrEqual(CREATE_CANCEL_GRACE_MS);
    expect(result.errorCode).toBe("hermes_gateway_cancelled");
    expect(result.errorCode).not.toBe("hermes_gateway_connect_failed");
    expect(result.errorFamily ?? null).toBeNull();
    expect(result.signal).toBe("SIGTERM");
    // Hermes may already have admitted the run under this Idempotency-Key —
    // this must not claim acknowledged cancellation or "never started".
    expect(result.resultJson?.executionCancellation).toBeUndefined();
    expect(result.executionRecovery).toBeUndefined();
  });

  it("times a create request out on its own, under a code that is not connect_failed and not provider-never-started", async () => {
    // myrmidon(G4): same hung gateway, but nobody cancels — the create
    // request's own CREATE_REQUEST_TIMEOUT_MS guard must still cut it off
    // (undici's own default is 300s), and fetchJson's blanket "any fetch
    // exception is connect_failed" mapping must not swallow the reason.
    vi.useFakeTimers();
    const createTimeouts = fakeAbortSignalTimeout(CREATE_REQUEST_TIMEOUT_MS);
    const createSignals: Array<AbortSignal | undefined> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.endsWith("/v1/runs")) throw new Error(`unexpected request to ${url}`);
      createSignals.push(init?.signal ?? undefined);
      return hangUntilAborted(init);
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 30 });
    ctx.onCancellationReady = vi.fn(async () => undefined);

    const resultPromise = execute(ctx);
    await vi.advanceTimersByTimeAsync(CREATE_REQUEST_TIMEOUT_MS);
    const result = await resultPromise;
    createTimeouts.restore();
    vi.useRealTimers();

    expect(createSignals[0]?.aborted).toBe(true);
    expect(createTimeouts.signals.length).toBe(1);
    expect((createTimeouts.signals[0]?.reason as DOMException | undefined)?.name).toBe("TimeoutError");
    // myrmidon(G4): not timedOut — the platform turns timedOut into outcome
    // "timed_out" and overwrites errorCode with a bare "timeout", which would
    // lose this code and present a 15s create failure as a timeout of the
    // whole run. As a plain failure (non-zero exit, error message, no
    // signal) the adapter's own errorCode is what gets recorded.
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.signal).toBeNull();
    expect(result.errorCode).toBe("hermes_gateway_create_timeout");
    expect(result.errorFamily).toBe("transient_upstream");
    expect(result.errorMessage).toContain(`${CREATE_REQUEST_TIMEOUT_MS}ms`);
    // No recovery evidence: Hermes may already have admitted the run under
    // this Idempotency-Key, so the platform must keep holding any automatic
    // retry for reconciliation (legacyExecutionNeedsReconciliation).
    expect(result.executionRecovery).toBeUndefined();
    expect(result.resultJson?.executionCancellation).toBeUndefined();
  });

  it("lets a create request that resolves inside the cancellation grace window take the normal stop path", async () => {
    // myrmidon(G4): the grace window exists precisely so a run_id that is
    // already on the wire is not thrown away — Hermes did start the run, so
    // it must be stopped and confirmed like any other cancelled run.
    vi.useFakeTimers();
    const opCancel = new AbortController();
    const requestedUrls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requestedUrls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/v1/runs")) {
        opCancel.abort();
        // Answers 1s into the grace window.
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        return new Response(JSON.stringify({ run_id: "run-grace-1", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) return new Promise<Response>(() => {});
      if (url.endsWith("/stop")) return new Response(JSON.stringify({ status: "stopping" }), { status: 200 });
      return new Response(JSON.stringify({ status: "cancelled" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 30 });
    ctx.signal = opCancel.signal;
    ctx.onCancellationReady = vi.fn(async () => undefined);

    const resultPromise = execute(ctx);
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await resultPromise;
    vi.useRealTimers();

    expect(requestedUrls).toContain("POST http://127.0.0.1:8642/v1/runs/run-grace-1/stop");
    expect(result.errorCode).toBe("hermes_gateway_cancelled");
    expect(result.resultJson?.executionCancellation).toMatchObject({ state: "acknowledged", forced: false });
  });

  describe("a create that fails while the operator cancels", () => {
    // myrmidon(G4): a definite Hermes rejection (HTTP 4xx other than 409, or
    // a connection that never reached it) proves the run was never admitted:
    // same acknowledged + bootstrap outcome as the before-dispatch abort
    // branch. Anything ambiguous — Hermes may already have admitted the run
    // — must stay a plain error with neither claim.
    const connectError = (code: string): Error =>
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error(`connect ${code} 127.0.0.1:8642`), { code }),
      });

    const cases: Array<{
      label: string;
      respond: () => Promise<Response>;
      unambiguous: boolean;
      errorCode: string;
    }> = [
      {
        label: "HTTP 400",
        respond: async () => new Response(JSON.stringify({ error: "bad request" }), { status: 400 }),
        unambiguous: true,
        errorCode: "hermes_gateway_cancelled",
      },
      {
        label: "HTTP 429",
        respond: async () => new Response(JSON.stringify({ error: "slow down" }), { status: 429 }),
        unambiguous: true,
        errorCode: "hermes_gateway_cancelled",
      },
      {
        label: "ECONNREFUSED",
        respond: async () => {
          throw connectError("ECONNREFUSED");
        },
        unambiguous: true,
        errorCode: "hermes_gateway_cancelled",
      },
      {
        label: "ENOTFOUND",
        respond: async () => {
          throw connectError("ENOTFOUND");
        },
        unambiguous: true,
        errorCode: "hermes_gateway_cancelled",
      },
      {
        label: "HTTP 503",
        respond: async () => new Response(JSON.stringify({ error: "internal" }), { status: 503 }),
        unambiguous: false,
        errorCode: "hermes_gateway_upstream_error",
      },
      {
        // A reset can land after the request was written.
        label: "ECONNRESET",
        respond: async () => {
          throw connectError("ECONNRESET");
        },
        unambiguous: false,
        errorCode: "hermes_gateway_connect_failed",
      },
      {
        // The idempotency store saying a run under this key WAS admitted.
        label: "HTTP 409 (idempotency conflict)",
        respond: async () => new Response(JSON.stringify({ error: "conflict" }), { status: 409 }),
        unambiguous: false,
        errorCode: "hermes_gateway_idempotency_conflict",
      },
    ];

    for (const testCase of cases) {
      it(`${testCase.unambiguous ? "acknowledges as never-started" : "does not claim never-started"} on ${testCase.label}`, async () => {
        const opCancel = new AbortController();
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (!url.endsWith("/v1/runs")) throw new Error(`unexpected request to ${url}`);
          opCancel.abort();
          return testCase.respond();
        });
        vi.stubGlobal("fetch", fetchMock);

        const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 30 });
        ctx.signal = opCancel.signal;
        ctx.onCancellationReady = vi.fn(async () => undefined);

        const result = await execute(ctx);

        expect(result.errorCode).toBe(testCase.errorCode);
        if (testCase.unambiguous) {
          expect(result.executionRecovery).toEqual({ kind: "bootstrap", providerWorkStarted: false });
          expect(result.resultJson?.executionCancellation).toMatchObject({
            state: "acknowledged",
            forced: false,
          });
        } else {
          expect(result.executionRecovery).toBeUndefined();
          expect(result.resultJson?.executionCancellation).toBeUndefined();
        }
      });
    }
  });

  it("acknowledges cancellation when a poll-detected terminal status wins the race and cancellation is observed only during the final buffer flush", async () => {
    // myrmidon(G4): mirrors "flushes a trailing partial compact-progress
    // line when polling..." (below), but has ctx.signal abort during that
    // same final flush — i.e. strictly after state.terminalPromise has
    // already resolved via pollStatus's markTerminal, and strictly before
    // execute()'s own final return. A terminal Hermes status observed here
    // is verified termination; the plain mapFinalResultForTest path
    // (unconditionally, with no executionCancellation) would let the
    // platform's cancelRun 409 a run that in fact already completed.
    const opCancel = new AbortController();
    let eventsCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-poll-race", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        eventsCalls += 1;
        const sse = eventsCalls === 1
          ? ["event: message.delta", "data: {\"delta\":\"trailing partial line\"}", ""].join("\n")
          : "";
        return new Response(sseStream(sse), { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      timeoutSec: 5,
      pollIntervalMs: 250,
      eventReconnectMs: 30_000,
    });
    ctx.signal = opCancel.signal;
    ctx.onCancellationReady = vi.fn(async () => undefined);
    ctx.onLog = vi.fn(async (_stream: "stdout" | "stderr", line: string) => {
      if (line.includes("trailing partial line")) opCancel.abort();
    });

    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(result.resultJson?.executionCancellation).toMatchObject({
      state: "acknowledged",
      forced: false,
    });
  });

  it("acknowledges cancellation when it lands after the run timed out and Hermes confirms the run terminal", async () => {
    // myrmidon(G4): Promise.race already picked "timeout" here, so the
    // operator's cancellation arrives during the timeout branch's own
    // stop/final-status calls (the /stop request is what triggers it below).
    // Hermes then reports the run terminal — verified termination, so the
    // platform's cancelRun must not be left to 409 on an unacknowledged
    // "requested" state.
    const opCancel = new AbortController();
    let stopRequested = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-timeout-race", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) return new Promise<Response>(() => {});
      if (url.endsWith("/stop")) {
        stopRequested = true;
        opCancel.abort();
        return new Response(JSON.stringify({ status: "stopping" }), { status: 200 });
      }
      // pollStatus and fetchFinalStatus: running until /stop has been asked.
      return new Response(JSON.stringify({ status: stopRequested ? "cancelled" : "running" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      timeoutSec: 0.05,
    });
    ctx.signal = opCancel.signal;
    ctx.onCancellationReady = vi.fn(async () => undefined);

    const result = await execute(ctx);

    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("hermes_gateway_timeout");
    expect(result.resultJson?.executionCancellation).toMatchObject({
      state: "acknowledged",
      forced: false,
    });
  });

  it("does not acknowledge on timeout when no cancellation was requested", async () => {
    // myrmidon(G4): the mirror image — the timeout branch must not start
    // claiming cancellation acknowledged for runs nobody cancelled.
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-timeout-plain", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) return new Promise<Response>(() => {});
      if (url.endsWith("/stop")) return new Response(JSON.stringify({ status: "stopping" }), { status: 200 });
      return new Response(JSON.stringify({ status: "cancelled" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 0.001 });
    ctx.signal = new AbortController().signal;
    ctx.onCancellationReady = vi.fn(async () => undefined);

    const result = await execute(ctx);

    expect(result.errorCode).toBe("hermes_gateway_timeout");
    expect(result.resultJson?.executionCancellation).toBeUndefined();
  });
});

describe("execute — approval auto-deny (G4)", () => {
  it("denies an approval.request instead of waiting for a human, and keeps the run going", async () => {
    const approvalBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-approval-1", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/approval")) {
        approvalBodies.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({ object: "hermes.run.approval_response", choice: "deny", resolved: 1 }),
          { status: 200 },
        );
      }
      if (url.endsWith("/events")) {
        return new Response(
          sseStream(
            [
              "event: approval.request",
              "data: {\"request_id\":\"req-1\",\"command\":\"rm -rf /\"}",
              "",
              "event: run.completed",
              "data: {\"status\":\"completed\",\"output\":\"done\"}",
              "",
            ].join("\n"),
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 5 });
    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(approvalBodies).toEqual([{ choice: "deny", request_id: "req-1" }]);
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/run-approval-1/approval"))).toBe(true);

    const logText = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls.map(([, line]) => String(line)).join("\n");
    expect(logText).toContain("approval auto-denied (request_id=req-1)");
  });

  it("logs the failure and still lets the run continue when the deny request itself fails", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-approval-2", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/approval")) {
        return new Response(JSON.stringify({ error: "gone" }), { status: 409 });
      }
      if (url.endsWith("/events")) {
        return new Response(
          sseStream(
            [
              "event: approval.request",
              "data: {}",
              "",
              "event: run.completed",
              "data: {\"status\":\"completed\",\"output\":\"done\"}",
              "",
            ].join("\n"),
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 5 });
    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    const logText = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls.map(([, line]) => String(line)).join("\n");
    expect(logText).toContain("approval auto-deny request failed");
  });
});

describe("execute — subagent lifecycle events (G4)", () => {
  // Hermes forwards subagent.start / subagent.complete on the run's event
  // stream, and subagent.complete carries the child's own `status`
  // (completed / failed / interrupted / error). The delegating parent run
  // keeps going afterwards; only run.<status> ends it. Frames below use the
  // real wire shape: data-only, the event name inside the JSON.
  const dataFrame = (payload: Record<string, unknown>): string => `data: ${JSON.stringify(payload)}\n\n`;

  it.each(["completed", "failed", "interrupted", "error"])(
    "does not end the run on a subagent.complete with status %s; only run.* events are terminal",
    async (childStatus) => {
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/v1/runs")) {
          return new Response(JSON.stringify({ run_id: "run-subagent-1", status: "started" }), { status: 200 });
        }
        if (url.endsWith("/events")) {
          return new Response(
            sseStream(
              [
                dataFrame({ event: "message.delta", run_id: "run-subagent-1", delta: "Before the subagent." }),
                dataFrame({ event: "subagent.start", run_id: "run-subagent-1", subagent_id: "child-1", goal: "look it up" }),
                dataFrame({
                  event: "subagent.complete",
                  run_id: "run-subagent-1",
                  subagent_id: "child-1",
                  status: childStatus,
                  summary: "child result",
                  duration_seconds: 1.5,
                }),
                // Arrives after the first subagent finished: the run is not over.
                dataFrame({ event: "message.delta", run_id: "run-subagent-1", delta: "After the subagent." }),
                dataFrame({ event: "run.completed", run_id: "run-subagent-1", timestamp: 1 }),
              ].join(""),
            ),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          );
        }
        return new Response(JSON.stringify({ status: "running" }), { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await execute(makeCtx({
        apiBaseUrl: "http://127.0.0.1:8642",
        apiKey: "secret-key",
        timeoutSec: 5,
      }));

      // Ended on run.completed, not on the child's status: a failed or
      // interrupted child does not fail the parent run, and the output is
      // the whole reply, including what came after the subagent.
      expect(result.exitCode).toBe(0);
      expect(result.errorCode).toBeUndefined();
      expect(result.resultJson?.last_event).toBe("run.completed");
      expect(result.resultJson?.status).toBe("completed");
      expect(result.summary).toContain("Before the subagent.");
      expect(result.summary).toContain("After the subagent.");
      expect(result.summary).not.toContain("child result");
    },
  );

  it("keeps supervising the run after a subagent.complete, so a later operator cancellation still stops it", async () => {
    // Before, the child's `status: "completed"` ended execute() with the
    // partial output: /stop was never called, the Hermes run went on
    // unsupervised, and a cancellation in that window could be acknowledged
    // for a run that was not stopped.
    const opCancel = new AbortController();
    let stopCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-subagent-2", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        // One subagent.complete, then the stream stays open: the parent run
        // is still going. The operator cancels shortly after.
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                dataFrame({ event: "subagent.complete", run_id: "run-subagent-2", status: "completed", summary: "child result" }),
              ),
            );
          },
        });
        setTimeout(() => opCancel.abort(), 50);
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      if (url.endsWith("/stop")) {
        stopCalls += 1;
        return new Response(JSON.stringify({ status: "stopping" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: stopCalls > 0 ? "cancelled" : "running" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 30 });
    ctx.signal = opCancel.signal;
    ctx.onCancellationReady = vi.fn(async () => undefined);

    const result = await execute(ctx);

    expect(stopCalls).toBe(1);
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_cancelled");
    expect(result.resultJson?.last_event).toBe("subagent.complete");
    expect(result.resultJson?.executionCancellation).toMatchObject({ state: "acknowledged", forced: false });
  });
});

describe("execute — per-run model/provider/effort (G4)", () => {
  it("sends model, provider, and model_options.reasoning.effort from adapterConfig", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(
      String(input).endsWith("/v1/runs") ? { run_id: "run-model-1", status: "started" } : { status: "completed", output: "done" },
    ), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      timeoutSec: 5,
      model: "provider-a/model-a",
      provider: "provider-a",
      effort: "high",
    });
    await execute(ctx);

    const calls = fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
    const body = JSON.parse(String(calls.find(([input]) => String(input).endsWith("/v1/runs"))?.[1]?.body));
    expect(body.model).toBe("provider-a/model-a");
    expect(body.provider).toBe("provider-a");
    expect(body.model_options).toEqual({ reasoning: { effort: "high" } });
  });

  it("omits model/provider/model_options when the card sets none of them", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(
      String(input).endsWith("/v1/runs") ? { run_id: "run-model-2", status: "started" } : { status: "completed", output: "done" },
    ), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 5 });
    await execute(ctx);

    const calls = fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
    const body = JSON.parse(String(calls.find(([input]) => String(input).endsWith("/v1/runs"))?.[1]?.body));
    expect(body.model).toBeUndefined();
    expect(body.provider).toBeUndefined();
    expect(body.model_options).toBeUndefined();
  });
});

describe("execute — managed instructions bundle (G4)", () => {
  it("prepends the instructions bundle ahead of the card's instructions string", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "myrmidon-hermes-gateway-"));
    try {
      const instructionsPath = path.join(root, "AGENTS.md");
      await fs.writeFile(instructionsPath, "You are agent-a. Be terse.\n", "utf8");

      const fetchMock = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(
        String(input).endsWith("/v1/runs") ? { run_id: "run-instr-1", status: "started" } : { status: "completed", output: "done" },
      ), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      const ctx = makeCtx({
        apiBaseUrl: "http://127.0.0.1:8642",
        apiKey: "secret-key",
        timeoutSec: 5,
        instructionsFilePath: instructionsPath,
        instructions: "Card instructions string.",
      });
      await execute(ctx);

      const calls = fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
      const body = JSON.parse(String(calls.find(([input]) => String(input).endsWith("/v1/runs"))?.[1]?.body));
      expect(body.instructions).toBe("You are agent-a. Be terse.\n\n---\n\nCard instructions string.");

      const logText = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls.map(([, line]) => String(line)).join("\n");
      expect(logText).toContain(`Loaded agent instructions from ${instructionsPath}`);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to the card's instructions string alone when the bundle file is missing", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(
      String(input).endsWith("/v1/runs") ? { run_id: "run-instr-2", status: "started" } : { status: "completed", output: "done" },
    ), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      timeoutSec: 5,
      instructionsFilePath: "/nonexistent/AGENTS.md",
      instructions: "Card instructions string.",
    });
    await execute(ctx);

    const calls = fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
    const body = JSON.parse(String(calls.find(([input]) => String(input).endsWith("/v1/runs"))?.[1]?.body));
    expect(body.instructions).toBe("Card instructions string.");

    const logText = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls.map(([, line]) => String(line)).join("\n");
    expect(logText).toContain("Warning: could not read agent instructions file");
  });
});

describe("execute — compact progress logging (G4)", () => {
  // myrmidon(G4): tool.completed never carries preview/detail on the real wire
  // (gateway/platforms/api_server_runs.py's _FIXED_EVENT_FIELDS:
  // `"tool.completed": lambda tool, preview, kw: {"tool": tool, "duration":
  // ..., "error": ...}` deliberately drops it) — a fixture that adds one back
  // would hide a regression in the preview-caching path.
  function toolEventsSse(): string {
    return [
      "event: tool.started",
      "data: {\"tool\":\"terminal\",\"preview\":\"curl example.com\"}",
      "",
      "event: tool.completed",
      "data: {\"tool\":\"terminal\",\"duration\":1.2}",
      "",
      "event: message.delta",
      "data: {\"delta\":\"Hello\\n\"}",
      "",
      "event: reasoning.available",
      "data: {\"text\":\"Weighing two options.\"}",
      "",
      "event: run.completed",
      "data: {\"status\":\"completed\",\"output\":\"done\"}",
      "",
    ].join("\n");
  }

  it("writes hermes-chat-shaped compact lines and drives onRuntimeProgress by default", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-compact-1", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response(sseStream(toolEventsSse()), { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 5 });
    const onRuntimeProgress = vi.fn();
    ctx.onRuntimeProgress = onRuntimeProgress;

    await execute(ctx);

    const logLines = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls.map(([, line]) => String(line));
    expect(logLines.some((line) => line.includes("[tool] terminal curl example.com"))).toBe(true);

    // myrmidon(G4): tool.completed carries no preview on the wire (see
    // toolEventsSse above); the [done] line must still show the real tool
    // name and the preview captured from the earlier tool.started line, and —
    // critically — the shared parser (ui/parse-stdout.ts, also used by
    // gateway/ui/parse-stdout.ts) must parse it back into a tool_call whose
    // `name` is the real tool, not the "tool"/detail-swap that a
    // whitespace-only gap between the name and the duration produces.
    const doneLine = logLines.find((line) => line.startsWith("  [done]"));
    expect(doneLine).toBeDefined();
    expect(doneLine).toContain("terminal");
    expect(doneLine).toContain("curl example.com");
    expect(doneLine).toContain("1.2s");
    const parsedDone = parseHermesStdoutLine(doneLine!, new Date().toISOString());
    const toolCall = parsedDone.find((entry) => entry.kind === "tool_call");
    const toolResult = parsedDone.find((entry) => entry.kind === "tool_result");
    expect(toolCall).toMatchObject({ kind: "tool_call", name: "shell" });
    expect(toolResult).toMatchObject({ kind: "tool_result", content: expect.stringContaining("curl example.com") });

    expect(logLines.some((line) => line.includes("┊ 💬 Hello"))).toBe(true);
    expect(logLines.some((line) => line.includes("💭") && line.includes("Weighing two options."))).toBe(true);
    expect(logLines.every((line) => !line.includes("[hermes-gateway:event]"))).toBe(true);

    expect(onRuntimeProgress).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "adapter_startup", currentToolName: "terminal", message: "Using terminal" }),
    );
    expect(onRuntimeProgress).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "adapter_startup", currentToolName: "terminal", message: "Used terminal" }),
    );
    expect(onRuntimeProgress).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "adapter_startup", lastAssistantSnippet: "Hello\n" }),
    );
  });

  it("throttles onRuntimeProgress for a burst of message.delta events, but never for tool events", async () => {
    // myrmidon(G4): message.delta streams once per provider token (the real
    // gateway emits it on every stream chunk); reporting onRuntimeProgress
    // on every one of them would cost the server a heartbeat_runs SELECT
    // plus a live-event broadcast per token — see
    // RUNTIME_PROGRESS_DELTA_THROTTLE_MS. Tool events are comparatively rare
    // and must still be reported immediately, never throttled.
    const deltaFrames: string[] = [];
    for (let i = 0; i < 100; i += 1) {
      deltaFrames.push("event: message.delta", `data: {"delta":"tok${i} "}`, "");
    }
    const sse = [
      "event: tool.started",
      "data: {\"tool\":\"terminal\",\"preview\":\"curl example.com\"}",
      "",
      ...deltaFrames,
      "event: tool.completed",
      "data: {\"tool\":\"terminal\",\"duration\":1.2}",
      "",
      "event: run.completed",
      "data: {\"status\":\"completed\",\"output\":\"done\"}",
      "",
    ].join("\n");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-throttle-1", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response(sseStream(sse), { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 5 });
    const onRuntimeProgress = vi.fn();
    ctx.onRuntimeProgress = onRuntimeProgress;

    await execute(ctx);

    const toolCalls = onRuntimeProgress.mock.calls.filter(
      ([update]) => (update as { currentToolName?: string }).currentToolName === "terminal",
    );
    const deltaCalls = onRuntimeProgress.mock.calls.filter(
      ([update]) => typeof (update as { lastAssistantSnippet?: unknown }).lastAssistantSnippet === "string",
    );

    // tool.started + tool.completed — always reported, never throttled.
    expect(toolCalls.length).toBe(2);
    // 100 deltas, all delivered well inside one throttle window, must not
    // turn into 100 (or even a handful of) onRuntimeProgress calls.
    expect(deltaCalls.length).toBeGreaterThanOrEqual(1);
    expect(deltaCalls.length).toBeLessThanOrEqual(2);
  });

  it("keeps the [done] line parseable when a tool.completed has no matching tool.started", async () => {
    // myrmidon(G4): e.g. a reconnect mid-call drops the tool.started frame.
    // The [done] line must still carry a non-whitespace token after the tool
    // name so the shared parser's name/detail split does not collapse the
    // real tool name into the generic "tool" bucket.
    const sse = [
      "event: tool.completed",
      "data: {\"tool\":\"write_file\",\"duration\":0.4}",
      "",
      "event: run.completed",
      "data: {\"status\":\"completed\",\"output\":\"done\"}",
      "",
    ].join("\n");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-compact-3", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response(sseStream(sse), { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 5 });
    await execute(ctx);

    const logLines = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls.map(([, line]) => String(line));
    const doneLine = logLines.find((line) => line.startsWith("  [done]"));
    expect(doneLine).toBeDefined();
    const parsedDone = parseHermesStdoutLine(doneLine!, new Date().toISOString());
    const toolCall = parsedDone.find((entry) => entry.kind === "tool_call");
    expect(toolCall).toMatchObject({ kind: "tool_call", name: "write_file" });
  });

  it("pairs concurrent same-name tool calls with their previews in start order", async () => {
    // myrmidon(G4): the wire protocol has no call id, so two concurrent calls
    // to the same tool (agent/tool_executor.py's execute_tool_calls_concurrent)
    // can only be paired by start order (FIFO) — verify that pairing, not just
    // that *a* preview shows up.
    const sse = [
      "event: tool.started",
      "data: {\"tool\":\"terminal\",\"preview\":\"first command\"}",
      "",
      "event: tool.started",
      "data: {\"tool\":\"terminal\",\"preview\":\"second command\"}",
      "",
      "event: tool.completed",
      "data: {\"tool\":\"terminal\",\"duration\":0.1}",
      "",
      "event: tool.completed",
      "data: {\"tool\":\"terminal\",\"duration\":0.2}",
      "",
      "event: run.completed",
      "data: {\"status\":\"completed\",\"output\":\"done\"}",
      "",
    ].join("\n");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-compact-4", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response(sseStream(sse), { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 5 });
    await execute(ctx);

    const logLines = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls.map(([, line]) => String(line));
    const doneLines = logLines.filter((line) => line.startsWith("  [done]"));
    expect(doneLines).toHaveLength(2);
    expect(doneLines[0]).toContain("first command");
    expect(doneLines[0]).toContain("0.1s");
    expect(doneLines[1]).toContain("second command");
    expect(doneLines[1]).toContain("0.2s");
  });

  it("logs raw redacted event JSON instead when adapterConfig.debugEvents is true", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-compact-2", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response(sseStream(toolEventsSse()), { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 5, debugEvents: true });
    await execute(ctx);

    const logLines = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls.map(([, line]) => String(line));
    expect(logLines.some((line) => line.startsWith("[hermes-gateway:event] run=run-compact-2 event=tool.started"))).toBe(true);
    expect(logLines.some((line) => line.startsWith("  [tool]"))).toBe(false);
    expect(logLines.some((line) => line.startsWith("  [done]"))).toBe(false);
  });

  it("flushes a trailing partial compact-progress line when polling (not SSE) observes the terminal status", async () => {
    // myrmidon(G4): flushCompactDeltaLines(..., {final:true}) previously only
    // ran inside handleEvent's SSE terminal branch. If the SSE stream never
    // delivers a run.* terminal event — here it delivers one message.delta
    // with no trailing newline and then just ends, as it would while
    // reconnecting — and pollStatus's periodic GET is what first observes
    // "completed", markTerminal() was reached without ever flushing the
    // buffered line, silently dropping it from the transcript.
    let eventsCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-poll-flush", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        eventsCalls += 1;
        // Only the first connection carries the partial delta; every
        // reconnect after that gets an empty stream, so state.terminal is
        // never set from this path and pollStatus must be the one to do it.
        const sse = eventsCalls === 1
          ? ["event: message.delta", "data: {\"delta\":\"trailing partial line\"}", ""].join("\n")
          : "";
        return new Response(sseStream(sse), { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      timeoutSec: 5,
      // Poll fast, reconnect slow, so the GET /v1/runs status — not another
      // SSE connection — is what first observes the terminal status.
      pollIntervalMs: 250,
      eventReconnectMs: 30_000,
    });

    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    const logLines = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls.map(([, line]) => String(line));
    expect(logLines.some((line) => line.includes("┊ 💬 trailing partial line"))).toBe(true);
  });
});

describe("execute — idempotency key (G4)", () => {
  it("ignores retryOfRunId and keys the Idempotency-Key off this attempt's own ctx.runId, even for a realistic continuation retry", async () => {
    // myrmidon(G4): heartbeat.ts sets retryOfRunId on plain continuation
    // wakes (issue_continuation_needed, missing_issue_comment, ...), not
    // only after a lost process, and each carries its own wakeReason /
    // paperclipWake — so its body legitimately differs from the run it
    // points back at. Keying the Idempotency-Key off retryOfRunId would
    // fingerprint-mismatch that different body against the predecessor's
    // stored one and 409 instead of creating a fresh run.
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(
      String(input).endsWith("/v1/runs") ? { run_id: "run-hermes-1", status: "started" } : { status: "completed", output: "done" },
    ), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 5 });
    ctx.runId = "pc-run-2";
    ctx.context = {
      ...ctx.context,
      retryOfRunId: "pc-run-original",
      wakeReason: "issue_continuation_needed",
      retryReason: "issue_continuation_needed",
      paperclipWake: { issue: { identifier: "PAP-1", title: "Do the thing", description: "Continuation-specific detail not in the original wake" } },
    };
    await execute(ctx);

    const calls = fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
    const init = calls.find(([input]) => String(input).endsWith("/v1/runs"))?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe("pc-run-2");
    expect(JSON.parse(String(init.body)).input).toContain("Run ID: pc-run-2");
    expect(JSON.parse(String(init.body)).input).not.toContain("Run ID: pc-run-original");
  });

  it("keys the Idempotency-Key off ctx.runId when this run is not a retry", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(
      String(input).endsWith("/v1/runs") ? { run_id: "run-hermes-2", status: "started" } : { status: "completed", output: "done" },
    ), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 5 });
    await execute(ctx);

    const calls = fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
    const init = calls.find(([input]) => String(input).endsWith("/v1/runs"))?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe("pc-run-1");
  });

  it("attaches to the existing run and logs the replay when Hermes reports replayed:true", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-original-1", status: "running", replayed: true }), { status: 202 });
      }
      if (url.endsWith("/events")) {
        return new Response(
          sseStream(["event: run.completed", "data: {\"status\":\"completed\",\"output\":\"done\"}", ""].join("\n")),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    // No retryOfRunId here: with the Idempotency-Key now always ctx.runId
    // (unique per attempt), a replayed:true response is a genuine duplicate
    // create for this same attempt, not something retryOfRunId drives.
    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 5 });
    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/run-original-1/events"))).toBe(true);
    const logText = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls.map(([, line]) => String(line)).join("\n");
    expect(logText).toContain("idempotent replay: attaching to existing run run-original-1 instead of starting a new one");
  });

  it("gives an original attempt and its retry distinct request bodies and keys, each matching its own ctx.runId", async () => {
    // myrmidon(G4): the inverse of the old (buggy) assumption that a retry's
    // body must byte-match its predecessor's. A continuation retry has its
    // own wakeReason/paperclipWake, so forcing the predecessor's id onto its
    // Idempotency-Key/session-key/"Run ID:" line only fingerprint-mismatches
    // it against the wrong stored request. Each attempt must stand on its
    // own ctx.runId.
    const bodies: string[] = [];
    const keys: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        bodies.push(String(init?.body));
        keys.push((init?.headers as Record<string, string>)["Idempotency-Key"]);
        return new Response(JSON.stringify({ run_id: "run-hermes-x", status: "started" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const original = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 5 });
    await execute(original);

    // A realistic continuation retry: a different ctx.runId, retryOfRunId
    // pointing back at the original's run id, and its own wakeReason/
    // paperclipWake (heartbeat.ts's enqueueMissingIssueCommentRetry and the
    // planned-continuation paths all shape retries this way).
    const retry = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 5 });
    retry.runId = "pc-run-2";
    retry.context = {
      ...retry.context,
      retryOfRunId: original.runId,
      wakeReason: "missing_issue_comment",
      retryReason: "missing_issue_comment",
      paperclipWake: { issue: { identifier: "PAP-1", title: "Do the thing", description: "Reminder: comment was missing" } },
    };
    await execute(retry);

    expect(keys).toEqual(["pc-run-1", "pc-run-2"]);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).not.toBe(bodies[0]);
    expect(JSON.parse(bodies[0]).input).toContain(`Run ID: ${original.runId}`);
    expect(JSON.parse(bodies[1]).input).toContain(`Run ID: ${retry.runId}`);
    expect(JSON.parse(bodies[1]).input).not.toContain(`Run ID: ${original.runId}`);
  });

  it("keys sessionKeyStrategy 'run' session keys off this attempt's own ctx.runId, not retryOfRunId", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(
      String(input).endsWith("/v1/runs") ? { run_id: "run-hermes-y", status: "started" } : { status: "completed", output: "done" },
    ), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const retry = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      timeoutSec: 5,
      sessionKeyStrategy: "run",
    });
    retry.runId = "pc-run-2";
    retry.context = { ...retry.context, retryOfRunId: "pc-run-original" };
    await execute(retry);

    const calls = fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
    const init = calls.find(([input]) => String(input).endsWith("/v1/runs"))?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)["X-Hermes-Session-Key"]).toBe("paperclip:run:pc-run-2");
    const body = JSON.parse(String(init.body));
    expect(body.session_id).toBe("paperclip:run:pc-run-2");
  });

  it("classifies a 409 idempotency-key conflict distinctly from a generic protocol error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(
        JSON.stringify({ error: "Idempotency-Key was already used with a different request payload" }),
        { status: 409 },
      )),
    );
    const result = await execute(makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key" }));
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_idempotency_conflict");
  });
});
