/**
 * Myrmidon (P9): a failing tool must not take its whole MCP connection down.
 *
 * Vendor behaviour: one failed `tools/call` (a timeout, an HTTP error, a
 * JSON-RPC error) wrote `health=error` on the connection, and discovery hid every
 * tool of an unhealthy connection until the next health sweep. One slow browser
 * navigation could hide dozens of tools from every agent of the company.
 *
 * Here:
 * - connection health is informational: it does not hide the catalog, and a failed
 *   call does not write `error` (a successful call still restores `ok`);
 * - a failure is reported for that one tool: the message names the tool, its
 *   upstream name, the connection and the cause, and says the other tools stay
 *   available;
 * - a per-tool circuit breaker: after N unanswered calls of one tool inside a
 *   window, calls to that tool fail fast (503 `tool_temporarily_unavailable`) for a
 *   cooldown, then exactly one probe goes through. Other tools of the connection are
 *   untouched. State is process-local;
 * - per-call budgets: a higher ceiling, a wider default for navigation-class tools,
 *   and `toolTimeouts` on the connection config.
 */

import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { toolApplications, toolCatalogEntries, toolConnections } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { validateToolContent } from "../services/tool-content-guards.js";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const TOOL_BREAKER_FAILURES_ENV = "MYRMIDON_TOOL_BREAKER_FAILURES";
export const TOOL_BREAKER_COOLDOWN_MS_ENV = "MYRMIDON_TOOL_BREAKER_COOLDOWN_MS";
export const TOOL_BREAKER_WINDOW_MS_ENV = "MYRMIDON_TOOL_BREAKER_WINDOW_MS";
export const TOOL_TIMEOUT_MAX_MS_ENV = "MYRMIDON_TOOL_TIMEOUT_MAX_MS";
export const TOOL_TIMEOUT_SLOW_MS_ENV = "MYRMIDON_TOOL_TIMEOUT_SLOW_MS";

const DEFAULT_BREAKER_FAILURES = 3;
const DEFAULT_BREAKER_COOLDOWN_MS = 60_000;
const DEFAULT_BREAKER_WINDOW_MS = 10 * 60_000;
const DEFAULT_TIMEOUT_MAX_MS = 180_000;
const DEFAULT_TIMEOUT_SLOW_MS = 45_000;
/** Vendor default budget for one tool call. */
export const DEFAULT_TOOL_TIMEOUT_MS = 10_000;

export interface ToolGatewayResilienceSettings {
  /** Unanswered calls of one tool inside the window that pause it; 0 = breaker off. */
  breakerFailures: number;
  breakerCooldownMs: number;
  breakerWindowMs: number;
  /** Ceiling for any per-call budget. */
  timeoutMaxMs: number;
  /** Default budget for navigation-class tools. */
  timeoutSlowMs: number;
}

function readNonNegativeInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : fallback;
}

function readPositiveInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const value = readNonNegativeInt(env, key, fallback);
  return value > 0 ? value : fallback;
}

/** Read at call time, so a changed environment applies without a code change. */
export function toolGatewayResilienceSettings(env: NodeJS.ProcessEnv = process.env): ToolGatewayResilienceSettings {
  return {
    breakerFailures: readNonNegativeInt(env, TOOL_BREAKER_FAILURES_ENV, DEFAULT_BREAKER_FAILURES),
    breakerCooldownMs: readPositiveInt(env, TOOL_BREAKER_COOLDOWN_MS_ENV, DEFAULT_BREAKER_COOLDOWN_MS),
    breakerWindowMs: readPositiveInt(env, TOOL_BREAKER_WINDOW_MS_ENV, DEFAULT_BREAKER_WINDOW_MS),
    timeoutMaxMs: readPositiveInt(env, TOOL_TIMEOUT_MAX_MS_ENV, DEFAULT_TIMEOUT_MAX_MS),
    timeoutSlowMs: readPositiveInt(env, TOOL_TIMEOUT_SLOW_MS_ENV, DEFAULT_TIMEOUT_SLOW_MS),
  };
}

// ---------------------------------------------------------------------------
// Per-call budgets
// ---------------------------------------------------------------------------

/** Upstream tool-name tokens that mark a call as navigation-class (slow). */
const SLOW_TOOL_NAME_TOKENS = ["navigate", "goto", "click", "type", "fill", "press", "reload", "wait"];

