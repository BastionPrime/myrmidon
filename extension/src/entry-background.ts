// Entry: the MV3 background service worker of the extension.
//
// Responsibilities (and nothing else):
//  - keep the settings current (device id on first run),
//  - own the outbound BridgeConnection to the gateway,
//  - dispatch gateway browser.* requests to the read-only actions,
//  - answer the popup's runtime messages (state, pairing, connect, disconnect),
//  - forward page-read/click calls to the content script's runtime port.
//
// Security shape (design note §4.6): the service worker trusts only the
// gateway (origin from settings, token from chrome.storage.local). The
// tender-platform page cannot command the extension: the content script runs
// in an isolated world and exposes exactly two read-only operations to the
// service worker, and neither lets a page initiate anything.

import { executeAction, extensionCapabilityList, type ActionParams, type BrowserTabPort, type ContentScriptPort } from "./actions";
import { BridgeConnection, NodeTimerPort, type WebSocketFactory, type WebSocketLike } from "./gateway-client";
import { BROWSER_BRIDGE_WS_PATH, BRIDGE_ACTION_TIMEOUT_MS, EXTENSION_CAPABILITIES } from "./protocol";
import { FetchPairingGateway } from "./pairing";
import {
  ChromeStorageSettingsStore,
  applyAllowlistUpdate,
  applyPairing,
  generateDeviceId,
  newUnpairedSettings,
  parseStoredSettings,
  type StoredSettings,
} from "./state";

const EXTENSION_VERSION = chrome.runtime.getManifest().version;

/** The chrome WebSocket, behind the factory the client takes. */
class ChromeWebSocketFactory implements WebSocketFactory {
  create(url: string): WebSocketLike {
    const socket = new WebSocket(url);
    return {
      send: (text) => socket.send(text),
      close: (code, reason) => socket.close(code, reason),
      readyState: socket.readyState,
      addEventListener: (type, listener) => socket.addEventListener(type, listener as EventListener),
      removeEventListener: (type, listener) => socket.removeEventListener(type, listener as EventListener),
    };
  }
}

/** tabs.* behind the port the actions take. */
class ChromeTabsPort implements BrowserTabPort {
  async queryActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || typeof tab.id !== "number") throw new Error("no active tab");
    return { tabId: tab.id, url: tab.url ?? "about:blank" };
  }

  async createTab(url: string) {
    const tab = await chrome.tabs.create({ url, active: true });
    if (!tab || typeof tab.id !== "number") throw new Error("tab creation failed");
    return { tabId: tab.id, url: tab.url ?? url };
  }

  async updateTabUrl(tabId: number, url: string) {
    const tab = await chrome.tabs.update(tabId, { url });
    if (!tab || typeof tab.id !== "number") throw new Error("tab update failed");
    return { tabId: tab.id, url: tab.url ?? url };
  }

  async captureVisibleTab(): Promise<string> {
    const dataUrl: string = await chrome.tabs.captureVisibleTab(undefined as unknown as number, { format: "png" });
    return dataUrl;
  }
}

/** The content script behind the port the actions take. */
class RuntimeContentScriptPort implements ContentScriptPort {
  async readPage(tabId: number): Promise<string> {
    const response = await chrome.tabs.sendMessage(tabId, { type: "bridge-page-read" });
    if (typeof response !== "object" || response === null) throw new Error("content script did not answer");
    const text = (response as { text?: unknown }).text;
    if (typeof text !== "string") throw new Error("content script answered without text");
    return text;
  }

  async clickElement(tabId: number, target: string): Promise<boolean> {
    const response = await chrome.tabs.sendMessage(tabId, { type: "bridge-page-click", target });
    if (typeof response !== "object" || response === null) throw new Error("content script did not answer");
    return (response as { clicked?: unknown }).clicked === true;
  }
}

interface BridgeStatus {
  phase: "unpaired" | "idle" | "connecting" | "awaiting-ready" | "ready" | "closed";
  lastHandshakeFailure: string | null;
}

const store = new ChromeStorageSettingsStore();
const tabsPort = new ChromeTabsPort();
const contentPort = new RuntimeContentScriptPort();
const sockets = new ChromeWebSocketFactory();
const timers = new NodeTimerPort();

let connection: BridgeConnection | null = null;
const status: BridgeStatus = { phase: "unpaired", lastHandshakeFailure: null };

async function loadOrCreateSettings(): Promise<StoredSettings> {
  const bag = await chrome.storage.local.get("myrmidonBridgeSettings");
  const parsed = parseStoredSettings(bag.myrmidonBridgeSettings);
  if (parsed) return parsed;
  const deviceId = await generateDeviceId();
  return newUnpairedSettings(deviceId, "", EXTENSION_VERSION);
}

