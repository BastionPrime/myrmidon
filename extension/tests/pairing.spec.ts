import { describe, expect, it } from "vitest";
import {
  buildBridgeWsUrl,
  buildPairingUrl,
  normalizePairingCodeInput,
  parseGatewayOriginInput,
} from "../src/pairing";

describe("normalizePairingCodeInput", () => {
  it("canonicalizes the code as the person typed it", () => {
    expect(normalizePairingCodeInput("abcd-2345")).toBe("ABCD-2345");
    expect(normalizePairingCodeInput(" ABCD 2345 ")).toBe("ABCD-2345");
    expect(normalizePairingCodeInput("ABCD2345")).toBe("ABCD-2345");
  });

  it("accepts every character of the pairing alphabet", () => {
    expect(normalizePairingCodeInput("ABCD-EFGH")).toBe("ABCD-EFGH");
    expect(normalizePairingCodeInput("KJMP-NPQR")).toBe("KJMP-NPQR");
    expect(normalizePairingCodeInput("STUV-WXYZ")).toBe("STUV-WXYZ");
    expect(normalizePairingCodeInput("2345-6789")).toBe("2345-6789");
    // K, M, N, P are regular alphabet letters and must pass; the confusables
    // (0/O, 1/I/L) are covered by the rejection test below.
    expect(normalizePairingCodeInput("KMNP-2345")).toBe("KMNP-2345");
  });

  it("rejects confusable and out-of-alphabet characters", () => {
    // 0, O, 1, I, L are excluded from the alphabet by contract.
    expect(normalizePairingCodeInput("ABCD-O123")).toBeNull();
    expect(normalizePairingCodeInput("ABCD-0123")).toBeNull();
    expect(normalizePairingCodeInput("ABCD-1ABC")).toBeNull();
    expect(normalizePairingCodeInput("ABCD-LABC")).toBeNull();
    expect(normalizePairingCodeInput("ABCD-IABC")).toBeNull();
  });

  it("rejects wrong lengths and junk", () => {
    expect(normalizePairingCodeInput("ABC-2345")).toBeNull();
    expect(normalizePairingCodeInput("ABCDE-2345")).toBeNull();
    expect(normalizePairingCodeInput("")).toBeNull();
    expect(normalizePairingCodeInput("abcd_2345")).toBeNull();
  });
});

describe("parseGatewayOriginInput", () => {
  it("accepts a bare host and a host with port, with or without scheme", () => {
    expect(parseGatewayOriginInput("bridge.example.com")).toBe("https://bridge.example.com");
    expect(parseGatewayOriginInput("bridge.example.com:9443")).toBe("https://bridge.example.com:9443");
    expect(parseGatewayOriginInput("https://bridge.example.com")).toBe("https://bridge.example.com");
    expect(parseGatewayOriginInput("http://bridge.example.com")).toBe("http://bridge.example.com");
  });

  it("trims and keeps only scheme + host (no path, no userinfo)", () => {
    expect(parseGatewayOriginInput("  bridge.example.com/  ")).toBe("https://bridge.example.com");
    expect(parseGatewayOriginInput("https://user@bridge.example.com")).toBeNull();
    expect(parseGatewayOriginInput("https://bridge.example.com/path")).toBeNull();
  });

  it("rejects junk", () => {
    expect(parseGatewayOriginInput("")).toBeNull();
    expect(parseGatewayOriginInput("not a host")).toBeNull();
    expect(parseGatewayOriginInput("ftp://bridge.example.com")).toBeNull();
  });
});

describe("buildBridgeWsUrl", () => {
  it("derives the wss url with the token as the query parameter", () => {
    expect(buildBridgeWsUrl("https://bridge.example.com", "mbb_testtoken", "/bridge/v1")).toBe(
      "wss://bridge.example.com/bridge/v1?token=mbb_testtoken",
    );
  });

  it("maps an http origin to ws (local stand only)", () => {
    expect(buildBridgeWsUrl("http://bridge.example.com", "mbb_t", "/bridge/v1")).toBe(
      "ws://bridge.example.com/bridge/v1?token=mbb_t",
    );
  });
});

describe("buildPairingUrl", () => {
  it("builds the https pairing endpoint from the origin", () => {
    expect(buildPairingUrl("https://bridge.example.com", "/bridge/v1/pair")).toBe(
      "https://bridge.example.com/bridge/v1/pair",
    );
  });
});
