// myrmidon(SC1): the auth-JSON blob must be what Guacamole's
// guacamole-auth-json extension can read.
//
// The known-answer vector below was produced with the vendor's own reference
// tool, the OpenSSL pipeline of
// extensions/guacamole-auth-json/doc/encrypt-json.sh:
//
//   (openssl dgst -sha256 -mac HMAC -macopt hexkey:$KEY -binary auth.json; \
//    cat auth.json) | openssl enc -aes-128-cbc -K $KEY -iv <32 zeroes> -nosalt -a -A
//
// The JSON file must hold exactly the bytes that are signed: a trailing
// newline changes both the signature and the vector.
//
// Any change to the signing order, the cipher mode, the IV or the padding
// breaks the first test.

import { describe, expect, it } from "vitest";
import { buildConsoleAuthJson } from "./domain.js";
import {
  AUTH_JSON_SECRET_KEY_PATTERN,
  AuthJsonError,
  decodeGuacamoleAuthJson,
  signGuacamoleAuthJson,
} from "./token.js";

const SECRET_KEY = "4C0B569E4C96DF157EEE1B65DD0E4D41";
const EXPIRES_AT = 1446323765000;

const VENDOR_VECTOR =
  "4FSwwkZ75ZMY3XjXQR4axqkJlkkpi8/Qen2btcw0SPJ1wudT6Ihk229Ak86HMc2T6uzR7xZvtrlRz4OglVW1kEZZ44qF8Yf0adcGWxyxPQ7vozzKMBZNFRo6ZSVHujmcXBjolFv0C9aLAjBUknX0enoc5+G3BBRbA5x2MdE0B/kdaulthI6ROJJRkBJyw3QI1PoJhfbUTL4THAmxXktgKhtvPPl4PBHon9NWh7HrP5O4AFigRfjAifOHGp4nEVzRF7HGfasAluaL/1SAo1wMbA==";

const NODE = {
  name: "node-a",
  protocol: "ssh" as const,
  hostname: "192.0.2.10",
  port: 22,
  username: "fleet-console",
};

function authJson(expiresAt: number = EXPIRES_AT) {
  return buildConsoleAuthJson({
    server: NODE,
    guacamoleUsername: "owner-a",
    password: null,
    expiresAt,
  });
}

describe("Guacamole auth-JSON signing", () => {
  it("reproduces the vendor reference tool byte for byte", () => {
    expect(signGuacamoleAuthJson(authJson(), SECRET_KEY)).toBe(VENDOR_VECTOR);
  });

  it("carries the connection parameters the registry row describes", () => {
    const decoded = decodeGuacamoleAuthJson(VENDOR_VECTOR, SECRET_KEY, EXPIRES_AT - 1);
    expect(decoded).toEqual({
      username: "owner-a",
      expires: EXPIRES_AT,
      connections: {
        "node-a": {
          protocol: "ssh",
          parameters: { hostname: "192.0.2.10", port: "22", username: "fleet-console" },
        },
      },
    });
  });

  it("keeps a resolved node password inside the ciphertext, never beside it", () => {
    const withPassword = buildConsoleAuthJson({
      server: NODE,
      guacamoleUsername: "owner-a",
      password: "node-password-a",
      expiresAt: EXPIRES_AT,
    });
    const token = signGuacamoleAuthJson(withPassword, SECRET_KEY);
    expect(token).not.toContain("node-password-a");
    const decoded = decodeGuacamoleAuthJson(token, SECRET_KEY, EXPIRES_AT - 1);
    expect(decoded.connections["node-a"]!.parameters.password).toBe("node-password-a");
  });

  it("refuses the token at its expires instant and accepts it one millisecond earlier", () => {
    const token = signGuacamoleAuthJson(authJson(), SECRET_KEY);
    let code: string | null = null;
    try {
      decodeGuacamoleAuthJson(token, SECRET_KEY, EXPIRES_AT);
    } catch (err) {
      code = err instanceof AuthJsonError ? err.code : "not-an-auth-error";
    }
    expect(code).toBe("expired");
    expect(decodeGuacamoleAuthJson(token, SECRET_KEY, EXPIRES_AT - 1).expires).toBe(EXPIRES_AT);
  });

  it("refuses a token signed with another key", () => {
    const token = signGuacamoleAuthJson(authJson(), SECRET_KEY);
    expect(() => decodeGuacamoleAuthJson(token, "00000000000000000000000000000000", EXPIRES_AT - 1)).toThrowError(
      AuthJsonError,
    );
  });

  it("refuses a key that is not a 128-bit hexadecimal value", () => {
    expect(AUTH_JSON_SECRET_KEY_PATTERN.test("not-a-key")).toBe(false);
    let code: string | null = null;
    try {
      signGuacamoleAuthJson(authJson(), "not-a-key");
    } catch (err) {
      code = err instanceof AuthJsonError ? err.code : "not-an-auth-error";
    }
    expect(code).toBe("invalid_key");
  });

  it("reports a payload edited after signing as unsigned", () => {
    const token = signGuacamoleAuthJson(authJson(), SECRET_KEY);
    const tampered = Buffer.from(token, "base64");
    // An early byte: the final block stays intact, so the failure is the
    // signature and not broken padding.
    tampered[20] = tampered[20]! ^ 0xff;
    let code: string | null = null;
    try {
      decodeGuacamoleAuthJson(tampered.toString("base64"), SECRET_KEY, EXPIRES_AT - 1);
    } catch (err) {
      code = err instanceof AuthJsonError ? err.code : "not-an-auth-error";
    }
    expect(code).toBe("signature_mismatch");
  });
});