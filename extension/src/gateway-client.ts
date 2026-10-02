// The bridge gateway client: the outbound WSS connection and the handshake.
//
// Connection lifecycle (design note §4.1):
//   connect → socket open → send `bridge.hello` {deviceId, extVersion,
//   capabilities} → gateway answers `bridge.ready` → the connection is live.
//
// The bridge token travels only as the `token` query parameter of the WSS url
// (a browser extension cannot set headers on a WebSocket; the gateway's
// contract provides exactly this channel). The url is never logged.
//
// After `bridge.ready` the gateway becomes the JSON-RPC caller: it sends
// browser.* request frames and this client answers them through the action
// dispatcher. A `revoked` error or a socket drop tears the connection down;
// the reconnect policy is owned by the background entry, not this class.
//
// The WebSocket itself is injected as a port so tests run without any
// networking (jsdom/mocks, no real Chrome).

import { parseBridgeReadyResult, parseIncoming, jsonRpcRequest, jsonRpcSuccess, jsonRpcError } from "./jsonrpc";
import {
  BROWSER_BRIDGE_ERROR_CODES,
  BRIDGE_CANCEL_METHOD,
  BRIDGE_HELLO_METHOD,
  BRIDGE_PROTOCOL_VERSION,
  type JsonRpcResponseFrame,
} from "./protocol";
import { buildBridgeWsUrl } from "./pairing";
import type { ActionOutcome, ActionContext } from "./actions";

export interface WebSocketLike {
  send(text: string): void;
  close(code?: number, reason?: string): void;
  readyState: number;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
}

export interface WebSocketFactory {
  create(url: string): WebSocketLike;
}

export type ConnectionPhase = "idle" | "connecting" | "awaiting-ready" | "ready" | "closed";

export interface BridgeConnectionOptions {
  origin: string;
  deviceId: string;
  extVersion: string;
  token: string;
  capabilities: readonly string[];
  allowlist: readonly string[];
  wsPath: string;
  sockets: WebSocketFactory;
  /** Handles an incoming browser.* request; returns the response payload. */
  dispatchAction: (method: string, params: unknown, requestId: string | number) => Promise<ActionOutcome>;
  onPhaseChange?: (phase: ConnectionPhase) => void;
  onAllowlistUpdate?: (domains: string[]) => void;
  /** The gateway cancelled a request (its confirmation budget expired). */
  onCancel?: (requestId: string | number) => void;
  /** Fail the handshake after this many ms without `bridge.ready`. */
  readyTimeoutMs: number;
  timers: TimerPort;
}

export interface TimerPort {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export class NodeTimerPort implements TimerPort {
  setTimeout(handler: () => void, ms: number): unknown {
    return globalThis.setTimeout(handler, ms);
  }

  clearTimeout(handle: unknown): void {
    globalThis.clearTimeout(handle as number);
  }
}

interface SocketEvents {
  open: (event: unknown) => void;
  message: (event: { data?: unknown }) => void;
  close: (event: unknown) => void;
  error: (event: unknown) => void;
}

export type HandshakeFailure =
  | { reason: "socket-error" }
  | { reason: "socket-closed" }
  | { reason: "ready-timeout" }
  | { reason: "protocol-version"; expected: number; received: number }
  | { reason: "revoked" }
  | { reason: "gateway-error"; code: number; message: string };

/**
 * One outbound connection to the bridge gateway. `connect()` resolves when
 * `bridge.ready` arrived and was accepted; it rejects with a HandshakeFailure
 * otherwise. After that the connection answers gateway requests until it is
 * closed from either side.
 */
export class BridgeConnection {
  private socket: WebSocketLike | null = null;
  private phase: ConnectionPhase = "idle";
  private readyTimer: unknown = null;
  private handshakeSettled = false;
  private handshakeResolve: ((value: void) => void) | null = null;
  private handshakeReject: ((failure: HandshakeFailure) => void) | null = null;
  private readonly listeners: SocketEvents;

  constructor(private readonly options: BridgeConnectionOptions) {
    const self = this;
    this.listeners = {
      open: () => self.onSocketOpen(),
      message: (event) => self.onSocketMessage(event),
      close: () => self.onSocketClosed(),
      error: () => self.onSocketError(),
    };
  }

  get currentPhase(): ConnectionPhase {
    return this.phase;
  }

  private setPhase(phase: ConnectionPhase): void {
    this.phase = phase;
    this.options.onPhaseChange?.(phase);
  }

  async connect(): Promise<void> {
    if (this.socket) throw new Error("connection is already open");
    const url = buildBridgeWsUrl(this.options.origin, this.options.token, this.options.wsPath);
    this.setPhase("connecting");
    const socket = this.options.sockets.create(url);
    this.socket = socket;
    socket.addEventListener("open", this.listeners.open as (event: unknown) => void);
    socket.addEventListener("message", this.listeners.message as (event: unknown) => void);
    socket.addEventListener("close", this.listeners.close as (event: unknown) => void);
    socket.addEventListener("error", this.listeners.error as (event: unknown) => void);
    try {
      await new Promise<void>((resolve, reject) => {
        this.handshakeResolve = resolve;
        this.handshakeReject = reject;
        this.options.timers.setTimeout(() => {
          if (!this.handshakeSettled) this.failHandshake({ reason: "ready-timeout" });
        }, this.options.readyTimeoutMs);
      });
    } finally {
      this.handshakeResolve = null;
      this.handshakeReject = null;
    }
  }

