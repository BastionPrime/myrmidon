// myrmidon(SC1): signed auth-JSON for Apache Guacamole (guacamole-auth-json).
//
// Guacamole accepts a user only through a blob it can decrypt and verify with
// the shared `json-secret-key`. The vendor's reference implementation
// (extensions/guacamole-auth-json/doc/encrypt-json.sh) builds that blob in
// three steps, and this module reproduces them exactly:
//
//   1. sign the JSON bytes with HMAC/SHA-256 and prepend the binary signature
//      to the plaintext JSON;
//   2. encrypt signature+JSON with AES-128-CBC, a null (all-zero) IV and
//      PKCS#5 padding;
//   3. base64-encode the result.
//
// The key is a 32-digit hexadecimal value (128 bits). It is carried into this
// module by the caller and never logged, echoed into a response body or put
// into an audit record.

import { createCipheriv, createDecipheriv, createHmac, timingSafeEqual } from "node:crypto";

/** The all-zero initial vector guacamole-auth-json uses. */
const NULL_IV = Buffer.alloc(16);

/** HMAC/SHA-256 output length, in bytes. */
const SIGNATURE_BYTES = 32;

/** A `json-secret-key` value: 32 hexadecimal digits = 128 bits. */
export const AUTH_JSON_SECRET_KEY_PATTERN = /^[0-9a-fA-F]{32}$/;

export interface GuacamoleConnection {
  protocol: string;
  parameters: Record<string, string>;
}

export interface GuacamoleAuthJson {
  username: string;
  /** UNIX epoch timestamp with millisecond resolution. */
  expires: number;
  connections: Record<string, GuacamoleConnection>;
}

/** Raised when a blob cannot be read back with the given key, or has expired. */
export class AuthJsonError extends Error {
  readonly code: "invalid_key" | "malformed" | "signature_mismatch" | "expired";

  constructor(code: AuthJsonError["code"], message: string) {
    super(message);
    this.name = "AuthJsonError";
    this.code = code;
  }
}

function keyBytes(secretKeyHex: string): Buffer {
  if (!AUTH_JSON_SECRET_KEY_PATTERN.test(secretKeyHex)) {
    throw new AuthJsonError(
      "invalid_key",
      "json-secret-key must be a 32-digit hexadecimal value (128 bits)",
    );
  }
  return Buffer.from(secretKeyHex, "hex");
}

/** Step 1+2+3 of the vendor reference implementation. */
export function signGuacamoleAuthJson(authJson: GuacamoleAuthJson, secretKeyHex: string): string {
  const key = keyBytes(secretKeyHex);
  const body = Buffer.from(JSON.stringify(authJson), "utf8");
  const signature = createHmac("sha256", key).update(body).digest();
  const cipher = createCipheriv("aes-128-cbc", key, NULL_IV);
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([signature, body])), cipher.final()]);
  return encrypted.toString("base64");
}

/**
 * Reverse of `signGuacamoleAuthJson` for the same key, used by tests and by the
 * acceptance stand to prove a token is what Guacamole expects. Throws when the
 * signature does not match, the payload is unreadable, or `expires` has passed.
 */
export function decodeGuacamoleAuthJson(
  token: string,
  secretKeyHex: string,
  nowMs: number = Date.now(),
): GuacamoleAuthJson {
  const key = keyBytes(secretKeyHex);
  let signed: Buffer;
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, NULL_IV);
    signed = Buffer.concat([decipher.update(Buffer.from(token, "base64")), decipher.final()]);
  } catch {
    throw new AuthJsonError("malformed", "the token is not a valid AES-128-CBC blob for this key");
  }
  if (signed.length <= SIGNATURE_BYTES) {
    throw new AuthJsonError("malformed", "the token is shorter than its own signature");
  }
  const signature = signed.subarray(0, SIGNATURE_BYTES);
  const body = signed.subarray(SIGNATURE_BYTES);
  const expected = createHmac("sha256", key).update(body).digest();
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) {
    throw new AuthJsonError("signature_mismatch", "the token signature does not match");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new AuthJsonError("malformed", "the token payload is not JSON");
  }
  const authJson = parsed as Partial<GuacamoleAuthJson>;
  if (typeof authJson.expires !== "number" || !Number.isFinite(authJson.expires)) {
    throw new AuthJsonError("malformed", "the token payload has no numeric expires");
  }
  if (authJson.expires <= nowMs) {
    throw new AuthJsonError("expired", "the token has expired");
  }
  if (typeof authJson.username !== "string" || typeof authJson.connections !== "object") {
    throw new AuthJsonError("malformed", "the token payload is not an auth-JSON document");
  }
  return authJson as GuacamoleAuthJson;
}