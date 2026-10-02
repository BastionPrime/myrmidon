import { describe, expect, it } from "vitest";
import { BridgeConnection, type HandshakeFailure, type TimerPort, type WebSocketFactory, type WebSocketLike } from "../src/gateway-client";

/** A fake socket that records sent frames and lets the test drive events. */
class FakeSocket implements WebSocketLike {
  sent: string[] = [];
  closed = false;
  listeners = new Map<string, Array<(event: unknown) => void>>();

  readyState = 0;

  send(text: string): void {
    this.sent.push(text);
  }

  close(): void {
    this.closed = true;
    this.emit("close", {});
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    const list = (this.listeners.get(type) ?? []).filter((entry) => entry !== listener);
    this.listeners.set(type, list);
  }

  emit(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }

  receive(text: string): void {
    this.emit("message", { data: text });
  }
}

class FakeSocketFactory implements WebSocketFactory {
  sockets: FakeSocket[] = [];

  create(url: string): WebSocketLike {
    const socket = new FakeSocket();
    (socket as unknown as { url: string }).url = url;
    this.sockets.push(socket);
    return socket;
  }
}

/** Manual timer port: the test fires the timeout itself. */
class ManualTimers implements TimerPort {
  handlers: Array<{ handler: () => void; fired: boolean }> = [];

  setTimeout(handler: () => void, _ms: number): unknown {
    const entry = { handler, fired: false };
    this.handlers.push(entry);
    return this.handlers.length - 1;
  }

  clearTimeout(handle: unknown): void {
    const index = typeof handle === "number" ? handle : -1;
    if (this.handlers[index]) this.handlers[index].fired = true;
  }

  fireNext(): void {
    const entry = this.handlers.find((candidate) => !candidate.fired);
    if (!entry) throw new Error("no pending timer");
    entry.fired = true;
    entry.handler();
  }
}

const READY = {
  protocolVersion: 1,
  deviceId: "device-1",
  capabilities: ["open", "read", "click", "screenshot"],
  allowlist: ["tender.example"],
  actionTimeoutMs: 30000,
  confirmationTimeoutMs: 180000,
};

function makeConnection(overrides: Partial<Parameters<typeof makeOptions>[0]> = {}) {
  const sockets = new FakeSocketFactory();
  const timers = new ManualTimers();
  const options = makeOptions({ sockets, timers, ...overrides });
  const connection = new BridgeConnection(options);
  return { connection, sockets, timers, options };
}

function makeOptions(overrides: Record<string, unknown> = {}) {
  return {
    origin: "https://bridge.example.com",
    deviceId: "device-1",
    extVersion: "0.1.0",
    token: "mbb_testtoken",
    capabilities: ["open", "read", "click", "screenshot"],
    allowlist: ["tender.example"],
    wsPath: "/bridge/v1",
    sockets: new FakeSocketFactory(),
    dispatchAction: async () => ({ ok: true as const, result: { fine: true } }),
    readyTimeoutMs: 5000,
    timers: new ManualTimers(),
    ...overrides,
  };
}

