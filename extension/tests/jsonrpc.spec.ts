import { describe, expect, it } from "vitest";
import { jsonRpcError, jsonRpcRequest, jsonRpcSuccess, parseIncoming, parseBridgeReadyResult } from "../src/jsonrpc";

const READY_RESULT = {
  protocolVersion: 1,
  deviceId: "device-1",
  capabilities: ["open", "read", "click", "fill", "download", "screenshot"],
  allowlist: ["tender.example"],
  actionTimeoutMs: 30000,
  confirmationTimeoutMs: 180000,
};

describe("parseIncoming", () => {
  it("parses a gateway action request", () => {
    const incoming = parseIncoming(JSON.stringify(jsonRpcRequest(7, "browser.read")));
    expect(incoming.kind).toBe("request");
    if (incoming.kind !== "request") return;
    expect(incoming.request.id).toBe(7);
    expect(incoming.request.method).toBe("browser.read");
  });

  it("parses a response frame (the handshake answer)", () => {
    const frame = JSON.stringify({ jsonrpc: "2.0", id: 1, result: READY_RESULT });
    const incoming = parseIncoming(frame);
    expect(incoming.kind).toBe("response");
  });

  it("answers invalid JSON with the parse error", () => {
    const incoming = parseIncoming("this is not json");
    expect(incoming.kind).toBe("invalid");
    if (incoming.kind !== "invalid") return;
    expect(incoming.reply.error?.code).toBe(-32700);
  });

  it("answers non-request JSON with invalid request", () => {
    const incoming = parseIncoming(JSON.stringify({ hello: "world" }));
    expect(incoming.kind).toBe("invalid");
    if (incoming.kind !== "invalid") return;
    expect(incoming.reply.error?.code).toBe(-32600);
  });

  it("parses a notification (no id) as the gateway's cancellation", () => {
    const incoming = parseIncoming(JSON.stringify({ jsonrpc: "2.0", method: "browser.cancel", params: { id: "gw-3" } }));
    expect(incoming.kind).toBe("notification");
    if (incoming.kind !== "notification") return;
    expect(incoming.method).toBe("browser.cancel");
    expect((incoming.params as { id: string }).id).toBe("gw-3");
  });

  it("refuses a frame with a wrong jsonrpc version", () => {
    const incoming = parseIncoming(JSON.stringify({ jsonrpc: "1.0", id: 3, method: "browser.read" }));
    expect(incoming.kind).toBe("invalid");
  });
});

describe("parseBridgeReadyResult", () => {
  it("parses a well-formed result", () => {
    const ready = parseBridgeReadyResult(READY_RESULT);
    expect(ready).not.toBeNull();
    expect(ready?.protocolVersion).toBe(1);
    expect(ready?.allowlist).toEqual(["tender.example"]);
  });

  it("returns null on malformed payloads", () => {
    expect(parseBridgeReadyResult(null)).toBeNull();
    expect(parseBridgeReadyResult({})).toBeNull();
    expect(parseBridgeReadyResult({ ...READY_RESULT, protocolVersion: "one" })).toBeNull();
    expect(parseBridgeReadyResult({ ...READY_RESULT, allowlist: "tender.example" })).toBeNull();
  });
});

describe("response frames", () => {
  it("success echoes the id and carries the result", () => {
    const frame = jsonRpcSuccess(9, { ok: true });
    expect(frame).toEqual({ jsonrpc: "2.0", id: 9, result: { ok: true } });
  });

  it("error carries the application code", () => {
    const frame = jsonRpcError(9, -32013, "outside allowlist", { url: "https://other.example" });
    expect(frame.error?.code).toBe(-32013);
    expect(frame.error?.data).toEqual({ url: "https://other.example" });
  });

  it("request frames are plain JSON-RPC 2.0", () => {
    const frame = jsonRpcRequest(1, "bridge.hello", { deviceId: "device-1" });
    expect(JSON.parse(JSON.stringify(frame))).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "bridge.hello",
      params: { deviceId: "device-1" },
    });
  });
});
