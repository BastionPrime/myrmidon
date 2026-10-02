// myrmidon(EXTCASE-B): the bridge WSS endpoint — /bridge/v1.
//
// The extension opens an outbound connection; the board never dials the client
// PC (design note §4.1). The upgrade is authenticated before the socket exists:
// the bridge token arrives in the `token` query parameter (a browser extension
// cannot set request headers on a WebSocket) or in an Authorization header for
// non-browser clients, names its company and device, and is checked against the
// stored record. An unknown or revoked token gets 403 and no socket at all.
//
// After the upgrade the first frame must be `bridge.hello`; until it arrives the
// device counts as offline and no action reaches it. `bridge.ready` answers with
// the granted capability set and the current allowlist, so the extension can show
// the operator what it may do and re-check domains locally.
//
// The token is never logged: the refusal logger names the device and company
// only, and the journal has no field for it.

import { createRequire } from "node:module";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import {
  BROWSER_BRIDGE_ERROR_CODES,
  BROWSER_BRIDGE_WS_PATH,
  BRIDGE_ACTION_TIMEOUT_MS,
  BRIDGE_CANCEL_METHOD,
  BRIDGE_CONFIRMATION_TIMEOUT_MS,
  BRIDGE_HELLO_METHOD,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_READY_METHOD,
  bridgeHelloParamsSchema,
  normalizeCapabilitySet,
  type BrowserBridgeCapability,
  type BrowserBridgeMethod,
} from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { connectionEntry, type BrowserBridgeActor, type BrowserBridgeJournalEntry } from "./journal.js";
import {
  IdempotencyCache,
  jsonRpcError,
  jsonRpcSuccess,
  parseJsonRpcRequest,
  parseJsonRpcResponse,
  type JsonRpcResponseFrame,
} from "./jsonrpc.js";
import { InMemoryBridgeSessionRegistry, type BridgeSession } from "./sessions.js";
import { BrowserBridgeError, type BrowserBridgeService } from "./service.js";
import { parseBridgeToken } from "./tokens.js";

interface WsSocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "close", listener: (code?: number, reason?: Buffer | string) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
}

interface WsServer {
  on(event: "connection", listener: (socket: WsSocket, req: IncomingMessage) => void): void;
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, callback: (ws: WsSocket) => void): void;
  emit(event: "connection", ws: WsSocket, req: IncomingMessage): boolean;
}

const require = createRequire(import.meta.url);
const { WebSocket, WebSocketServer } = require("ws") as {
  WebSocket: { OPEN: number };
  WebSocketServer: new (opts: { noServer: boolean }) => WsServer;
};

interface IncomingMessageWithBridge extends IncomingMessage {
  paperclipWebSocketHandled?: boolean;
  bridgeTokenParts?: { companyId: string; deviceId: string };
}

interface PendingAction {
  resolve(result: unknown): void;
  reject(err: BrowserBridgeError): void;
  timer: ReturnType<typeof setTimeout>;
}

/** One connected extension, with the request/response bookkeeping of its socket. */
class BridgeSocketSession implements BridgeSession {
  capabilities: BrowserBridgeCapability[] = [];
  extVersion = "";
  private readonly pending = new Map<string | number, PendingAction>();
  private closed = false;
  private helloSettled = false;
  private nextRequestId = 0;

  constructor(
    private readonly socket: WsSocket,
    readonly deviceId: string,
    readonly companyId: string,
    readonly connectedAt: number,
    private readonly onClosed: (session: BridgeSocketSession, reason: string) => void,
  ) {}

  get helloDone(): boolean {
    return this.helloSettled;
  }

  completeHello(extVersion: string, capabilities: BrowserBridgeCapability[]): void {
    this.extVersion = extVersion;
    this.capabilities = capabilities;
    this.helloSettled = true;
  }

