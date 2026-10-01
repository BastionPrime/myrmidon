import { describe, expect, it } from "vitest";
import { checkActionLocally, executeAction, extensionCapabilityList, type ActionContext, type BrowserTabPort, type ContentScriptPort } from "../src/actions";

const CONTEXT: ActionContext = {
  allowlist: ["tender.example"],
  capabilities: ["open", "read", "click", "screenshot"],
};

const TABS: BrowserTabPort = {
  async queryActiveTab() {
    return { tabId: 1, url: "https://tender.example/tenders" };
  },
  async createTab(url) {
    return { tabId: 2, url };
  },
  async updateTabUrl(tabId, url) {
    return { tabId, url };
  },
  async captureVisibleTab() {
    return "data:image/png;base64,AAAB";
  },
};

const CONTENT: ContentScriptPort = {
  async readPage(tabId) {
    return `page text of tab ${tabId}`;
  },
  async clickElement() {
    return true;
  },
};

describe("checkActionLocally", () => {
  it("passes a well-formed open with an allowlisted url", () => {
    const outcome = checkActionLocally("browser.open", { url: "https://tender.example/tenders" }, CONTEXT);
    expect(outcome.ok).toBe(true);
  });

  it("refuses an open outside the allowlist (red side: other domain)", () => {
    const outcome = checkActionLocally("browser.open", { url: "https://other.example/login" }, CONTEXT);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe(-32013);
  });

  it("refuses an open with a non-http url", () => {
    const outcome = checkActionLocally("browser.open", { url: "file:///etc/passwd" }, CONTEXT);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe(-32013);
  });

  it("refuses an open without a url", () => {
    const outcome = checkActionLocally("browser.open", {}, CONTEXT);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe(-32602);
  });

  it("refuses fill and download: not implemented in this build (part D)", () => {
    const fill = checkActionLocally("browser.fill", { target: "#user", value: "bot" }, CONTEXT);
    expect(fill.ok).toBe(false);
    if (fill.ok) return;
    expect(fill.code).toBe(-32012);

    const download = checkActionLocally("browser.download", { url: "https://tender.example/doc.pdf" }, CONTEXT);
    expect(download.ok).toBe(false);
    if (download.ok) return;
    expect(download.code).toBe(-32012);
  });

  it("refuses a click without a target", () => {
    const outcome = checkActionLocally("browser.click", {}, CONTEXT);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe(-32602);
  });

  it("refuses every action when the capability set does not contain it", () => {
    const context: ActionContext = { allowlist: ["tender.example"], capabilities: ["read"] };
    for (const method of ["browser.open", "browser.click", "browser.screenshot"] as const) {
      const outcome = checkActionLocally(method, method === "browser.click" ? { target: "#x" } : {}, context);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.code).toBe(-32012);
    }
  });

  it("refuses confirmable actions: signing steps are part D, never automated here", () => {
    const outcome = checkActionLocally("browser.open", { url: "https://tender.example/tenders", confirmation: "human" }, CONTEXT);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe(-32602);
  });
});

describe("executeAction", () => {
  it("open reuses the allowlisted active tab", async () => {
    const outcome = await executeAction("browser.open", { url: "https://tender.example/tenders" }, CONTEXT, {
      tabs: TABS,
      content: CONTENT,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result).toEqual({ tabId: 1, url: "https://tender.example/tenders" });
  });

  it("read returns the page text of the allowlisted tab", async () => {
    const outcome = await executeAction("browser.read", {}, CONTEXT, { tabs: TABS, content: CONTENT });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result).toMatchObject({ tabId: 1, text: "page text of tab 1" });
  });

  it("read refuses when the active tab is outside the allowlist (red side)", async () => {
    const tabs: BrowserTabPort = {
      ...TABS,
      async queryActiveTab() {
        return { tabId: 5, url: "https://bank.example/account" };
      },
    };
    const outcome = await executeAction("browser.read", {}, CONTEXT, { tabs, content: CONTENT });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe(-32013);
    expect(CONTENT.readPage).toBeDefined();
  });

  it("click dispatches to the content script on the allowlisted tab", async () => {
    const outcome = await executeAction("browser.click", { target: "#next-page" }, CONTEXT, { tabs: TABS, content: CONTENT });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result).toMatchObject({ clicked: true });
  });

  it("click fails when the selector matches nothing", async () => {
    const content: ContentScriptPort = {
      ...CONTENT,
      async clickElement() {
        return false;
      },
    };
    const outcome = await executeAction("browser.click", { target: "#missing" }, CONTEXT, { tabs: TABS, content });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe(-32602);
  });

  it("screenshot returns the captureVisibleTab data url", async () => {
    const outcome = await executeAction("browser.screenshot", {}, CONTEXT, { tabs: TABS, content: CONTENT });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result).toEqual({ screenshot: "data:image/png;base64,AAAB" });
  });

  it("reports a browser port failure as an internal error", async () => {
    const tabs: BrowserTabPort = {
      ...TABS,
      async queryActiveTab() {
        throw new Error("no active tab");
      },
    };
    const outcome = await executeAction("browser.read", {}, CONTEXT, { tabs, content: CONTENT });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe(-32603);
  });

  it("open with a non-allowlisted active tab opens a new tab for the target", async () => {
    const created: string[] = [];
    const tabs: BrowserTabPort = {
      ...TABS,
      async queryActiveTab() {
        return { tabId: 9, url: "https://news.example/headlines" };
      },
      async createTab(url) {
        created.push(url);
        return { tabId: 10, url };
      },
    };
    const outcome = await executeAction("browser.open", { url: "https://tender.example/tenders" }, CONTEXT, { tabs, content: CONTENT });
    expect(outcome.ok).toBe(true);
    expect(created).toEqual(["https://tender.example/tenders"]);
  });
});

describe("extensionCapabilityList", () => {
  it("declares exactly the read-only capabilities of part C", () => {
    expect([...extensionCapabilityList()].sort()).toEqual(["click", "open", "read", "screenshot"]);
  });
});
