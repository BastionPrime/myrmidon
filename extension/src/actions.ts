// The read-only browser actions of the bridge (part C scope).
//
// The gateway calls one of the four methods this build implements; the
// dispatcher validates the params, enforces the local allowlist copy, and
// executes through the extension's browser port (chrome.tabs and the content
// script). Fill and download are part D: they exist in the protocol but this
// build refuses them (capability check runs in the gateway AND here, deny by
// default).
//
// Results carry only what the bot needs: text and ids, never secrets.
// Screenshots come back as data urls from tabs.captureVisibleTab.

import { isUrlAllowedByAllowlist } from "./allowlist";
import { EXTENSION_CAPABILITIES, type BrowserBridgeMethod } from "./protocol";

export interface TabHandle {
  tabId: number;
  url: string;
}

export interface BrowserTabPort {
  /** Find the tab to act on, or create one. */
  queryActiveTab(): Promise<TabHandle>;
  createTab(url: string): Promise<TabHandle>;
  updateTabUrl(tabId: number, url: string): Promise<TabHandle>;
  /** Capture the visible tab as a PNG data url (tabs.captureVisibleTab). */
  captureVisibleTab(): Promise<string>;
}

export interface ContentScriptPort {
  /** Read the visible text of the page in the given tab. */
  readPage(tabId: number): Promise<string>;
  /** Click the first element matching the target selector. */
  clickElement(tabId: number, target: string): Promise<boolean>;
}

export interface ActionContext {
  allowlist: readonly string[];
  capabilities: readonly string[];
}

export interface ActionParams {
  url?: string;
  target?: string;
  value?: string;
  /** "human" marks a confirmable (signing) step; part C refuses them. */
  confirmation?: "none" | "human";
}

export type ActionOutcome =
  | { ok: true; result: unknown }
  | { ok: false; code: number; message: string; data?: Record<string, unknown> };

/** Which capabilities this build implements. */
export function extensionCapabilityList(): readonly string[] {
  return [...EXTENSION_CAPABILITIES];
}

/**
 * The local gates every action passes before any browser API is touched:
 * known method, implemented capability, valid params, allowlisted url.
 */
export function checkActionLocally(method: BrowserBridgeMethod, params: ActionParams, context: ActionContext): ActionOutcome {
  const capabilityOfMethod: Record<BrowserBridgeMethod, string> = {
    "browser.open": "open",
    "browser.read": "read",
    "browser.click": "click",
    "browser.fill": "fill",
    "browser.download": "download",
    "browser.screenshot": "screenshot",
  };
  const capability = capabilityOfMethod[method];
  if (!context.capabilities.includes(capability)) {
    return { ok: false, code: -32012, message: `capability "${capability}" is not implemented by this extension build` };
  }
  if (method === "browser.open" || method === "browser.download") {
    if (typeof params.url !== "string" || params.url === "") {
      return { ok: false, code: -32602, message: `${method} requires "url"` };
    }
    if (!isUrlAllowedByAllowlist(params.url, context.allowlist)) {
      return { ok: false, code: -32013, message: "the url is outside the bridge allowlist" };
    }
  }
  if (method === "browser.click" || method === "browser.fill") {
    if (typeof params.target !== "string" || params.target === "") {
      return { ok: false, code: -32602, message: `${method} requires "target"` };
    }
  }
  if (method === "browser.fill") {
    if (typeof params.value !== "string" || params.value === "") {
      return { ok: false, code: -32602, message: `${method} requires "value"` };
    }
  }
  if (params.confirmation !== undefined) {
    return { ok: false, code: -32602, message: "confirmable actions are not implemented by this extension build" };
  }
  return { ok: true, result: undefined };
}

/**
 * Execute an action that passed the local gates. Read-only methods only;
 * fill/download refuse even if a future gateway grants the capability.
 */
export async function executeAction(
  method: BrowserBridgeMethod,
  params: ActionParams,
  context: ActionContext,
  ports: { tabs: BrowserTabPort; content: ContentScriptPort },
): Promise<ActionOutcome> {
  const local = checkActionLocally(method, params, context);
  if (!local.ok) return local;

  try {
    switch (method) {
      case "browser.open": {
        const requested = params.url ?? "";
        const tab = await ports.tabs.queryActiveTab();
        const activeIsBlank = tab.url === "about:blank" || tab.url === "";
        const activeIsAllowlisted = isUrlAllowedByAllowlist(tab.url, context.allowlist);
        // Reuse the active tab when it is blank or already inside the
        // allowlist; otherwise open a new tab rather than navigating a page
        // the bridge has no business replacing.
        const next = activeIsBlank || activeIsAllowlisted
          ? await ports.tabs.updateTabUrl(tab.tabId, requested)
          : await ports.tabs.createTab(requested);
        return { ok: true, result: { tabId: next.tabId, url: next.url } };
      }
      case "browser.read": {
        const tab = await ports.tabs.queryActiveTab();
        if (!isUrlAllowedByAllowlist(tab.url, context.allowlist)) {
          return { ok: false, code: -32013, message: "the active tab is outside the bridge allowlist" };
        }
        const text = await ports.content.readPage(tab.tabId);
        return { ok: true, result: { tabId: tab.tabId, url: tab.url, text } };
      }
      case "browser.click": {
        const tab = await ports.tabs.queryActiveTab();
        if (!isUrlAllowedByAllowlist(tab.url, context.allowlist)) {
          return { ok: false, code: -32013, message: "the active tab is outside the bridge allowlist" };
        }
        const clicked = await ports.content.clickElement(tab.tabId, params.target ?? "");
        if (!clicked) {
          return { ok: false, code: -32602, message: "the target matched no element" };
        }
        return { ok: true, result: { tabId: tab.tabId, url: tab.url, clicked: true } };
      }
      case "browser.screenshot": {
        const png = await ports.tabs.captureVisibleTab();
        return { ok: true, result: { screenshot: png } };
      }
      case "browser.fill":
      case "browser.download":
        return { ok: false, code: -32012, message: `${method} is not implemented by this extension build` };
    }
  } catch (err) {
    return { ok: false, code: -32603, message: `action failed: ${String((err as Error)?.message ?? err)}` };
  }
}