describe("BridgeConnection handshake", () => {
  it("dials the bridge url with the token as the query parameter", async () => {
    const { connection, sockets } = makeConnection();
    const promise = connection.connect();
    expect(sockets.sockets[0]).toBeDefined();
    expect((sockets.sockets[0] as unknown as { url: string }).url).toBe(
      "wss://bridge.example.com/bridge/v1?token=mbb_testtoken",
    );
    sockets.sockets[0].emit("open", {});
    sockets.sockets[0].receive(JSON.stringify({ jsonrpc: "2.0", id: 1, result: READY }));
    await promise;
    connection.close();
  });

  it("sends bridge.hello with deviceId, extVersion and capabilities on open", async () => {
    const { connection, sockets } = makeConnection();
    const promise = connection.connect();
    sockets.sockets[0].emit("open", {});
    expect(sockets.sockets[0].sent).toHaveLength(1);
    const hello = JSON.parse(sockets.sockets[0].sent[0]);
    expect(hello).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "bridge.hello",
      params: {
        deviceId: "device-1",
        extVersion: "0.1.0",
        capabilities: ["open", "read", "click", "screenshot"],
      },
    });
    sockets.sockets[0].receive(JSON.stringify({ jsonrpc: "2.0", id: 1, result: READY }));
    await promise;
    connection.close();
  });

  it("resolves on a matching bridge.ready and reports the allowlist", async () => {
    const allowlistUpdates: string[][] = [];
    const { connection, sockets } = makeConnection({ onAllowlistUpdate: (domains: string[]) => allowlistUpdates.push(domains) });
    const promise = connection.connect();
    sockets.sockets[0].emit("open", {});
    sockets.sockets[0].receive(JSON.stringify({ jsonrpc: "2.0", id: 1, result: READY }));
    await promise;
    expect(allowlistUpdates).toEqual([["tender.example"]]);
    expect(connection.currentPhase).toBe("ready");
    connection.close();
  });

  it("rejects on a protocol version mismatch (red side)", async () => {
    const { connection, sockets } = makeConnection();
    const promise = connection.connect();
    sockets.sockets[0].emit("open", {});
    sockets.sockets[0].receive(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ...READY, protocolVersion: 99 } }));
    await expect(promise).rejects.toMatchObject({ reason: "protocol-version", expected: 1, received: 99 });
  });

  it("rejects when the ready answer names another device", async () => {
    const { connection, sockets } = makeConnection();
    const promise = connection.connect();
    sockets.sockets[0].emit("open", {});
    sockets.sockets[0].receive(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ...READY, deviceId: "device-2" } }));
    await expect(promise).rejects.toMatchObject({ reason: "gateway-error" });
  });

  it("rejects with revoked when the gateway refuses the token", async () => {
    const { connection, sockets } = makeConnection();
    const promise = connection.connect();
    sockets.sockets[0].emit("open", {});
    sockets.sockets[0].receive(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32011, message: "revoked" } }));
    await expect(promise).rejects.toMatchObject({ reason: "revoked" });
  });

  it("rejects on a socket error before ready", async () => {
    const { connection, sockets } = makeConnection();
    const promise = connection.connect();
    sockets.sockets[0].emit("error", {});
    await expect(promise).rejects.toMatchObject({ reason: "socket-error" });
  });

  it("rejects when the socket closes before ready", async () => {
    const { connection, sockets } = makeConnection();
    const promise = connection.connect();
    sockets.sockets[0].emit("close", {});
    await expect(promise).rejects.toMatchObject({ reason: "socket-closed" });
  });

  it("rejects when bridge.ready never arrives (ready timeout)", async () => {
    const { connection, sockets, timers } = makeConnection();
    const promise = connection.connect();
    sockets.sockets[0].emit("open", {});
    timers.fireNext();
    await expect(promise).rejects.toMatchObject({ reason: "ready-timeout" });
  });
});

describe("BridgeConnection after ready", () => {
  async function connected(overrides: Record<string, unknown> = {}) {
    const made = makeConnection(overrides);
    const promise = made.connection.connect();
    made.sockets.sockets[0].emit("open", {});
    made.sockets.sockets[0].receive(JSON.stringify({ jsonrpc: "2.0", id: 1, result: READY }));
    await promise;
    return made;
  }

  it("answers a gateway action request with the dispatched result", async () => {
    const made = await connected();
    made.sockets.sockets[0].receive(JSON.stringify({ jsonrpc: "2.0", id: 42, method: "browser.read" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const reply = JSON.parse(made.sockets.sockets[0].sent[1]);
    expect(reply).toEqual({ jsonrpc: "2.0", id: 42, result: { fine: true } });
    made.connection.close();
  });

  it("answers a refused action with the application error code", async () => {
    const made = await connected({
      dispatchAction: async () => ({ ok: false as const, code: -32013, message: "outside allowlist" }),
    });
    made.sockets.sockets[0].receive(JSON.stringify({ jsonrpc: "2.0", id: 43, method: "browser.open", params: { url: "https://other.example" } }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const reply = JSON.parse(made.sockets.sockets[0].sent[1]);
    expect(reply.error?.code).toBe(-32013);
    made.connection.close();
  });

  it("replies to an invalid frame with the standard error and does not execute it", async () => {
    const dispatched: string[] = [];
    const made = await connected({
      dispatchAction: async (method: string) => {
        dispatched.push(method);
        return { ok: true as const, result: null };
      },
    });
    made.sockets.sockets[0].receive("not json at all");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const reply = JSON.parse(made.sockets.sockets[0].sent[1]);
    expect(reply.error?.code).toBe(-32700);
    expect(dispatched).toEqual([]);
    made.connection.close();
  });

  it("marks the connection closed when the gateway drops it", async () => {
    const phases: string[] = [];
    const made = await connected({ onPhaseChange: (phase: string) => phases.push(phase) });
    made.sockets.sockets[0].emit("close", {});
    expect(made.connection.currentPhase).toBe("closed");
    expect(phases).toContain("closed");
  });
});
