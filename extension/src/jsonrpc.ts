// JSON-RPC 2.0 request/response plumbing of the bridge connection.
//
// The gateway is the JSON-RPC server (it calls the extension: browser.open,
// browser.read, ...), and the extension is the client that answers. This
// module owns the wire format both ways:
//
//  - outgoing `bridge.hello` request frames,
//  - incoming request frames (dispatch to action handlers),
//  - outgoing success/error response frames,
//  - incoming response frames for the extension's own requests (hello).
//
// A response is always matched to its request by id; a frame that is not
// valid JSON-RPC 2.0 is answered with the standard error code instead of
// being executed (deny by default).

import {
  BROWSER_BRIDGE_ERROR_CODES,
  BRIDGE_READY_METHOD,
  JSON_RPC_VERSION,
  type JsonRpcRequestFrame,
  type JsonRpcResponseFrame,
  type JsonRpcErrorFrame,
  type JsonRpcSuccessFrame,
} from "./protocol";

export function isJsonRpcId(value: unknown): value is string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

export function jsonRpcRequest(id: string | number, method: string, params?: unknown): JsonRpcRequestFrame {
  return { jsonrpc: JSON_RPC_VERSION, id, method, ...(params === undefined ? {} : { params }) };
}

export function jsonRpcSuccess(id: JsonRpcRequestFrame["id"], result: unknown): JsonRpcSuccessFrame {
  return { jsonrpc: JSON_RPC_VERSION, id, result };
}

export function jsonRpcError(
  id: JsonRpcRequestFrame["id"] | null,
  code: number,
  message: string,
  data?: Record<string, unknown>,
): JsonRpcErrorFrame {
  return { jsonrpc: JSON_RPC_VERSION, id, error: { code, message, ...(data ? { data } : {}) } };
}

export type ParseIncomingResult =
  | { kind: "request"; request: JsonRpcRequestFrame }
  | { kind: "response"; response: JsonRpcResponseFrame }
  | { kind: "notification"; method: string; params: unknown }
  | { kind: "invalid"; reply: JsonRpcErrorFrame };

/**
 * Parse one text frame off the socket. Anything that is not a well-formed
 * JSON-RPC 2.0 frame with a usable id produces the matching standard error
 * reply; the caller sends it back and does not execute anything.
 */
export function parseIncoming(raw: string): ParseIncomingResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "invalid", reply: jsonRpcError(null, BROWSER_BRIDGE_ERROR_CODES.parseError, "parse error") };
  }
  const candidate = parsed as Record<string, unknown> | null;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { kind: "invalid", reply: jsonRpcError(null, BROWSER_BRIDGE_ERROR_CODES.invalidRequest, "invalid request") };
  }
  const id = isJsonRpcId(candidate.id) ? candidate.id : null;
  if (candidate.jsonrpc !== JSON_RPC_VERSION) {
    return { kind: "invalid", reply: jsonRpcError(id, BROWSER_BRIDGE_ERROR_CODES.invalidRequest, "invalid request") };
  }
  // A response from the gateway (the extension's own request answered).
  if (typeof candidate.method !== "string" || candidate.method.length === 0) {
    if ("result" in candidate || "error" in candidate) {
      return { kind: "response", response: candidate as unknown as JsonRpcResponseFrame };
    }
    return { kind: "invalid", reply: jsonRpcError(id, BROWSER_BRIDGE_ERROR_CODES.invalidRequest, "invalid request") };
  }
  if (id === null) {
    // A notification: no id, so nobody waits for an answer. The bridge uses
    // exactly one — `browser.cancel`, the gateway's word that it gave up on an
    // action whose human-confirmation budget (180 s) expired. The caller
    // matches it by params.id and drops that pending step; an unknown method
    // is ignored.
    return { kind: "notification", method: candidate.method, params: candidate.params };
  }
  if (candidate.method === BRIDGE_READY_METHOD && "result" in candidate) {
    // `bridge.ready` travels as a response-looking frame with a method name;
    // treat it as a response so the handshake code sees it in one place.
    return { kind: "response", response: candidate as unknown as JsonRpcResponseFrame };
  }
  return { kind: "request", request: { jsonrpc: JSON_RPC_VERSION, id, method: candidate.method, params: candidate.params } };
}

/** Parse the `bridge.ready` result payload; null when unreadable. */
export interface BridgeReadyResult {
  protocolVersion: number;
  deviceId: string;
  capabilities: string[];
  allowlist: string[];
  actionTimeoutMs: number;
  confirmationTimeoutMs: number;
}

export function parseBridgeReadyResult(raw: unknown): BridgeReadyResult | null {
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as Record<string, unknown>;
  if (
    typeof candidate.protocolVersion !== "number" ||
    typeof candidate.deviceId !== "string" ||
    !Array.isArray(candidate.capabilities) ||
    !Array.isArray(candidate.allowlist) ||
    typeof candidate.actionTimeoutMs !== "number" ||
    typeof candidate.confirmationTimeoutMs !== "number"
  ) {
    return null;
  }
  return {
    protocolVersion: candidate.protocolVersion,
    deviceId: candidate.deviceId,
    capabilities: candidate.capabilities.filter((entry): entry is string => typeof entry === "string"),
    allowlist: candidate.allowlist.filter((entry): entry is string => typeof entry === "string"),
    actionTimeoutMs: candidate.actionTimeoutMs,
    confirmationTimeoutMs: candidate.confirmationTimeoutMs,
  };
}