/** Ceiling for a caller-supplied budget (the vendor clamps at 60 s). */
export function toolTimeoutCeilingMs(): number {
  return toolGatewayResilienceSettings().timeoutMaxMs;
}

function clampTimeoutMs(value: number, ceiling: number): number {
  return Math.max(1, Math.min(ceiling, Math.floor(value)));
}

export function isSlowUpstreamToolName(value: string | null | undefined): boolean {
  return String(value ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((token) => SLOW_TOOL_NAME_TOKENS.includes(token));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Budget for one connected MCP tool call. An explicit caller budget wins; then the
 * connection's `toolTimeouts` map (by upstream or gateway tool name); then the
 * navigation-class default; then the vendor default.
 */
export function resolveConnectedToolTimeoutMs(input: {
  requestedTimeoutMs?: number;
  upstreamToolName?: string | null;
  gatewayToolName?: string | null;
  connectionConfig?: Record<string, unknown> | null;
  settings?: ToolGatewayResilienceSettings;
}): number {
  const settings = input.settings ?? toolGatewayResilienceSettings();
  if (typeof input.requestedTimeoutMs === "number" && Number.isFinite(input.requestedTimeoutMs)) {
    return clampTimeoutMs(input.requestedTimeoutMs, settings.timeoutMaxMs);
  }
  const configured = input.connectionConfig ? asRecord(input.connectionConfig.toolTimeouts) : null;
  if (configured) {
    for (const key of [input.upstreamToolName, input.gatewayToolName]) {
      if (!key) continue;
      const value = configured[key];
      if (typeof value === "number" && Number.isFinite(value)) return clampTimeoutMs(value, settings.timeoutMaxMs);
    }
  }
  if (isSlowUpstreamToolName(input.upstreamToolName ?? input.gatewayToolName)) {
    return Math.min(settings.timeoutSlowMs, settings.timeoutMaxMs);
  }
  return Math.min(DEFAULT_TOOL_TIMEOUT_MS, settings.timeoutMaxMs);
}

// ---------------------------------------------------------------------------
// Failure reporting
// ---------------------------------------------------------------------------

/**
 * What one failed connected tool call means for an agent. `scope`: only this call
 * failed ("tool") or the connection's server looks unavailable ("connection").
 * `outcome`: whether an upstream side effect is possible.
 */
export type ConnectedToolFailure = {
  cause: string;
  scope: "tool" | "connection";
  outcome: "not_sent" | "rejected" | "uncertain";
};

/** Upper bound for an upstream JSON-RPC error text quoted back to the caller. */
const REMOTE_ERROR_DETAIL_MAX_CHARS = 300;

/**
 * Phrases the Hermes MCP client reads as "the transport session expired"; a tool
 * error that contains one makes it tear the session down and replay the call. They
 * are defused in every message written here.
 */
const SESSION_EXPIRED_MARKERS = [
  "invalid or expired session",
  "expired session",
  "session expired",
  "session not found",
  "unknown session",
  "session terminated",
  "closed resource",
  "transport is closed",
  "connection closed",
  "broken pipe",
  "end of file",
];
const SESSION_EXPIRED_MARKER_PATTERN = new RegExp(
  SESSION_EXPIRED_MARKERS.map((marker) => marker.split(" ").join("\\s+")).join("|"),
  "gi",
);

/** "connection closed" -> "connection-closed", "ClosedResourceError" -> "ClosedResource-Error". */
export function neutralizeSessionExpiryMarkers(text: string): string {
  return text
    .replace(SESSION_EXPIRED_MARKER_PATTERN, (match) => match.replace(/\s+/g, "-"))
    .replace(/closedresourceerror/gi, (match) => `${match.slice(0, 14)}-${match.slice(14)}`);
}

/**
 * A tool that is not read-only gets a side-effect idempotency key: an identical
 * repeat in the same run is not executed again but answered with an empty replay
 * of the recorded call (`result: null`). That is not a success, and the text says so.
 */
export const CONNECTED_TOOL_REPLAY_NOTE =
  " A repeat with the same arguments in this run is not executed again: it returns an empty replay of the recorded call (result null), which is NOT a success." +
  " For a real retry change the arguments, and only if repeating this action is safe.";

/** The same for a call refused by an open breaker (that call itself is not recorded). */
export const PAUSED_TOOL_REPLAY_NOTE =
  " If an earlier call of this tool with the same arguments already failed in this run, repeating it is not executed again: it returns an empty replay of that recorded call (result null), which is NOT a success." +
  " For a real retry change the arguments, and only if repeating this action is safe.";

function retryAdvice(risk: string | null | undefined, outcome: ConnectedToolFailure["outcome"]): string {
  if (risk === "read") {
    return " The tool only reads data, so retrying it later is safe; meanwhile continue with other tools.";
  }
  const dedupe = CONNECTED_TOOL_REPLAY_NOTE;
  if (outcome === "uncertain") {
    return (
      " This tool can change data and the failed call may still have taken effect: check the external state before acting on it." +
      dedupe
    );
  }
  if (outcome === "not_sent") return " The call did not reach the server, so nothing was changed." + dedupe;
  return " The server refused the call, so it most likely changed nothing; fix the cause before calling again." + dedupe;
}

/** Message for a failed connected tool call: tool, connection, cause, blast radius, retry safety. */
export function connectedToolFailureMessage(input: {
  gatewayToolName: string;
  upstreamToolName: string;
  connectionName: string;
  failure: ConnectedToolFailure;
  risk?: string | null;
  connectionFailureStreak?: number;
}): string {
  const { failure } = input;
  const head =
    failure.scope === "connection"
      ? `Tool "${input.gatewayToolName}" (upstream "${input.upstreamToolName}") failed: ${failure.cause}.` +
        ` The server of connection "${input.connectionName}" appears to be unavailable or refusing requests, so its other tools may fail as well; tools of other connections are not affected.`
      : `Tool "${input.gatewayToolName}" (upstream "${input.upstreamToolName}", connection "${input.connectionName}") failed: ${failure.cause}.` +
        ` Only this call failed; the other tools of this connection and of other connections remain available.`;
  const streakNote =
    failure.scope === "tool" && input.connectionFailureStreak && input.connectionFailureStreak > 1
      ? ` Note: the last ${input.connectionFailureStreak} calls to this connection got no answer, so its other tools may be affected too.`
      : "";
  return neutralizeSessionExpiryMarkers(head + streakNote + retryAdvice(input.risk, failure.outcome));
}

/** Network error codes raised before a request byte reached the server. */
const NOT_SENT_NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENODATA",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EHOSTDOWN",
  "UND_ERR_CONNECT_TIMEOUT",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/**
 * Transport failure that is safe to show: a network error code or a fixed guard
 * text. Free-form messages can carry the endpoint and are not echoed.
 */
export function remoteFetchFailure(error: unknown): ConnectedToolFailure {
  const record = asRecord(error);
  const causeRecord = asRecord(record?.cause);
  const code =
    typeof record?.code === "string" ? record.code : typeof causeRecord?.code === "string" ? causeRecord.code : null;
  if (code && /^[A-Z][A-Z0-9_]{1,40}$/.test(code)) {
    return {
      cause: `the MCP server could not be reached (${code})`,
      scope: "connection",
      outcome: NOT_SENT_NETWORK_ERROR_CODES.has(code) ? "not_sent" : "uncertain",
    };
  }
  const message = error instanceof Error ? error.message : "";
  if (/^Timed out trying to [a-z ]+ the remote MCP endpoint$/.test(message)) {
    return {
      cause: `the MCP server could not be reached (${message.toLowerCase()})`,
      scope: "connection",
      outcome: /^Timed out trying to (connect to|negotiate TLS with) /.test(message) ? "not_sent" : "uncertain",
    };
  }
  return { cause: "the MCP server could not be reached (network error)", scope: "connection", outcome: "uncertain" };
}

/**
 * A non-2xx HTTP answer. `counts`: the status means "the tool does not answer" for
 * the breaker (5xx, 408, 429); any other 4xx is an answer.
 */
export function remoteHttpStatusFailure(status: number): ConnectedToolFailure & { counts: boolean } {
  if (status >= 500 || status === 408) {
    return { cause: `the MCP server answered HTTP ${status}`, scope: "connection", outcome: "uncertain", counts: true };
  }
  if (status === 429) {
    return {
      cause: "the MCP server answered HTTP 429 (too many requests)",
      scope: "connection",
      outcome: "rejected",
      counts: true,
    };
  }
  if (status === 401 || status === 403) {
    return {
      cause: `the MCP server answered HTTP ${status} (access refused)`,
      scope: "connection",
      outcome: "rejected",
      counts: false,
    };
  }
  return { cause: `the MCP server answered HTTP ${status}`, scope: "tool", outcome: "rejected", counts: false };
}

/** Guard reason codes on the tools/call path that mean "the tool did not answer". */
export const REMOTE_GUARD_NO_ANSWER_CODES = new Set([
  "remote_http_response_timeout",
  "remote_http_dns_failed",
  "remote_http_connect_failed",
]);

/**
 * HTTP status for a transport-guard rejection: the guard deadline is a gateway
 * timeout, a DNS/connect failure a bad gateway; anything else stays 422.
 */
export function remoteHttpGuardErrorStatus(code: string): number {
  if (code === "remote_http_response_timeout") return 504;
  if (code === "remote_http_dns_failed" || code === "remote_http_connect_failed") return 502;
  return 422;
}

/** Failure for a guard rejection listed in REMOTE_GUARD_NO_ANSWER_CODES. */
export function remoteGuardFailure(code: string, budgetMs: number): ConnectedToolFailure {
  if (code === "remote_http_response_timeout") {
    return { cause: `the MCP server did not answer in time (${budgetMs} ms budget)`, scope: "tool", outcome: "uncertain" };
  }
  return {
    cause:
      code === "remote_http_dns_failed"
        ? "the MCP server hostname could not be resolved"
        : "the MCP server could not be reached (connection failed)",
    scope: "connection",
    outcome: "not_sent",
  };
}

/**
 * Upstream JSON-RPC error text, quoted only when short and clean: control
 * characters collapsed, length bounded, and nothing the prompt-injection guard
 * would block on a tool result (then only the code is reported).
 */
export function upstreamRpcErrorDetail(errorRecord: Record<string, unknown> | null): string {
  const code = typeof errorRecord?.code === "number" ? ` ${errorRecord.code}` : "";
  const raw = typeof errorRecord?.message === "string" ? errorRecord.message : "";
  const text = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return `the MCP server returned JSON-RPC error${code}`;
  const bounded = text.length > REMOTE_ERROR_DETAIL_MAX_CHARS ? `${text.slice(0, REMOTE_ERROR_DETAIL_MAX_CHARS)}…` : text;
  try {
    validateToolContent({ value: bounded, direction: "result", sensitiveMode: "block", promptInjectionMode: "block" });
  } catch {
    return `the MCP server returned JSON-RPC error${code}`;
  }
  return `the MCP server returned JSON-RPC error${code}: ${bounded}`;
}

/**
 * Failure for a local stdio tool error, by its reason code; null leaves the error
 * as it is. `rpcError` is the JSON-RPC error object the stdio server returned, if
 * any (then the server answered and only this call failed).
 */
export function localStdioToolFailure(
  reasonCode: string,
  input: { timeoutMs: number; rpcError?: Record<string, unknown> | null },
): ConnectedToolFailure | null {
  switch (reasonCode) {
    case "tool_timeout":
      return { cause: `timed out after ${input.timeoutMs} ms`, scope: "tool", outcome: "uncertain" };
    case "local_stdio_protocol_error":
      return input.rpcError
        ? { cause: upstreamRpcErrorDetail(input.rpcError), scope: "tool", outcome: "rejected" }
        : {
            cause: "the local MCP server returned a response that is not valid JSON-RPC",
            scope: "connection",
            outcome: "uncertain",
          };
    case "local_stdio_process_exited":
      return { cause: "the local MCP server process exited before answering", scope: "connection", outcome: "uncertain" };
    case "local_stdio_spawn_failed":
    case "local_stdio_command_unavailable":
      return { cause: "the local MCP server command could not be started", scope: "connection", outcome: "not_sent" };
    case "runtime_restart_backoff":
    case "runtime_restart_suppressed":
      return {
        cause: "the local MCP runtime of this connection is pausing restarts after recent failures",
        scope: "connection",
        outcome: "not_sent",
      };
    case "runtime_capacity_unavailable":
      return { cause: "no local MCP runtime capacity is free right now", scope: "connection", outcome: "not_sent" };
    default:
      return null;
  }
}

/**
 * Failure for an error raised while a local stdio call was being prepared (before
 * any process started): the tool or connection is gone or disabled, the grant or
 * the command template is unusable, or a credential cannot be resolved.
 */
export function localStdioPreparationFailure(
  reasonCode: string,
  input: { message: string; details: Record<string, unknown> },
): ConnectedToolFailure {
  const credential = typeof input.details.credential === "string" ? ` (${input.details.credential})` : "";
  switch (reasonCode) {
    case "local_stdio_missing_secret":
      return {
        cause: `a configured credential of the connection could not be resolved${credential}`,
        scope: "connection",
        outcome: "not_sent",
      };
    case "local_stdio_template_missing":
    case "local_stdio_template_invalid":
      return { cause: "the connection has no active approved local command template", scope: "connection", outcome: "not_sent" };
    case "local_stdio_connection_disabled":
      return { cause: "the connection is disabled or not active", scope: "connection", outcome: "not_sent" };
    case "tool_not_found":
      return { cause: "the tool is no longer in the connection's catalog", scope: "tool", outcome: "not_sent" };
    default:
      return { cause: `the call could not be prepared: ${input.message}`, scope: "connection", outcome: "not_sent" };
  }
}

/** Plain error description; the gateway turns it into its own error class. */
export type GatewayErrorSpec = {
  status: number;
  message: string;
  reasonCode: string;
  details: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Disabled connection: 403 with the real state instead of "tool not found"
// ---------------------------------------------------------------------------

/**
 * A disabled or inactive connection never reaches discovery, so a call to one of
 * its tools would read "tool not found". Name the real state instead (403).
 * `baseToolName` must compute the gateway name exactly as discovery does.
 */
export async function disabledConnectedToolError(
  db: Db,
  input: {
    companyId: string;
    toolName: string;
    baseToolName: (row: {
      applicationKey: string | null;
      applicationName: string;
      connectionName: string | null;
      connectionId: string;
      toolName: string;
    }) => string;
    collisionSuffix: (catalogEntryId: string) => string;
  },
): Promise<GatewayErrorSpec | null> {
  const rows = await db
    .select({ catalogEntry: toolCatalogEntries, connection: toolConnections, application: toolApplications })
    .from(toolCatalogEntries)
    .innerJoin(toolConnections, eq(toolCatalogEntries.connectionId, toolConnections.id))
    .innerJoin(toolApplications, eq(toolConnections.applicationId, toolApplications.id))
    .where(
      and(
        eq(toolCatalogEntries.companyId, input.companyId),
        eq(toolCatalogEntries.entryKind, "tool"),
        eq(toolCatalogEntries.status, "active"),
        isNull(toolCatalogEntries.quarantinedAt),
        eq(toolConnections.companyId, input.companyId),
        inArray(toolConnections.transport, ["mcp_remote", "local_stdio"]),
        eq(toolApplications.companyId, input.companyId),
        inArray(toolApplications.type, ["mcp_http", "mcp_stdio"]),
      ),
    );
  const matched = rows.find(({ catalogEntry, connection, application }) => {
    const transportMatches =
      (connection.transport === "mcp_remote" && application.type === "mcp_http") ||
      (connection.transport === "local_stdio" && application.type === "mcp_stdio");
    if (!transportMatches) return false;
    if (connection.enabled && connection.status === "active") return false;
    const baseName = input.baseToolName({
      applicationKey: application.applicationKey ?? null,
      applicationName: application.name,
      connectionName: connection.name,
      connectionId: connection.id,
      toolName: catalogEntry.toolName,
    });
    // Collisions are resolved against the rows visible at discovery time; accept
    // the suffixed form as well.
    return input.toolName === baseName || input.toolName === `${baseName}-${input.collisionSuffix(catalogEntry.id)}`;
  });
  if (!matched) return null;
  const { connection } = matched;
  return {
    status: 403,
    message: `Connection "${connection.name}" is disabled.`,
    reasonCode: "mcp_remote_connection_disabled",
    details: { tool: input.toolName, connectionId: connection.id, connectionName: connection.name },
  };
}

// ---------------------------------------------------------------------------
// Per-tool circuit breaker and per-connection failure streak
// ---------------------------------------------------------------------------

/** Session fields that decide whose failures one breaker counts. */
export type BreakerSession = {
  id: string;
  agentId?: string | null;
  actorId?: string | null;
  gatewayTokenId?: string | null;
  responsibleUserId?: string | null;
  identityContextId?: string | null;
};

export type BreakerConnection = { id: string; name: string; credentialPolicy?: string | null };

export type BreakerTool = {
  name: string;
  risk?: string | null;
  providerType: string;
  connectionId?: string | null;
  catalogEntryId?: string | null;
};

/** A claimed half-open probe; freed by the probe's outcome or by its lease. */
export type RemoteToolProbe = { key: string; token: string };

type BreakerState = {
  /** Times of counted failures still inside the window. */
  failureTimes: number[];
  /** 0: closed. > now: open (fail fast). <= now: half-open (one probe). */
  openUntil: number;
  /** > now: the half-open probe is in flight (lease). */
  probeUntil: number;
  probeToken: string | null;
  lastFailure: string;
  connectionName: string;
};

/** Retry hint while another call is probing a paused tool. */
const PROBE_RETRY_SECONDS = 5;

/**
 * Process-local breaker state for one gateway service. Only "no answer" counts: a
 * timeout, the guard's own deadline, a network/DNS/connect failure, a body that is
 * not JSON-RPC, HTTP 5xx/408/429. Any answer (a result, a JSON-RPC error, another
 * 4xx) closes the breaker. For a connection whose credentials are not shared the
 * state is kept per caller, so one person's failing grant does not pause the tool
 * for everybody.
 */
export function createRemoteToolResilience(options: { now?: () => number } = {}) {
  const now = () => options.now?.() ?? Date.now();
  const failureStreaks = new Map<string, number>();
  const breakers = new Map<string, BreakerState>();
  const policies = new Map<string, string>();

  function subject(session: BreakerSession, credentialPolicy: string | null | undefined): string {
    if (!credentialPolicy || credentialPolicy === "shared") return "shared";
    if (session.identityContextId) return `identity:${session.identityContextId}`;
    if (session.responsibleUserId) return `user:${session.responsibleUserId}`;
    if (session.agentId) return `agent:${session.agentId}`;
    return `actor:${session.actorId ?? session.gatewayTokenId ?? session.id}`;
  }

  function key(session: BreakerSession, connectionId: string, catalogEntryId: string, credentialPolicy?: string | null) {
    return `${connectionId}:${catalogEntryId}:${subject(session, credentialPolicy)}`;
  }

  function prune(state: BreakerState, at: number, windowMs: number) {
    state.failureTimes = state.failureTimes.filter((time) => at - time < windowMs);
  }

  function pausedError(tool: BreakerTool, state: BreakerState, retryAfterSeconds: number, probeInFlight: boolean, windowMs: number): GatewayErrorSpec {
    const failures = state.failureTimes.length;
    const windowMinutes = Math.max(1, Math.round(windowMs / 60_000));
    const replayNote = tool.risk === "read" ? "" : PAUSED_TOOL_REPLAY_NOTE;
    const message = probeInFlight
      ? `Tool "${tool.name}" (connection "${state.connectionName}") is paused after ${failures} unanswered calls in the last ${windowMinutes} min (last: ${state.lastFailure}), and another call is checking right now whether it answers again.` +
        ` This call was not sent to the server and not recorded; retry in ${retryAfterSeconds}s.` +
        replayNote +
        ` The other tools of this connection and of other connections remain available.`
      : `Tool "${tool.name}" (connection "${state.connectionName}") is temporarily not responding: ${failures} of its calls in the last ${windowMinutes} min got no answer (last: ${state.lastFailure}).` +
        ` Calls to this tool are paused; this call was not sent to the server and not recorded.` +
        ` Retry in ${retryAfterSeconds}s: the first call after the pause checks whether the tool answers again.` +
        replayNote +
        ` The other tools of this connection and of other connections remain available.`;
    return {
      status: 503,
      message: neutralizeSessionExpiryMarkers(message),
      reasonCode: "tool_temporarily_unavailable",
      details: {
        tool: tool.name,
        connectionId: tool.connectionId,
        catalogEntryId: tool.catalogEntryId,
        recentFailures: failures,
        windowMs,
        retryAfterSeconds,
        probeInFlight,
      },
    };
  }

  return {
    /** Consecutive unanswered remote exchanges of a connection (informational). */
    connectionFailureStreak(connectionId: string): number {
      return failureStreaks.get(connectionId) ?? 0;
    },

    /** A remote exchange of the connection got no answer; returns the new streak. */
    recordConnectionNoAnswer(connectionId: string): number {
      const streak = (failureStreaks.get(connectionId) ?? 0) + 1;
      failureStreaks.set(connectionId, streak);
      return streak;
    },

    /** The connection answered (a result, or an error it produced itself). */
    recordConnectionAnswered(connectionId: string): void {
      failureStreaks.delete(connectionId);
    },

    /** One call of a tool got no answer: count it, open at the threshold, re-open on a failed probe. */
    recordToolNoAnswer(session: BreakerSession, connection: BreakerConnection, catalogEntryId: string, cause: string): void {
      const settings = toolGatewayResilienceSettings();
      if (settings.breakerFailures <= 0) return;
      policies.set(connection.id, connection.credentialPolicy ?? "shared");
      const stateKey = key(session, connection.id, catalogEntryId, connection.credentialPolicy);
      const at = now();
      const state: BreakerState = breakers.get(stateKey) ?? {
        failureTimes: [],
        openUntil: 0,
        probeUntil: 0,
        probeToken: null,
        lastFailure: cause,
        connectionName: connection.name,
      };
      prune(state, at, settings.breakerWindowMs);
      state.failureTimes.push(at);
      const probeFailed = state.openUntil > 0 && state.openUntil <= at;
      const opens = probeFailed || state.failureTimes.length >= settings.breakerFailures;
      state.openUntil = opens ? at + settings.breakerCooldownMs : 0;
      state.probeUntil = 0;
      state.probeToken = null;
      state.lastFailure = cause;
      state.connectionName = connection.name;
      breakers.set(stateKey, state);
      if (opens) {
        logger.warn(
          {
            connectionId: connection.id,
            catalogEntryId,
            failures: state.failureTimes.length,
            windowMs: settings.breakerWindowMs,
            cooldownMs: settings.breakerCooldownMs,
            probeFailed,
            lastFailure: cause,
          },
          "Remote MCP tool paused by its circuit breaker",
        );
      }
    },

    /** The tool answered: its breaker closes. */
    recordToolAnswered(session: BreakerSession, connection: BreakerConnection, catalogEntryId: string): void {
      breakers.delete(key(session, connection.id, catalogEntryId, connection.credentialPolicy));
    },

    /**
     * Gate one agent call of a remote tool. Returns the error to raise (paused, or
     * another call is the probe) or the probe this call now owns (null while the
     * breaker is closed).
     */
    claim(session: BreakerSession, tool: BreakerTool): { error: GatewayErrorSpec } | { probe: RemoteToolProbe | null } {
      if (tool.providerType !== "mcp_remote_http" || !tool.connectionId || !tool.catalogEntryId) return { probe: null };
      const credentialPolicy = policies.get(tool.connectionId);
      if (credentialPolicy === undefined) return { probe: null };
      const stateKey = key(session, tool.connectionId, tool.catalogEntryId, credentialPolicy);
      const state = breakers.get(stateKey);
      if (!state) return { probe: null };
      const settings = toolGatewayResilienceSettings();
      const at = now();
      prune(state, at, settings.breakerWindowMs);
      if (state.openUntil === 0) return { probe: null };
      if (state.openUntil > at) {
        return {
          error: pausedError(tool, state, Math.max(1, Math.ceil((state.openUntil - at) / 1000)), false, settings.breakerWindowMs),
        };
      }
      if (state.failureTimes.length === 0) {
        // The pause is over and the window holds no failure: close.
        breakers.delete(stateKey);
        return { probe: null };
      }
      if (state.probeUntil > at) {
        return { error: pausedError(tool, state, PROBE_RETRY_SECONDS, true, settings.breakerWindowMs) };
      }
      const token = randomUUID();
      state.probeToken = token;
      // The lease only bounds a probe that never reached dispatch.
      state.probeUntil = at + settings.timeoutMaxMs + 5_000;
      return { probe: { key: stateKey, token } };
    },

    /** Free a probe that ended without an outcome. */
    release(probe: RemoteToolProbe | null | undefined): void {
      if (!probe) return;
      const state = breakers.get(probe.key);
      if (state && state.probeToken === probe.token) {
        state.probeUntil = 0;
        state.probeToken = null;
      }
    },
  };
}

export type RemoteToolResilience = ReturnType<typeof createRemoteToolResilience>;
