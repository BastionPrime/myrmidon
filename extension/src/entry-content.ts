// Entry: the content script (isolated world).
//
// The tender-platform page cannot command the extension. This script exposes
// exactly the operations the extension's own service worker asks for — read the
// visible text, click a selector, type into a field, fetch a file in the page's
// session — and nothing else. It listens only for messages from the extension
// runtime (chrome.runtime.onMessage, which pages cannot fire), never for
// window.postMessage or DOM events that a page controls. The page's variables
// and functions are invisible here.

import { fetchFile } from "./download";

const MAX_TEXT_LENGTH = 500_000;

function readVisibleText(): string {
  const selection = window.getSelection?.()?.toString() ?? "";
  if (selection.trim().length > 0) return selection.slice(0, MAX_TEXT_LENGTH);
  // innerText respects visibility, textContent does not; jsdom ships only
  // textContent, so read whichever the runtime provides.
  const body = document.body as (HTMLElement & { innerText?: string }) | null;
  const text = typeof body?.innerText === "string" ? body.innerText : (body?.textContent ?? "");
  return text.slice(0, MAX_TEXT_LENGTH);
}

function clickSelector(target: string): boolean {
  if (target.length === 0) return false;
  let element: Element | null = null;
  try {
    element = document.querySelector(target);
  } catch {
    return false;
  }
  if (!element) return false;
  const mouseOptions: MouseEventInit = { bubbles: true, cancelable: true };
  element.dispatchEvent(new MouseEvent("mouseover", mouseOptions));
  element.dispatchEvent(new MouseEvent("mousedown", mouseOptions));
  element.dispatchEvent(new MouseEvent("mouseup", mouseOptions));
  element.dispatchEvent(new MouseEvent("click", mouseOptions));
  return true;
}

/**
 * Type a value into the first element matching the selector (part D).
 *
 * Only writable controls are touched: an `input`, a `textarea`, a `select` or
 * a contenteditable node. The value is set the way a person's typing sets it —
 * with `input` and `change` events dispatched afterwards, because a page that
 * listens for them (every form framework does) would otherwise see an
 * unchanged field. Any other element answers false rather than being mutated.
 */
function fillSelector(target: string, value: string): boolean {
  if (target.length === 0) return false;
  let element: Element | null = null;
  try {
    element = document.querySelector(target);
  } catch {
    return false;
  }
  if (!element) return false;
  const tag = element.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") {
    (element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }
  const editable =
    (element as HTMLElement).isContentEditable ||
    (element as HTMLElement).getAttribute("contenteditable") === "true";
  if (editable) {
    (element as HTMLElement).textContent = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }
  return false;
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (typeof message !== "object" || message === null) {
    // Always answer, even to junk: the caller must never hang on our silence.
    sendResponse({ ignored: true });
    return;
  }
  const type = (message as { type?: unknown }).type;
  if (type === "bridge-page-read") {
    sendResponse({ text: readVisibleText() });
    return;
  }
  if (type === "bridge-page-click") {
    const target = (message as { target?: unknown }).target;
    sendResponse({ clicked: typeof target === "string" ? clickSelector(target) : false });
    return;
  }
  if (type === "bridge-page-fill") {
    const target = (message as { target?: unknown }).target;
    const value = (message as { value?: unknown }).value;
    const filled =
      typeof target === "string" && typeof value === "string" ? fillSelector(target, value) : false;
    sendResponse({ filled });
    return;
  }
  if (type === "bridge-page-download") {
    const url = (message as { url?: unknown }).url;
    if (typeof url !== "string" || url.length === 0) {
      sendResponse({ ok: false, message: "url is required" });
      return;
    }
    // The fetch is asynchronous, so the answer is sent later and the message
    // channel is kept open for it.
    void fetchFile(url).then(sendResponse);
    return true;
  }
  sendResponse({ ignored: true });
});

export { clickSelector, fillSelector, readVisibleText };
