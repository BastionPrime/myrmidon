// Extension state: the settings object and its chrome.storage.local port.
//
// Everything the extension persists lives in chrome.storage.local: the
// bridge token, the device id, the allowlist copy and the gateway origin.
// The token never travels anywhere except the pairing call (which returns
// it), the WSS url (as the `token` query parameter, the same channel the
// gateway defined because a browser extension cannot set headers on a
// WebSocket), and this storage. It is never logged and never sent to a page.

import type { AllowlistUpdate, PairedDeviceInfo } from "./protocol";

export interface StoredSettings {
  /** Device id generated on the client PC; stable across browser restarts. */
  deviceId: string;
  extVersion: string;
  /** Gateway origin as https://host[:port]; the WSS url derives from it. */
  gatewayOrigin: string;
  paired: null | {
    token: string;
    capabilities: string[];
    allowlist: string[];
    pairedAt: string;
  };
}

export interface SettingsStore {
  load(): Promise<StoredSettings | null>;
  save(settings: StoredSettings): Promise<void>;
  remove(key: "paired"): Promise<void>;
}

const STORAGE_KEY = "myrmidonBridgeSettings";

/** In-memory implementation for tests and for the popup's preview mode. */
export class InMemorySettingsStore implements SettingsStore {
  private data: StoredSettings | null = null;

  async load(): Promise<StoredSettings | null> {
    return this.data ? structuredClone(this.data) : null;
  }

  async save(settings: StoredSettings): Promise<void> {
    this.data = structuredClone(settings);
  }

  async remove(key: "paired"): Promise<void> {
    if (this.data && key === "paired") this.data.paired = null;
  }
}

/** chrome.storage.local port; runs in the service worker and the popup. */
export class ChromeStorageSettingsStore implements SettingsStore {
  async load(): Promise<StoredSettings | null> {
    const bag = await chrome.storage.local.get(STORAGE_KEY);
    const value = bag[STORAGE_KEY] as StoredSettings | undefined;
    return value ? structuredClone(value) : null;
  }

  async save(settings: StoredSettings): Promise<void> {
    await chrome.storage.local.set({ [STORAGE_KEY]: structuredClone(settings) });
  }

  async remove(key: "paired"): Promise<void> {
    if (key !== "paired") return;
    const current = await this.load();
    if (!current) return;
    current.paired = null;
    await chrome.storage.local.set({ [STORAGE_KEY]: current });
  }
}

/** A fresh 128-bit device id, hex encoded (Web Crypto is available in MV3). */
export async function generateDeviceId(
  randomSource: { getRandomValues(view: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> } = globalThis.crypto,
): Promise<string> {
  const bytes = new Uint8Array(new ArrayBuffer(16));
  randomSource.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function newUnpairedSettings(deviceId: string, gatewayOrigin: string, extVersion: string): StoredSettings {
  return { deviceId, gatewayOrigin, extVersion, paired: null };
}

/** Apply the pairing response to the stored state. */
export function applyPairing(settings: StoredSettings, info: PairedDeviceInfo): StoredSettings {
  return {
    ...settings,
    paired: {
      token: info.token,
      capabilities: [...info.capabilities],
      allowlist: [...info.allowlist],
      pairedAt: info.pairedAt,
    },
  };
}

/** Apply an allowlist update (from `bridge.ready`) to the stored state. */
export function applyAllowlistUpdate(settings: StoredSettings, update: AllowlistUpdate): StoredSettings {
  if (!settings.paired) return settings;
  return { ...settings, paired: { ...settings.paired, allowlist: [...update.domains] } };
}

export function isSettings(value: unknown): value is StoredSettings {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<StoredSettings>;
  if (typeof candidate.deviceId !== "string" || candidate.deviceId.length === 0) return false;
  if (typeof candidate.extVersion !== "string" || candidate.extVersion.length === 0) return false;
  if (typeof candidate.gatewayOrigin !== "string" || candidate.gatewayOrigin.length === 0) return false;
  if (candidate.paired === null) return true;
  if (typeof candidate.paired !== "object") return false;
  const paired = candidate.paired;
  return (
    typeof paired.token === "string" &&
    paired.token.length > 0 &&
    Array.isArray(paired.capabilities) &&
    Array.isArray(paired.allowlist) &&
    typeof paired.pairedAt === "string"
  );
}

/** Parse what storage handed back; null when the stored blob is unusable. */
export function parseStoredSettings(value: unknown): StoredSettings | null {
  return isSettings(value) ? value : null;
}