  /** Send one request and wait for the matching answer, up to `timeoutMs`. */
  request(method: BrowserBridgeMethod, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new BrowserBridgeError(BROWSER_BRIDGE_ERROR_CODES.deviceOffline, "device is not connected"));
    }
    this.nextRequestId += 1;
    const id = `gw-${this.nextRequestId}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // Tell the extension to drop the action: a person who did not confirm a
        // signing step must not have it fire later, after the bot gave up.
        this.notify(BRIDGE_CANCEL_METHOD, { id });
        reject(
          new BrowserBridgeError(BROWSER_BRIDGE_ERROR_CODES.timeout, `${method} timed out`, {
            timeoutMs,
          }),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** Handle one inbound text frame; returns true when it was a hello request. */
  handleMessage(raw: string, onHello: (session: BridgeSocketSession, id: string | number, params: unknown) => void): void {
    const asResponse = parseJsonRpcResponse(raw);
    if (asResponse && asResponse.id !== null) {
      const pending = this.pending.get(asResponse.id);
      if (!pending) return; // late answer to an action that already timed out
      this.pending.delete(asResponse.id);
      clearTimeout(pending.timer);
      if (asResponse.ok) {
        pending.resolve(asResponse.result);
      } else {
        pending.reject(
          new BrowserBridgeError(
            asResponse.error?.code ?? BROWSER_BRIDGE_ERROR_CODES.internalError,
            asResponse.error?.message ?? "extension refused the action",
          ),
        );
      }
      return;
    }

    const parsed = parseJsonRpcRequest(raw);
    if (!parsed.ok) {
      if (parsed.response.id !== null) this.send(parsed.response);
      return;
    }
    if (parsed.request.method === BRIDGE_HELLO_METHOD && !this.helloSettled) {
      onHello(this, parsed.request.id, parsed.request.params);
      return;
    }
    // The gateway serves nothing else in the client->server direction; a second
    // hello is refused like any other unknown method.
    this.send(
      jsonRpcError(
        parsed.request.id,
        BROWSER_BRIDGE_ERROR_CODES.methodNotFound,
        `unknown method ${parsed.request.method}`,
      ),
    );
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  answer(id: string | number, result: unknown): void {
    this.send(jsonRpcSuccess(id, result));
  }

  answerError(id: string | number, code: number, message: string): void {
    this.send(jsonRpcError(id, code, message));
  }

  private send(frame: unknown): void {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) return;
    try {
      this.socket.send(JSON.stringify(frame));
    } catch (err) {
      logger.warn({ err, deviceId: this.deviceId }, "failed to send a bridge frame");
    }
  }

  close(code: number, reason: string): void {
    this.markClosed(reason);
    try {
      this.socket.close(code, reason);
    } catch {
      this.socket.terminate();
    }
  }

  /** Called by the socket's own close event; must not touch the socket. */
  markClosed(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(new BrowserBridgeError(BROWSER_BRIDGE_ERROR_CODES.deviceOffline, `connection closed: ${reason}`));
    }
    this.onClosed(this, reason);
  }
}

function isWritableUpgradeSocket(socket: Duplex): boolean {
  const state = socket as Duplex & { writable?: boolean; writableEnded?: boolean; writableDestroyed?: boolean };
  return !socket.destroyed && state.writable !== false && !state.writableEnded && !state.writableDestroyed;
}

function rejectUpgrade(socket: Duplex, statusLine: string, message: string): void {
  const safe = message.replace(/[\r\n]+/g, " ").trim();
  if (!isWritableUpgradeSocket(socket)) {
    if (!socket.destroyed) socket.destroy();
    return;
  }
  try {
    socket.once("finish", () => {
      if (!socket.destroyed) socket.destroy();
    });
    socket.end(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${safe}`);
  } catch {
    if (!socket.destroyed) socket.destroy();
  }
}

/**
 * The bridge token of an upgrade request. The header is the first choice; the
 * `token` query parameter exists because a browser extension cannot set one.
 */
export function bridgeTokenFromUpgradeRequest(req: IncomingMessage): string | null {
  const rawAuth = req.headers.authorization;
  const auth = Array.isArray(rawAuth) ? rawAuth[0] : rawAuth;
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice("bearer ".length).trim();
    if (token) return token;
  }
  if (!req.url) return null;
  try {
    const url = new URL(req.url, "http://localhost");
    const token = url.searchParams.get("token");
    return token && token.trim() ? token.trim() : null;
  } catch {
    return null;
  }
}

const SYSTEM_ACTOR: BrowserBridgeActor = {
  actorType: "system",
  actorId: "browser-bridge",
  agentId: null,
  runId: null,
  agentApiKeyId: null,
};

/**
 * Send one action to a connected device and remember the answer under the
 * caller's replay key, so a retried request returns the first answer instead of
 * acting twice.
 */
export async function dispatchBridgeAction(input: {
  sessions: InMemoryBridgeSessionRegistry;
  idempotency: IdempotencyCache;
  deviceId: string;
  method: BrowserBridgeMethod;
  params: unknown;
  timeoutMs: number;
  idempotencyKey?: string;
}): Promise<unknown> {
  const session = input.sessions.get(input.deviceId);
  if (!session) {
    throw new BrowserBridgeError(BROWSER_BRIDGE_ERROR_CODES.deviceOffline, "device is not connected");
  }
  if (input.idempotencyKey) {
    const cached = input.idempotency.get(input.idempotencyKey);
    if (cached) return replayResponse(cached);
  }
  const result = await session.request(input.method, input.params, input.timeoutMs);
  if (input.idempotencyKey) input.idempotency.set(input.idempotencyKey, jsonRpcSuccess("replay", result));
  return result;
}

function replayResponse(frame: JsonRpcResponseFrame): unknown {
  if ("error" in frame) {
    throw new BrowserBridgeError(frame.error.code, frame.error.message, frame.error.data);
  }
  return frame.result;
}

export interface BrowserBridgeWssOptions {
  /** Journal transport-level events (connections) to the company's activity log. */
  logActivity(entry: BrowserBridgeJournalEntry): Promise<unknown>;
  sessions: InMemoryBridgeSessionRegistry;
  now?: () => number;
}

