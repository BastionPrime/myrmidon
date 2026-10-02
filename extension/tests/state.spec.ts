import { beforeEach, describe, expect, it } from "vitest";
import {
  ChromeStorageSettingsStore,
  InMemorySettingsStore,
  applyAllowlistUpdate,
  applyPairing,
  generateDeviceId,
  isSettings,
  newUnpairedSettings,
  parseStoredSettings,
  type StoredSettings,
} from "../src/state";

function unpaired(): StoredSettings {
  return newUnpairedSettings("device-1", "https://bridge.example.com", "0.1.0");
}

describe("InMemorySettingsStore", () => {
  it("round-trips settings", async () => {
    const store = new InMemorySettingsStore();
    await store.save(unpaired());
    const loaded = await store.load();
    expect(loaded?.deviceId).toBe("device-1");
  });

  it("returns null before anything is saved", async () => {
    const store = new InMemorySettingsStore();
    expect(await store.load()).toBeNull();
  });

  it("remove('paired') drops the pairing and keeps the device", async () => {
    const store = new InMemorySettingsStore();
    const settings = applyPairing(unpaired(), {
      deviceId: "device-1",
      token: "mbb_testtoken",
      capabilities: ["read"],
      allowlist: ["tender.example"],
      pairedAt: "2026-10-01T00:00:00.000Z",
    });
    await store.save(settings);
    await store.remove("paired");
    const loaded = await store.load();
    expect(loaded?.paired).toBeNull();
    expect(loaded?.deviceId).toBe("device-1");
  });
});

describe("ChromeStorageSettingsStore", () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>).chrome = {
      storage: {
        local: {
          bag: new Map<string, unknown>(),
          async get(key: string) {
            return Object.fromEntries([[key, this.bag.get(key)]]);
          },
          async set(entries: Record<string, unknown>) {
            for (const [key, value] of Object.entries(entries)) this.bag.set(key, value);
          },
        },
      },
    };
  });

  it("persists through chrome.storage.local", async () => {
    const store = new ChromeStorageSettingsStore();
    await store.save(applyPairing(unpaired(), {
      deviceId: "device-1",
      token: "mbb_testtoken",
      capabilities: ["read"],
      allowlist: ["tender.example"],
      pairedAt: "2026-10-01T00:00:00.000Z",
    }));
    const loaded = await store.load();
    expect(loaded?.paired?.token).toBe("mbb_testtoken");
  });

  it("clears the pairing on remove", async () => {
    const store = new ChromeStorageSettingsStore();
    await store.save(applyPairing(unpaired(), {
      deviceId: "device-1",
      token: "mbb_testtoken",
      capabilities: ["read"],
      allowlist: ["tender.example"],
      pairedAt: "2026-10-01T00:00:00.000Z",
    }));
    await store.remove("paired");
    expect((await store.load())?.paired).toBeNull();
  });
});

describe("applyPairing / applyAllowlistUpdate", () => {
  it("applyPairing stores the token, capabilities and allowlist", () => {
    const next = applyPairing(unpaired(), {
      deviceId: "device-1",
      token: "mbb_testtoken",
      capabilities: ["read", "click"],
      allowlist: ["tender.example"],
      pairedAt: "2026-10-01T00:00:00.000Z",
    });
    expect(next.paired?.token).toBe("mbb_testtoken");
    expect(next.paired?.allowlist).toEqual(["tender.example"]);
  });

  it("applyAllowlistUpdate replaces the allowlist copy of a paired device", () => {
    const paired = applyPairing(unpaired(), {
      deviceId: "device-1",
      token: "mbb_testtoken",
      capabilities: ["read"],
      allowlist: ["old.example"],
      pairedAt: "2026-10-01T00:00:00.000Z",
    });
    const next = applyAllowlistUpdate(paired, { domains: ["tender.example", "portal.example"] });
    expect(next.paired?.allowlist).toEqual(["tender.example", "portal.example"]);
  });

  it("applyAllowlistUpdate is a no-op when unpaired", () => {
    const next = applyAllowlistUpdate(unpaired(), { domains: ["tender.example"] });
    expect(next.paired).toBeNull();
  });
});

describe("generateDeviceId", () => {
  it("produces 32 hex characters from the injected random source", async () => {
    let call = 0;
    const fake = {
      getRandomValues(view: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
        for (let i = 0; i < view.length; i += 1) view[i] = (call += 7) % 256;
        return view;
      },
    };
    const deviceId = await generateDeviceId(fake);
    expect(deviceId).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("parseStoredSettings", () => {
  it("accepts a valid stored blob", () => {
    expect(parseStoredSettings(unpaired())?.deviceId).toBe("device-1");
  });

  it("rejects malformed blobs (red side: corrupted storage)", () => {
    expect(parseStoredSettings(null)).toBeNull();
    expect(parseStoredSettings("settings")).toBeNull();
    expect(parseStoredSettings({ deviceId: "" })).toBeNull();
    expect(parseStoredSettings({ deviceId: "d", extVersion: "0.1.0" })).toBeNull();
    expect(parseStoredSettings({ deviceId: "d", extVersion: "0.1.0", gatewayOrigin: "https://bridge.example.com", paired: { token: "" } })).toBeNull();
  });

  it("isSettings agrees with parseStoredSettings", () => {
    expect(isSettings(unpaired())).toBe(true);
    expect(isSettings(null)).toBe(false);
  });
});
