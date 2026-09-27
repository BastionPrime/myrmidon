import { afterEach, describe, expect, it } from "vitest";
import {
  TOOL_BREAKER_COOLDOWN_MS_ENV,
  TOOL_BREAKER_FAILURES_ENV,
  TOOL_BREAKER_WINDOW_MS_ENV,
  TOOL_TIMEOUT_MAX_MS_ENV,
  TOOL_TIMEOUT_SLOW_MS_ENV,
  connectedToolFailureMessage,
  createRemoteToolResilience,
  neutralizeSessionExpiryMarkers,
  remoteHttpStatusFailure,
  resolveConnectedToolTimeoutMs,
  toolGatewayResilienceSettings,
  upstreamRpcErrorDetail,
} from "../myrmidon/tool-gateway-resilience.js";

const SETTING_KEYS = [
  TOOL_BREAKER_FAILURES_ENV,
  TOOL_BREAKER_COOLDOWN_MS_ENV,
  TOOL_BREAKER_WINDOW_MS_ENV,
  TOOL_TIMEOUT_MAX_MS_ENV,
  TOOL_TIMEOUT_SLOW_MS_ENV,
];
const saved = Object.fromEntries(SETTING_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of SETTING_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const session = { id: "session-a", agentId: "agent-a" };
const sharedConnection = { id: "connection-a", name: "Browser A", credentialPolicy: "shared" };
const tool = (catalogEntryId: string) => ({
  name: `mcp.browser-a:${catalogEntryId}`,
  providerType: "mcp_remote_http",
  connectionId: sharedConnection.id,
  catalogEntryId,
});

describe("tool gateway resilience settings (myrmidon P9)", () => {
  it("uses the documented defaults", () => {
    expect(toolGatewayResilienceSettings({})).toEqual({
      breakerFailures: 3,
      breakerCooldownMs: 60_000,
      breakerWindowMs: 600_000,
      timeoutMaxMs: 180_000,
      timeoutSlowMs: 45_000,
    });
  });

  it("reads overrides and ignores malformed values", () => {
    expect(
      toolGatewayResilienceSettings({
        [TOOL_BREAKER_FAILURES_ENV]: "5",
        [TOOL_BREAKER_COOLDOWN_MS_ENV]: "1000",
        [TOOL_BREAKER_WINDOW_MS_ENV]: "abc",
        [TOOL_TIMEOUT_MAX_MS_ENV]: "0",
        [TOOL_TIMEOUT_SLOW_MS_ENV]: "20000",
      }),
    ).toEqual({
      breakerFailures: 5,
      breakerCooldownMs: 1000,
      breakerWindowMs: 600_000,
      timeoutMaxMs: 180_000,
      timeoutSlowMs: 20_000,
    });
  });

  it("applies the timeout settings to per-call budgets", () => {
    process.env[TOOL_TIMEOUT_MAX_MS_ENV] = "30000";
    process.env[TOOL_TIMEOUT_SLOW_MS_ENV] = "20000";
    expect(resolveConnectedToolTimeoutMs({ requestedTimeoutMs: 999_999 })).toBe(30_000);
    expect(resolveConnectedToolTimeoutMs({ upstreamToolName: "browser-navigate" })).toBe(20_000);
    expect(resolveConnectedToolTimeoutMs({ upstreamToolName: "kv_set" })).toBe(10_000);
  });
});

describe("per-tool circuit breaker (myrmidon P9)", () => {
  it("pauses only the failing tool after the configured number of unanswered calls", () => {
    process.env[TOOL_BREAKER_FAILURES_ENV] = "2";
    process.env[TOOL_BREAKER_COOLDOWN_MS_ENV] = "1000";
    let now = 1_000_000;
    const resilience = createRemoteToolResilience({ now: () => now });

    resilience.recordToolNoAnswer(session, sharedConnection, "entry-a", "timed out after 10 ms");
    expect(resilience.claim(session, tool("entry-a"))).toEqual({ probe: null });
    resilience.recordToolNoAnswer(session, sharedConnection, "entry-a", "timed out after 10 ms");

    const paused = resilience.claim(session, tool("entry-a"));
    expect("error" in paused && paused.error).toMatchObject({
      status: 503,
      reasonCode: "tool_temporarily_unavailable",
      details: { recentFailures: 2, retryAfterSeconds: 1, probeInFlight: false },
    });
    expect(resilience.claim(session, tool("entry-b"))).toEqual({ probe: null });

    // After the cooldown exactly one probe goes through; others wait for it.
    now += 1_000;
    const probe = resilience.claim(session, tool("entry-a"));
    expect("probe" in probe && probe.probe).toBeTruthy();
    const waiting = resilience.claim(session, tool("entry-a"));
    expect("error" in waiting && waiting.error.details.probeInFlight).toBe(true);

    // The probe's answer closes the breaker.
    resilience.recordToolAnswered(session, sharedConnection, "entry-a");
    expect(resilience.claim(session, tool("entry-a"))).toEqual({ probe: null });
  });

  it("re-opens at once when the half-open probe fails", () => {
    process.env[TOOL_BREAKER_FAILURES_ENV] = "1";
    process.env[TOOL_BREAKER_COOLDOWN_MS_ENV] = "1000";
    let now = 2_000_000;
    const resilience = createRemoteToolResilience({ now: () => now });
    resilience.recordToolNoAnswer(session, sharedConnection, "entry-a", "no answer");
    now += 1_000;
    expect("probe" in resilience.claim(session, tool("entry-a"))).toBe(true);
    resilience.recordToolNoAnswer(session, sharedConnection, "entry-a", "no answer");
    expect("error" in resilience.claim(session, tool("entry-a"))).toBe(true);
  });

  it("keeps breaker state per caller for connections without shared credentials", () => {
    process.env[TOOL_BREAKER_FAILURES_ENV] = "1";
    const resilience = createRemoteToolResilience({ now: () => 3_000_000 });
    const perUser = { ...sharedConnection, credentialPolicy: "per_user" };
    const userA = { id: "session-a", responsibleUserId: "user-a" };
    const userB = { id: "session-b", responsibleUserId: "user-b" };
    resilience.recordToolNoAnswer(userA, perUser, "entry-a", "no answer");
    expect("error" in resilience.claim(userA, tool("entry-a"))).toBe(true);
    expect(resilience.claim(userB, tool("entry-a"))).toEqual({ probe: null });
  });

  it("is off when the failure threshold is 0", () => {
    process.env[TOOL_BREAKER_FAILURES_ENV] = "0";
    const resilience = createRemoteToolResilience({ now: () => 4_000_000 });
    for (let i = 0; i < 10; i++) resilience.recordToolNoAnswer(session, sharedConnection, "entry-a", "no answer");
    expect(resilience.claim(session, tool("entry-a"))).toEqual({ probe: null });
  });

  it("tracks a per-connection failure streak that any answer resets", () => {
    const resilience = createRemoteToolResilience();
    expect(resilience.recordConnectionNoAnswer("connection-a")).toBe(1);
    expect(resilience.recordConnectionNoAnswer("connection-a")).toBe(2);
    resilience.recordConnectionAnswered("connection-a");
    expect(resilience.connectionFailureStreak("connection-a")).toBe(0);
  });
});

describe("tool failure messages (myrmidon P9)", () => {
  it("names the tool, upstream name, connection and cause, and keeps other tools available", () => {
    const message = connectedToolFailureMessage({
      gatewayToolName: "mcp.browser-a:browser-navigate",
      upstreamToolName: "browser-navigate",
      connectionName: "Browser A",
      failure: { cause: "timed out after 45000 ms", scope: "tool", outcome: "uncertain" },
      risk: "read",
    });
    expect(message).toContain('Tool "mcp.browser-a:browser-navigate" (upstream "browser-navigate", connection "Browser A")');
    expect(message).toContain("timed out after 45000 ms");
    expect(message).toContain("the other tools of this connection and of other connections remain available");
  });

  it("counts only 5xx, 408 and 429 as unanswered", () => {
    expect(remoteHttpStatusFailure(500).counts).toBe(true);
    expect(remoteHttpStatusFailure(408).counts).toBe(true);
    expect(remoteHttpStatusFailure(429).counts).toBe(true);
    expect(remoteHttpStatusFailure(401).counts).toBe(false);
    expect(remoteHttpStatusFailure(404).counts).toBe(false);
  });

  it("quotes an upstream error at most 300 characters and without control characters", () => {
    const detail = upstreamRpcErrorDetail({ code: -32000, message: `bad\u0007 input ${"x".repeat(400)}` });
    expect(detail.startsWith("the MCP server returned JSON-RPC error -32000: bad input ")).toBe(true);
    expect(detail).not.toContain("\u0007");
    expect(detail.length).toBeLessThanOrEqual("the MCP server returned JSON-RPC error -32000: ".length + 301);
  });

  it("defuses phrases a client reads as an expired session", () => {
    expect(neutralizeSessionExpiryMarkers("Connection closed; ClosedResourceError")).toBe(
      "Connection-closed; ClosedResource-Error",
    );
  });
});
