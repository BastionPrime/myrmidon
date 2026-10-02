// The pairing client: exchange a one-shot human-readable code for a bridge token.
//
// The pairing code is created by the company operator in the bridge panel and
// handed to the person at the client PC by any channel. The person types it
// into the popup exactly as read ("ABCD-2345"); this module normalizes it,
// POSTs it to the gateway's pairing endpoint with the extension's device id
// and capabilities, and stores the returned bridge token. The token lives in
// chrome.storage.local and never leaves the PC except as the WSS query
// parameter the gateway's transport defined.
//
// Fixtures in tests use example.com and neutral codes.

import type { PairingExchangeWireRequest, PairedDeviceInfo } from "./protocol";

export interface PairingGatewayPort {
  /** POST the pairing exchange; resolves with the paired-device payload. */
  exchangePairing(input: { origin: string; body: PairingExchangeWireRequest }): Promise<PairedDeviceInfo>;
}

/** Normalize a pairing code as typed: trim, uppercase, dash optional. */
export function normalizePairingCodeInput(raw: string): string | null {
  const compact = raw.trim().toUpperCase().replace(/[\s-]+/g, "");
  if (compact.length !== 8) return null;
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  for (const char of compact) {
    if (!alphabet.includes(char)) return null;
  }
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

/** Accept a host[:port] or https://host[:port] origin; return the scheme+host URL. */
export function parseGatewayOriginInput(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (value.includes("@")) return null;
  // An explicit scheme must be http(s); anything else (ftp://, wss://, ...) is
  // not a gateway origin.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !/^https?:\/\//i.test(value)) return null;
  const withScheme = /^https?:\/\//.test(value) ? value : `https://${value}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (parsed.pathname !== "" && parsed.pathname !== "/") return null;
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i.test(parsed.host)) return null;
  return `${parsed.protocol}//${parsed.host}`;
}

/** The WSS url the extension dials for a given origin and token. */
export function buildBridgeWsUrl(origin: string, token: string, wsPath: string): string {
  const secure = origin.replace(/^http:\/\//, "ws://").replace(/^https:\/\//, "wss://");
  const url = new URL(`${secure}${wsPath.startsWith("/") ? wsPath : `/${wsPath}`}`);
  url.searchParams.set("token", token);
  return url.toString();
}

export function buildPairingUrl(origin: string, pairPath: string): string {
  const secure = origin.replace(/^http:\/\//, "ws://").replace(/^https:\/\//, "wss://");
  const asHttp = secure.replace(/^ws:\/\//, "http://").replace(/^wss:\/\//, "https://");
  return `${asHttp}${pairPath.startsWith("/") ? pairPath : `/${pairPath}`}`;
}

/** The gateway port as the service worker builds it: fetch, JSON in/out. */
export class FetchPairingGateway implements PairingGatewayPort {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async exchangePairing(input: { origin: string; body: PairingExchangeWireRequest }): Promise<PairedDeviceInfo> {
    const response = await this.fetchImpl(buildPairingUrl(input.origin, "/bridge/v1/pair"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input.body),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok || typeof payload !== "object" || payload === null) {
      throw new Error(`pairing exchange failed (${response.status})`);
    }
    const candidate = payload as Record<string, unknown>;
    if (
      typeof candidate.deviceId !== "string" ||
      typeof candidate.token !== "string" ||
      !Array.isArray(candidate.capabilities) ||
      !Array.isArray(candidate.allowlist) ||
      typeof candidate.pairedAt !== "string"
    ) {
      throw new Error("pairing response is malformed");
    }
    return {
      deviceId: candidate.deviceId,
      token: candidate.token,
      capabilities: candidate.capabilities.filter((entry): entry is string => typeof entry === "string"),
      allowlist: candidate.allowlist.filter((entry): entry is string => typeof entry === "string"),
      pairedAt: candidate.pairedAt,
    };
  }
}