  private onSocketOpen(): void {
    if (!this.socket) return;
    this.setPhase("awaiting-ready");
    const hello = jsonRpcRequest(1, BRIDGE_HELLO_METHOD, {
      deviceId: this.options.deviceId,
      extVersion: this.options.extVersion,
      capabilities: [...this.options.capabilities],
    });
    this.socket.send(JSON.stringify(hello));
  }

  private onSocketMessage(event: { data?: unknown }): void {
    if (typeof event.data !== "string") return;
    const incoming = parseIncoming(event.data);
    if (incoming.kind === "invalid") {
      this.socket?.send(JSON.stringify(incoming.reply));
      return;
    }
    if (incoming.kind === "response") {
      this.onGatewayResponse(incoming.response);
      return;
    }
    if (incoming.kind === "notification") {
      this.onGatewayNotification(incoming.method, incoming.params);
      return;
    }
    void this.onGatewayRequest(incoming.request.id, incoming.request.method, incoming.request.params);
  }

  /**
   * Notifications carry no answer. The bridge sends exactly one kind: the
   * gateway gave up on a request id (its budget expired) and the extension must
   * drop that pending step — a person who never confirmed must not have a
   * signing step fire later, after the bot stopped waiting.
   */
  private onGatewayNotification(method: string, params: unknown): void {
    if (method !== BRIDGE_CANCEL_METHOD) return;
    const id = (params as { id?: unknown } | null)?.id;
    if (typeof id === "string" || typeof id === "number") {
      this.options.onCancel?.(id);
    }
  }

  private onGatewayResponse(response: JsonRpcResponseFrame): void {
    if (response.id === 1 && "result" in response) {
      const ready = parseBridgeReadyResult(response.result);
      if (!ready) {
        this.failHandshake({ reason: "gateway-error", code: BROWSER_BRIDGE_ERROR_CODES.internalError, message: "bridge.ready payload is malformed" });
        return;
      }
      if (ready.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
        this.failHandshake({ reason: "protocol-version", expected: BRIDGE_PROTOCOL_VERSION, received: ready.protocolVersion });
        return;
      }
      if (ready.deviceId !== this.options.deviceId) {
        this.failHandshake({ reason: "gateway-error", code: BROWSER_BRIDGE_ERROR_CODES.invalidParams, message: "bridge.ready answered for another device" });
        return;
      }
      this.options.onAllowlistUpdate?.(ready.allowlist);
      if (!this.handshakeSettled) {
        this.handshakeSettled = true;
        this.setPhase("ready");
        this.handshakeResolve?.();
      }
      return;
    }
    if ("error" in response) {
      const code = response.error?.code;
      if (code === BROWSER_BRIDGE_ERROR_CODES.revoked && !this.handshakeSettled) {
        this.failHandshake({ reason: "revoked" });
        return;
      }
      if (!this.handshakeSettled) {
        this.failHandshake({
          reason: "gateway-error",
          code: typeof code === "number" ? code : BROWSER_BRIDGE_ERROR_CODES.internalError,
          message: response.error?.message ?? "gateway refused the handshake",
        });
      }
    }
  }

  private async onGatewayRequest(id: string | number, method: string, params: unknown): Promise<void> {
    const outcome = await this.options.dispatchAction(method, params, id);
    const frame = outcome.ok
      ? jsonRpcSuccess(id, outcome.result)
      : jsonRpcError(id, outcome.code, outcome.message, outcome.data);
    this.socket?.send(JSON.stringify(frame));
  }

  private onSocketClosed(): void {
    this.teardown("closed");
    if (!this.handshakeSettled) this.failHandshake({ reason: "socket-closed" });
  }

  private onSocketError(): void {
    if (!this.handshakeSettled) this.failHandshake({ reason: "socket-error" });
    this.teardown("closed");
  }

  private failHandshake(failure: HandshakeFailure): void {
    if (this.handshakeSettled) return;
    this.handshakeSettled = true;
    this.teardown("closed");
    this.handshakeReject?.(failure);
  }

  private teardown(nextPhase: ConnectionPhase): void {
    if (this.readyTimer !== null) this.options.timers.clearTimeout(this.readyTimer);
    if (this.socket) {
      const socket = this.socket;
      socket.removeEventListener("open", this.listeners.open as (event: unknown) => void);
      socket.removeEventListener("message", this.listeners.message as (event: unknown) => void);
      socket.removeEventListener("close", this.listeners.close as (event: unknown) => void);
      socket.removeEventListener("error", this.listeners.error as (event: unknown) => void);
      try {
        socket.close(1000, "extension teardown");
      } catch {
        // already closing — fine
      }
      this.socket = null;
    }
    this.setPhase(nextPhase);
  }

  close(): void {
    this.handshakeSettled = true;
    this.teardown("closed");
  }
}
