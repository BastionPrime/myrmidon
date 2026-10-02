// myrmidon(EXTCASE-B): pairing codes and bridge tokens.
//
// Two secrets, two lifetimes (design note §4.2):
//
// - a pairing code is human-readable, one-shot and lives 15 minutes. It is read
//   aloud or copied from a chat, so it uses an alphabet without the confusable
//   characters (no 0/O, 1/I/L) and is stored only as an HMAC;
// - a bridge token is a long-lived opaque 256-bit value bound to one deviceId.
//   It is stored only as an HMAC too: the plaintext exists in the extension's
//   chrome.storage.local and in the one response that hands it over, never at
//   rest on the board. Revocation is a store write, so it is fail-closed — a
//   device whose record is gone cannot authenticate, whatever token it holds.
//
// HMAC (not a bare hash, not encryption) is the right primitive here: the token
// is high-entropy random, so there is nothing to encrypt, but the stored digest
// must be unforgeable without the board's pepper even if the row leaks.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  BRIDGE_TOKEN_BYTES,
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_GROUP_LENGTH,
  PAIRING_CODE_GROUPS,
  bridgeTokenPrefix,
} from "@paperclipai/shared";

/** Injectable randomness so tests can be deterministic. */
export type RandomBytes = (size: number) => Buffer;

const defaultRandom: RandomBytes = (size) => randomBytes(size);

/**
 * One pairing code, two groups of four characters, drawn without modulo bias
 * (values past the largest multiple of the alphabet length are rejected).
 */
export function generatePairingCode(random: RandomBytes = defaultRandom): string {
  const alphabet = PAIRING_CODE_ALPHABET;
  const groups: string[] = [];
  for (let group = 0; group < PAIRING_CODE_GROUPS; group += 1) {
    let chunk = "";
    while (chunk.length < PAIRING_CODE_GROUP_LENGTH) {
      const slice = random(PAIRING_CODE_GROUP_LENGTH * 4);
      for (const byte of slice) {
        if (chunk.length >= PAIRING_CODE_GROUP_LENGTH) break;
        const ceiling = Math.floor(256 / alphabet.length) * alphabet.length;
        if (byte >= ceiling) continue;
        chunk += alphabet[byte % alphabet.length];
      }
    }
    groups.push(chunk);
  }
  return groups.join("-");
}

/** A fresh bridge token. Returned once; only its HMAC is stored. */
export function generateBridgeToken(
  input: { companyId: string; deviceId: string },
  random: RandomBytes = defaultRandom,
): string {
  return formatBridgeToken({ ...input, secret: random(BRIDGE_TOKEN_BYTES).toString("base64url") });
}

export interface BridgeTokenParts {
  companyId: string;
  deviceId: string;
  secret: string;
}

/**
 * `mbb_<companyId>.<deviceId>.<secret>`, company and device base64url-encoded.
 *
 * The token names the company it belongs to, and that is deliberate: the device
 * records live in that company's secret storage, so a connection can only be
 * authenticated per company — and the company in the token is the one whose
 * allowlist and journal apply. Company and device ids are not secrets (they
 * appear in board URLs and panel responses); the crypto lives entirely in the
 * high-entropy secret part, whose HMAC is what the board stores.
 */
export function formatBridgeToken(parts: BridgeTokenParts): string {
  const company = Buffer.from(parts.companyId, "utf8").toString("base64url");
  const device = Buffer.from(parts.deviceId, "utf8").toString("base64url");
  return `${bridgeTokenPrefix}${company}.${device}.${parts.secret}`;
}

export function parseBridgeToken(token: string): BridgeTokenParts | null {
  if (!token.startsWith(bridgeTokenPrefix)) return null;
  const parts = token.slice(bridgeTokenPrefix.length).split(".");
  if (parts.length !== 3) return null;
  const [company, device, secret] = parts;
  if (!company || !device || !secret) return null;
  try {
    const companyId = Buffer.from(company, "base64url").toString("utf8");
    const deviceId = Buffer.from(device, "base64url").toString("utf8");
    if (!companyId || !deviceId) return null;
    return { companyId, deviceId, secret };
  } catch {
    return null;
  }
}

/** The deviceId a token names, or null when the token is not a bridge token. */
export function deviceIdFromToken(token: string): string | null {
  return parseBridgeToken(token)?.deviceId ?? null;
}

/** HMAC-SHA256 of a secret under the board's pepper, hex encoded. */
export function hashSecret(secret: string, pepper: string): string {
  return createHmac("sha256", pepper).update(secret, "utf8").digest("hex");
}

/** Constant-time comparison of two hex digests (length mismatch is a `false`). */
export function digestsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Constant-time comparison of a presented token against a stored digest. */
export function tokenMatchesDigest(token: string, digest: string, pepper: string): boolean {
  return digestsMatch(hashSecret(token, pepper), digest);
}

/** A shape check only: a deviceId is an opaque label the extension generates. */
export function isSafeDeviceId(deviceId: string): boolean {
  return /^[A-Za-z0-9._:-]{1,128}$/.test(deviceId);
}

/** Company-secret key of one paired device (the token store, not a config file). */
export function bridgeDeviceSecretKey(deviceId: string): string {
  return `browser_bridge.device.${deviceId}`;
}

/** Company-secret key prefix that marks a bridge device record. */
export const BRIDGE_DEVICE_SECRET_PREFIX = "browser_bridge.device.";