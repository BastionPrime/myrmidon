import { describe, expect, it } from "vitest";
import { encodeBase64 } from "../src/base64";

describe("encodeBase64", () => {
  it("encodes every remainder length correctly", () => {
    expect(encodeBase64(new Uint8Array([]))).toBe("");
    expect(encodeBase64(new Uint8Array([65]))).toBe("QQ==");
    expect(encodeBase64(new Uint8Array([65, 66]))).toBe("QUI=");
    expect(encodeBase64(new Uint8Array([65, 66, 67]))).toBe("QUJD");
    expect(encodeBase64(new Uint8Array([1, 2, 3, 4]))).toBe("AQIDBA==");
  });

  it("agrees with the runtime's own btoa over a full byte range", () => {
    const bytes = new Uint8Array(256).map((_, index) => index);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    expect(encodeBase64(bytes)).toBe(btoa(binary));
  });
});