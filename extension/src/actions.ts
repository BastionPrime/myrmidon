// The browser actions of the bridge (parts C and D).
//
// The gateway calls one of the methods this build implements; the dispatcher
// validates the params, enforces the local allowlist copy, and executes through
// the extension's ports (`chrome.tabs`, the content script, `fetch`). Part C
// shipped the read-only set (open/read/click/screenshot); part D adds the two
// hands (`fill`, `download`) and the confirmation primitive: an action marked
// `confirmation: "human"` is not executed until a person on this PC confirms,
// and the gateway's cancellation (`browser.cancel`, after the 180 s budget
// expires) drops the pending step instead of letting it fire late.
//
// Nothing here knows a site. The fill target, the download url and the
// confirmation prompt are data; the tender-site selectors and the recorded
// scenarios are built on top of these primitives, not inside them.
//
// Results carry only what the bot needs: text, ids and the downloaded bytes in
// base64 — never secrets.

import { BROWSER_DOWNLOAD_MAX_BYTES, BROWSER_BRIDGE_ERROR_CODES, EXTENSION_CAPABILITIES, type BrowserBridgeMethod } from "./protocol";
import { isUrlAllowedByAllowlist } from "./allowlist";

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
  /** Type a value into the first element matching the target selector. */
  fillElement(tabId: number, target: string, value: string): Promise<boolean>;
  /**
   * Fetch a file from the page's own session (the content script runs in the
   * page's origin, so the request carries the cookies the person's browser
   * already has) and hand back its bytes as base64.
   */
  downloadFile(tabId: number, url: string): Promise<DownloadedFile>;
}

/** One file the page fetched, as the action hands it to the bot. */
export interface DownloadedFile {
  /** File name: from Content-Disposition when present, else the url path. */
  name: string;
  /** MIME type the server sent, or application/octet-stream. */
  mimeType: string;
  /** Size in bytes, so the caller can enforce the bridge ceiling. */
  byteLength: number;
  /** File bytes, base64-encoded. */
  base64: string;
}

/**
 * The browser profile fetched more than the bridge carries. The port raises it
 * (it can stop the transfer on Content-Length before buffering the body); the
 * dispatcher turns it into the `downloadTooLarge` refusal.
 */
export class DownloadTooLargeError extends Error {
  constructor(readonly byteLength: number) {
    super(`download of ${byteLength} bytes exceeds the bridge ceiling`);
    this.name = "DownloadTooLargeError";
  }
}

/** What a person is shown before a confirmable step runs. */
export interface ConfirmationPrompt {
  method: BrowserBridgeMethod;
  /** One human-readable line: which action, on what. */
  summary: string;
  /** The gateway's request id, so a cancellation can be matched to this prompt. */
  requestId?: string | number;
}

export type ConfirmationDecision = "confirmed" | "refused";

export interface ConfirmationPort {
  /** Ask the person and wait for the answer. */
  request(prompt: ConfirmationPrompt): Promise<ConfirmationDecision>;
  /** The gateway gave up: close the prompt; the answer no longer matters. */
  cancel(requestId: string | number): void;
}

export interface ActionContext {
  allowlist: readonly string[];
  capabilities: readonly string[];
}

export interface ActionPorts {
  tabs: BrowserTabPort;
  content: ContentScriptPort;
  confirm?: ConfirmationPort;
}

/** Identity of the gateway request that is being executed. */
export interface ActionRun {
  requestId?: string | number;
}

export interface ActionParams {
  url?: string;
  target?: string;
  value?: string;
  /** "human" marks a step a person on this PC must confirm (part D). */
  confirmation?: "none" | "human";
}

export type ActionOutcome =
  | { ok: true; result: unknown }
  | { ok: false; code: number; message: string; data?: Record<string, unknown> };

/** Which capabilities this build implements. */
export function extensionCapabilityList(): readonly string[] {
  return [...EXTENSION_CAPABILITIES];
}

const METHOD_CAPABILITY: Record<BrowserBridgeMethod, string> = {
  "browser.open": "open",
  "browser.read": "read",
  "browser.click": "click",
  "browser.fill": "fill",
  "browser.download": "download",
  "browser.screenshot": "screenshot",
};

/**
 * The local gates every action passes before any browser API is touched:
 * known method, implemented capability, valid params, allowlisted url.
 */
export function checkActionLocally(method: BrowserBridgeMethod, params: ActionParams, context: ActionContext): ActionOutcome {
  const capability = METHOD_CAPABILITY[method];
  if (!context.capabilities.includes(capability)) {
    return { ok: false, code: BROWSER_BRIDGE_ERROR_CODES.capabilityUnsupported, message: `capability "${capability}" is not implemented by this extension build` };
  }
  if (method === "browser.open" || method === "browser.download") {
    if (typeof params.url !== "string" || params.url === "") {
      return { ok: false, code: BROWSER_BRIDGE_ERROR_CODES.invalidParams, message: `${method} requires "url"` };
    }
    if (!isUrlAllowedByAllowlist(params.url, context.allowlist)) {
      return { ok: false, code: BROWSER_BRIDGE_ERROR_CODES.domainNotAllowed, message: "the url is outside the bridge allowlist" };
    }
  }
  if (method === "browser.click" || method === "browser.fill") {
    if (typeof params.target !== "string" || params.target === "") {
      return { ok: false, code: BROWSER_BRIDGE_ERROR_CODES.invalidParams, message: `${method} requires "target"` };
    }
  }
  if (method === "browser.fill") {
    if (typeof params.value !== "string") {
      return { ok: false, code: BROWSER_BRIDGE_ERROR_CODES.invalidParams, message: "browser.fill requires \"value\"" };
    }
  }
  return { ok: true, result: undefined };
}

