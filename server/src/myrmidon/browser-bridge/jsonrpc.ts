// myrmidon(EXTCASE-B): JSON-RPC 2.0 framing of the browser bridge.
//
// The bridge reuses the tool-gateway pattern (design note §4.1): the transport
// is JSON-RPC 2.0 with client-chosen ids, and a refusal is a JSON-RPC error
// object with an application code, never a bare text response. The one addition
// the bridge needs is idempotency: a browser action may leave the client PC and
// the answer may be lost (a WSS drop between the extension's send and the
// gateway's receive), so the gateway remembers the response of a recent request
// id per device and re-sends it instead of running the action twice.

import {
  BROWSER_BRIDGE_ERROR_CODES,
  JSON_RPC_VERSION,
  type JsonRpcErrorFrame,
  type JsonRpcRequestFrame,
  type JsonRpcResponseFrame,
  type JsonRpcSuccessFrame,
} from "@paperclipai/shared";

export type { JsonRpcResponseFrame } from "@paperclipai/shared";

/** A request id the bridge accepts: a JSON string or number, never null. */
export function isJsonRpcId(value: unknown): value is string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
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

export type ParseJsonRpcResult =
  | { ok: true; request: JsonRpcRequestFrame }
  | { ok: false; response: JsonRpcErrorFrame };

/**
 * Parse one text frame of the bridge. Anything that is not a well-formed
 * JSON-RPC 2.0 request with a usable id is answered with the matching standard
 * error: -32700 when the text is not JSON at all, -32600 when it is JSON but not
 * a request. The id is echoed back when it was readable, so a client can match
 * the failure to its own request.
 */
export function parseJsonRpcRequest(raw: string): ParseJsonRpcResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      response: jsonRpcError(null, BROWSER_BRIDGE_ERROR_CODES.parseError, "parse error"),
    };
  }

  const candidate = parsed as Record<string, unknown> | null;
  const id = candidate && isJsonRpcId(candidate.id) ? (candidate.id as string | number) : null;

  if (
    !candidate ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    candidate.jsonrpc !== JSON_RPC_VERSION ||
    typeof candidate.method !== "string" ||
    candidate.method.length === 0 ||
    id === null
  ) {
    return {
      ok: false,
      response: jsonRpcError(id, BROWSER_BRIDGE_ERROR_CODES.invalidRequest, "invalid request"),
    };
  }

  return {
    ok: true,
    request: {
      jsonrpc: JSON_RPC_VERSION,
      id,
      method: candidate.method,
      ...(candidate.params === undefined ? {} : { params: candidate.params }),
    },
  };
}

export type ParseJsonRpcResponseResult =
  | { ok: true; id: string | number; result: unknown }
  | { ok: false; id: string | number | null; error: JsonRpcErrorFrame["error"] | null };

/**
 * Parse one frame the extension sent back. Only the answer to a gateway request
 * is a success here; an error object is returned as-is so the caller can map the
 * extension's refusal onto the bridge's own code, and a frame that is neither is
 * dropped (the connection sees it, the action keeps waiting).
 */
export function parseJsonRpcResponse(raw: string): ParseJsonRpcResponseResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const candidate = parsed as Record<string, unknown> | null;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  if (candidate.jsonrpc !== JSON_RPC_VERSION) return null;
  const id = isJsonRpcId(candidate.id) ? (candidate.id as string | number) : null;
  if (candidate.error !== undefined) {
    const error = candidate.error as JsonRpcErrorFrame["error"];
    if (!error || typeof error !== "object" || typeof error.code !== "number") return null;
    return { ok: false, id, error };
  }
  if (id === null) return null;
  return { ok: true, id, result: candidate.result };
}

export type IdempotencyCacheOptions = {
  /** How many recent device/id pairs to remember. */
  limit?: number;
  /** How long a remembered answer stays replayable. */
  ttlMs?: number;
  now?: () => number;
}

/**
 * Bounded replay cache keyed by `deviceId:id`.
 *
 * Action timeouts are 30 s (180 s with a human confirmation), so the window
 * only has to cover a lost answer plus the client's retry. Old entries are
 * dropped on insert, and cached responses are returned as-is: a replay must be
 * byte-identical to the first answer, or the client cannot tell retry from a
 * second execution.
 */
export class IdempotencyCache {
  private readonly limit: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, { at: number; response: JsonRpcResponseFrame }>();

  constructor(options: IdempotencyCacheOptions = {}) {
    this.limit = options.limit ?? 512;
    this.ttlMs = options.ttlMs ?? 5 * 60 * 1000;
    this.now = options.now ?? Date.now;
  }

  get(key: string): JsonRpcResponseFrame | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.at > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.response;
  }

  set(key: string, response: JsonRpcResponseFrame): void {
    this.entries.delete(key);
    this.entries.set(key, { at: this.now(), response });
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}

export function idempotencyKey(deviceId: string, id: string | number): string {
  return `${deviceId}:${String(id)}`;
}