let liveAllowlist: string[] = [];

function currentAllowlist(): string[] {
  return connection ? liveAllowlist : [];
}

async function dispatchAction(method: string, params: unknown) {
  const settings = await loadOrCreateSettings();
  const capabilities = settings.paired ? settings.paired.capabilities : [];
  const allowlist = settings.paired ? settings.paired.allowlist : liveAllowlist;
  return executeAction(method as never, params as ActionParams, { capabilities, allowlist }, { tabs: tabsPort, content: contentPort });
}

async function connect(): Promise<{ ok: boolean; failure: string | null }> {
  const settings = await loadOrCreateSettings();
  if (!settings.paired || !settings.gatewayOrigin) return { ok: false, failure: "not paired" };
  if (connection) return { ok: false, failure: "connection already open" };
  status.phase = "connecting";
  status.lastHandshakeFailure = null;
  connection = new BridgeConnection({
    origin: settings.gatewayOrigin,
    deviceId: settings.deviceId,
    extVersion: EXTENSION_VERSION,
    token: settings.paired.token,
    capabilities: [...EXTENSION_CAPABILITIES],
    allowlist: settings.paired.allowlist,
    wsPath: BROWSER_BRIDGE_WS_PATH,
    sockets,
    dispatchAction,
    onPhaseChange: (phase) => {
      if (phase === "closed") {
        connection = null;
        status.phase = "closed";
      } else {
        status.phase = phase;
      }
    },
    onAllowlistUpdate: (domains) => {
      liveAllowlist = domains;
      void loadOrCreateSettings().then((current) => {
        if (current) void store.save(applyAllowlistUpdate(current, { domains }));
      });
    },
    readyTimeoutMs: BRIDGE_ACTION_TIMEOUT_MS,
    timers,
  });
  try {
    await connection.connect();
    return { ok: true, failure: null };
  } catch (failure) {
    connection = null;
    status.phase = "closed";
    status.lastHandshakeFailure = JSON.stringify(failure);
    return { ok: false, failure: JSON.stringify(failure) };
  }
}

function disconnect(): void {
  connection?.close();
  connection = null;
  status.phase = "idle";
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  void (async () => {
    if (typeof message !== "object" || message === null) return;
    const type = (message as { type?: unknown }).type;
    if (type === "bridge-get-status") {
      const settings = await loadOrCreateSettings();
      sendResponse({
        phase: connection ? status.phase : settings.paired ? "idle" : "unpaired",
        paired: settings.paired !== null,
        deviceId: settings.deviceId,
        extVersion: EXTENSION_VERSION,
        capabilities: settings.paired ? settings.paired.capabilities : [...EXTENSION_CAPABILITIES],
        allowlist: currentAllowlist(),
        lastHandshakeFailure: status.lastHandshakeFailure,
      });
      return;
    }
    if (type === "bridge-pair") {
      const { code, origin } = message as { code?: unknown; origin?: unknown };
      if (typeof code !== "string" || typeof origin !== "string") {
        sendResponse({ ok: false, error: "code and origin are required" });
        return;
      }
      const { normalizePairingCodeInput, parseGatewayOriginInput } = await import("./pairing");
      const canonical = normalizePairingCodeInput(code);
      const parsedOrigin = parseGatewayOriginInput(origin);
      if (!canonical || !parsedOrigin) {
        sendResponse({ ok: false, error: "invalid pairing code or gateway origin" });
        return;
      }
      const settings = await loadOrCreateSettings();
      const gateway = new FetchPairingGateway();
      try {
        const paired = await gateway.exchangePairing({
          origin: parsedOrigin,
          body: {
            code: canonical,
            deviceId: settings.deviceId,
            extVersion: EXTENSION_VERSION,
            capabilities: [...EXTENSION_CAPABILITIES],
          },
        });
        liveAllowlist = paired.allowlist;
        await store.save(applyPairing({ ...settings, gatewayOrigin: parsedOrigin }, paired));
        sendResponse({ ok: true, deviceId: paired.deviceId, allowlist: paired.allowlist });
      } catch (err) {
        sendResponse({ ok: false, error: String((err as Error)?.message ?? err) });
      }
      return;
    }
    if (type === "bridge-unpair") {
      disconnect();
      await store.remove("paired");
      liveAllowlist = [];
      status.phase = "unpaired";
      sendResponse({ ok: true });
      return;
    }
    if (type === "bridge-connect") {
      const result = await connect();
      sendResponse(result);
      return;
    }
    if (type === "bridge-disconnect") {
      disconnect();
      sendResponse({ ok: true });
      return;
    }
  })();
  return true; // async sendResponse
});

export { dispatchAction, extensionCapabilityList };