/** One line a person can read: what is about to happen on their PC. */
export function describeAction(method: BrowserBridgeMethod, params: ActionParams): string {
  const where = params.target ?? params.url ?? "the active page";
  return `${method} → ${where}`;
}

/**
 * Execute an action that passed the local gates. A confirmable step asks the
 * person first: a refusal, or a build with no confirmation port at all, is a
 * refusal — never a silent execution.
 */
export async function executeAction(
  method: BrowserBridgeMethod,
  params: ActionParams,
  context: ActionContext,
  ports: ActionPorts,
  run: ActionRun = {},
): Promise<ActionOutcome> {
  const local = checkActionLocally(method, params, context);
  if (!local.ok) return local;

  if (params.confirmation === "human") {
    const gate = await askPerson(method, params, ports, run);
    if (gate !== "confirmed") return gate;
  }

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
          return { ok: false, code: BROWSER_BRIDGE_ERROR_CODES.domainNotAllowed, message: "the active tab is outside the bridge allowlist" };
        }
        const text = await ports.content.readPage(tab.tabId);
        return { ok: true, result: { tabId: tab.tabId, url: tab.url, text } };
      }
      case "browser.click": {
        const tab = await ports.tabs.queryActiveTab();
        if (!isUrlAllowedByAllowlist(tab.url, context.allowlist)) {
          return { ok: false, code: BROWSER_BRIDGE_ERROR_CODES.domainNotAllowed, message: "the active tab is outside the bridge allowlist" };
        }
        const clicked = await ports.content.clickElement(tab.tabId, params.target ?? "");
        if (!clicked) {
          return { ok: false, code: BROWSER_BRIDGE_ERROR_CODES.invalidParams, message: "the target matched no element" };
        }
        return { ok: true, result: { tabId: tab.tabId, url: tab.url, clicked: true } };
      }
      case "browser.fill": {
        // The field lives on a page, so the active tab must be inside the
        // allowlist exactly as it must be for `click`: filling a form on a
        // page the bridge was not pointed at is the same overreach.
        const tab = await ports.tabs.queryActiveTab();
        if (!isUrlAllowedByAllowlist(tab.url, context.allowlist)) {
          return { ok: false, code: BROWSER_BRIDGE_ERROR_CODES.domainNotAllowed, message: "the active tab is outside the bridge allowlist" };
        }
        const filled = await ports.content.fillElement(tab.tabId, params.target ?? "", params.value ?? "");
        if (!filled) {
          return { ok: false, code: BROWSER_BRIDGE_ERROR_CODES.invalidParams, message: "the target matched no fillable element" };
        }
        return { ok: true, result: { tabId: tab.tabId, url: tab.url, filled: true } };
      }
      case "browser.download": {
        // The file is fetched in the page's own session, so the active tab must
        // be inside the allowlist just as it must be for `click` and `fill`.
        const tab = await ports.tabs.queryActiveTab();
        if (!isUrlAllowedByAllowlist(tab.url, context.allowlist)) {
          return { ok: false, code: BROWSER_BRIDGE_ERROR_CODES.domainNotAllowed, message: "the active tab is outside the bridge allowlist" };
        }
        const file = await ports.content.downloadFile(tab.tabId, params.url ?? "");
        if (file.byteLength > BROWSER_DOWNLOAD_MAX_BYTES) {
          return {
            ok: false,
            code: BROWSER_BRIDGE_ERROR_CODES.downloadTooLarge,
            message: `the download exceeds ${BROWSER_DOWNLOAD_MAX_BYTES} bytes`,
            data: { bytes: file.byteLength, limit: BROWSER_DOWNLOAD_MAX_BYTES },
          };
        }
        return {
          ok: true,
          result: {
            url: params.url ?? "",
            name: file.name,
            mimeType: file.mimeType,
            bytes: file.byteLength,
            base64: file.base64,
          },
        };
      }
      case "browser.screenshot": {
        const png = await ports.tabs.captureVisibleTab();
        return { ok: true, result: { screenshot: png } };
      }
    }
  } catch (err) {
    if (err instanceof DownloadTooLargeError) {
      return {
        ok: false,
        code: BROWSER_BRIDGE_ERROR_CODES.downloadTooLarge,
        message: `the download exceeds ${BROWSER_DOWNLOAD_MAX_BYTES} bytes`,
        data: { bytes: err.byteLength, limit: BROWSER_DOWNLOAD_MAX_BYTES },
      };
    }
    return { ok: false, code: BROWSER_BRIDGE_ERROR_CODES.internalError, message: `action failed: ${String((err as Error)?.message ?? err)}` };
  }
}

/**
 * The confirmation primitive. The person's answer comes from the port the build
 * injects (the Chrome prompt in the real extension, a fake in the tests). A
 * build without a confirmation port refuses: the point of the step is that a
 * person saw it.
 */
async function askPerson(
  method: BrowserBridgeMethod,
  params: ActionParams,
  ports: ActionPorts,
  run: ActionRun,
): Promise<"confirmed" | ActionOutcome> {
  if (!ports.confirm) {
    return { ok: false, code: BROWSER_BRIDGE_ERROR_CODES.internalError, message: "this build has no confirmation port" };
  }
  const decision = await ports.confirm.request({
    method,
    summary: describeAction(method, params),
    ...(run.requestId === undefined ? {} : { requestId: run.requestId }),
  });
  if (decision !== "confirmed") {
    return { ok: false, code: BROWSER_BRIDGE_ERROR_CODES.confirmationNotGranted, message: "the person did not confirm the action" };
  }
  return "confirmed";
}