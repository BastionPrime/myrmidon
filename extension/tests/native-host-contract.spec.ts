import { describe, expect, it } from "vitest";
import {
  isDocumentPayload,
  isSignActionType,
  isSignRequestMessage,
  SIGN_ACTION_TYPES,
  SIGN_ERROR_CODES,
} from "../src/native-host-contract";

function request(overrides: Record<string, unknown> = {}) {
  return {
    type: "sign",
    id: 1,
    actionType: "sign",
    documentRef: "workspace/docs/document.pdf",
    document: { kind: "bytes", bytesBase64: "QUJD" },
    ...overrides,
  };
}

describe("native-host-contract (generic, client-free)", () => {
  it("accepts every enum action type", () => {
    for (const actionType of SIGN_ACTION_TYPES) {
      expect(isSignActionType(actionType)).toBe(true);
    }
  });

  it("rejects invented action types", () => {
    expect(isSignActionType("delete")).toBe(false);
    expect(isSignActionType("sign and also delete")).toBe(false);
    expect(isSignActionType(42)).toBe(false);
    expect(isSignActionType(null)).toBe(false);
  });

  it("payload: bytes require non-empty base64", () => {
    expect(isDocumentPayload({ kind: "bytes", bytesBase64: "QUJD" })).toBe(true);
    expect(isDocumentPayload({ kind: "bytes", bytesBase64: "" })).toBe(false);
    expect(isDocumentPayload({ kind: "bytes" })).toBe(false);
  });

  it("payload: digest requires sha-256 hex", () => {
    expect(isDocumentPayload({ kind: "digest", digestHex: "a".repeat(64) })).toBe(true);
    expect(isDocumentPayload({ kind: "digest", digestHex: "a".repeat(63) })).toBe(false);
    expect(isDocumentPayload({ kind: "digest", digestHex: "xyz" })).toBe(false);
    expect(isDocumentPayload({ kind: "other" })).toBe(false);
  });

  it("accepts a well-formed request", () => {
    expect(isSignRequestMessage(request())).toBe(true);
    expect(isSignRequestMessage(request({ document: { kind: "digest", digestHex: "b".repeat(64) } }))).toBe(true);
  });

  it("rejects a request with an empty or missing documentRef", () => {
    expect(isSignRequestMessage(request({ documentRef: "" }))).toBe(false);
    const { documentRef, ...without } = request() as { documentRef: string };
    expect(isSignRequestMessage(without)).toBe(false);
  });

  it("rejects non-object values and unknown message types", () => {
    expect(isSignRequestMessage("sign")).toBe(false);
    expect(isSignRequestMessage(null)).toBe(false);
    expect(isSignRequestMessage(42)).toBe(false);
    expect(isSignRequestMessage({ type: "exec", command: "calc.exe" })).toBe(false);
  });

  it("error codes stay a closed set", () => {
    expect(SIGN_ERROR_CODES).toEqual([
      "invalid_request",
      "unknown_action_type",
      "unsupported_payload",
      "pin_unavailable",
      "middleware_error",
      "cancelled",
    ]);
  });
});