/**
 * Attach the bridge to the shared HTTP server. Returns nothing: the session
 * registry is created by the caller (index.ts) because the service needs it too
 * — that is what lets a bot action reach a socket.
 */
export function setupBrowserBridgeWebSocketServer(
  server: HttpServer,
  service: BrowserBridgeService,
  options: BrowserBridgeWssOptions,
): void {
  const now = options.now ?? (() => Date.now());
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (socket: WsSocket, req: IncomingMessage) => {
    const parts = (req as IncomingMessageWithBridge).bridgeTokenParts;
    if (!parts) {
      socket.close(1008, "missing bridge identity");
      return;
    }

    const session = new BridgeSocketSession(socket, parts.deviceId, parts.companyId, now(), (current, reason) => {
      options.sessions.unregister(current);
      if (!current.helloDone) return;
      void options
        .logActivity(
          connectionEntry({
            ...SYSTEM_ACTOR,
            companyId: current.companyId,
            entityType: "browser_bridge",
            deviceId: current.deviceId,
            opened: false,
            extVersion: current.extVersion,
            reason,
          }),
        )
        .catch((err) => logger.warn({ err, deviceId: current.deviceId }, "bridge close journal failed"));
    });

    const answerHello = (current: BridgeSocketSession, id: string | number, params: unknown) => {
      const parsed = bridgeHelloParamsSchema.safeParse(params);
      if (!parsed.success) {
        current.answerError(id, BROWSER_BRIDGE_ERROR_CODES.invalidParams, "invalid bridge.hello params");
        return;
      }
      if (parsed.data.deviceId !== current.deviceId) {
        current.answerError(id, BROWSER_BRIDGE_ERROR_CODES.revoked, "bridge.hello deviceId does not match the token");
        current.close(1008, "deviceId mismatch");
        return;
      }
      const declared = normalizeCapabilitySet(parsed.data.capabilities ?? []);
      if (declared === null) {
        current.answerError(id, BROWSER_BRIDGE_ERROR_CODES.invalidParams, "unknown capability");
        return;
      }
      current.completeHello(parsed.data.extVersion, declared);
      options.sessions.register(current);
      void service
        .readSettings()
        .then((settings) => {
          current.answer(id, {
            protocolVersion: BRIDGE_PROTOCOL_VERSION,
            deviceId: current.deviceId,
            capabilities: current.capabilities,
            allowlist: settings.domains,
            actionTimeoutMs: BRIDGE_ACTION_TIMEOUT_MS,
            confirmationTimeoutMs: BRIDGE_CONFIRMATION_TIMEOUT_MS,
          });
          return options.logActivity(
            connectionEntry({
              ...SYSTEM_ACTOR,
              companyId: current.companyId,
              entityType: "browser_bridge",
              deviceId: current.deviceId,
              opened: true,
              extVersion: current.extVersion,
            }),
          );
        })
        .catch((err) => logger.warn({ err, deviceId: current.deviceId }, "bridge hello failed"));
    };

    socket.on("message", (data: unknown) => {
      const raw = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      session.handleMessage(raw, answerHello);
    });
    socket.on("close", (code, reason) => {
      const text = typeof reason === "string" ? reason : (reason?.toString("utf8") ?? "");
      session.markClosed(text || `closed ${code ?? 1000}`);
    });
    socket.on("error", (err: Error) => {
      logger.warn({ err, deviceId: parts.deviceId }, "bridge socket error");
    });
  });

  server.on("upgrade", (req, socket, head) => {
    if ((req as IncomingMessageWithBridge).paperclipWebSocketHandled) return;
    if (!req.url) {
      rejectUpgrade(socket, "400 Bad Request", "missing url");
      return;
    }
    let pathname: string;
    try {
      pathname = new URL(req.url, "http://localhost").pathname;
    } catch {
      rejectUpgrade(socket, "400 Bad Request", "bad url");
      return;
    }
    if (pathname !== BROWSER_BRIDGE_WS_PATH) return; // not ours; another lane owns it

    const token = bridgeTokenFromUpgradeRequest(req);
    const parts = token ? parseBridgeToken(token) : null;
    if (!token || !parts) {
      rejectUpgrade(socket, "403 Forbidden", "forbidden");
      return;
    }

    void service
      .authenticateDevice({ companyId: parts.companyId, deviceId: parts.deviceId, token })
      .then(() => {
        if (!isWritableUpgradeSocket(socket)) return;
        (req as IncomingMessageWithBridge).bridgeTokenParts = parts;
        wss.handleUpgrade(req, socket, head, (ws: WsSocket) => {
          wss.emit("connection", ws, req);
        });
      })
      .catch((err) => {
        logger.warn(
          { deviceId: parts.deviceId, companyId: parts.companyId, reasonCode: (err as BrowserBridgeError)?.reasonCode },
          "bridge upgrade refused",
        );
        rejectUpgrade(socket, "403 Forbidden", "forbidden");
      });
  });
}