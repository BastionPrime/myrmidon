import { describe, expect, it } from "vitest";
import {
  checkActionLocally,
  describeAction,
  executeAction,
  extensionCapabilityList,
  type ActionContext,
  type BrowserTabPort,
  type ConfirmationDecision,
  type ConfirmationPort,
  type ConfirmationPrompt,
  type ContentScriptPort,
  type DownloadedFile,
} from "../src/actions";

const CONTEXT: ActionContext = {
  allowlist: ["tender.example"],
  capabilities: ["open", "read", "click", "fill", "download", "screenshot"],
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
  async fillElement() {
    return true;
  },
  async downloadFile(): Promise<DownloadedFile> {
    return { name: "doc.pdf", mimeType: "application/pdf", byteLength: 4, base64: "AAECAw==" };
  },
};

/** A content port whose fill target never matches. */
const CONTENT_NO_MATCH: ContentScriptPort = {
  ...CONTENT,
  async fillElement() {
    return false;
  },
};

/** A confirmation port that answers at once and records what it was asked. */
function confirming(decision: ConfirmationDecision): { prompts: ConfirmationPrompt[]; port: ConfirmationPort } {
  const prompts: ConfirmationPrompt[] = [];
  return {
    prompts,
    port: {
      async request(prompt) {
        prompts.push(prompt);
        return decision;
      },
      cancel() {
        // not used when the answer is immediate
      },
    },
  };
}

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

  it("passes a well-formed fill with target and value (part D)", () => {
    const outcome = checkActionLocally("browser.fill", { target: "#user", value: "bot" }, CONTEXT);
    expect(outcome.ok).toBe(true);
  });

  it("refuses a fill without a value or without a target", () => {
    const withoutValue = checkActionLocally("browser.fill", { target: "#user" }, CONTEXT);
    expect(withoutValue.ok).toBe(false);
    if (!withoutValue.ok) expect(withoutValue.code).toBe(-32602);

    const withoutTarget = checkActionLocally("browser.fill", { value: "bot" }, CONTEXT);
    expect(withoutTarget.ok).toBe(false);
    if (!withoutTarget.ok) expect(withoutTarget.code).toBe(-32602);
  });

  it("passes a download inside the allowlist and refuses one outside it", () => {
    const allowed = checkActionLocally("browser.download", { url: "https://tender.example/doc.pdf" }, CONTEXT);
    expect(allowed.ok).toBe(true);

    const denied = checkActionLocally("browser.download", { url: "https://evil.test/doc.pdf" }, CONTEXT);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe(-32013);
  });

  it("refuses a click without a target", () => {
    const outcome = checkActionLocally("browser.click", {}, CONTEXT);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe(-32602);
  });

  it("refuses every action when the capability set does not contain it", () => {
    const context: ActionContext = { allowlist: ["tender.example"], capabilities: ["read"] };
    for (const method of ["browser.open", "browser.click", "browser.fill", "browser.download", "browser.screenshot"] as const) {
      const outcome = checkActionLocally(
        method,
        method === "browser.click" || method === "browser.fill"
          ? { target: "#x", value: "v" }
          : { url: "https://tender.example/x" },
        context,
      );
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.code).toBe(-32012);
    }
  });
});

describe("executeAction: read-only set (part C)", () => {
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
});

describe("executeAction: fill (part D)", () => {
  it("types into the field on the allowlisted tab and confirms it", async () => {
    const typed: Array<{ target: string; value: string }> = [];
    const content: ContentScriptPort = {
      ...CONTENT,
      async fillElement(_tabId, target, value) {
        typed.push({ target, value });
        return true;
      },
    };
    const outcome = await executeAction("browser.fill", { target: "#login", value: "bot" }, CONTEXT, { tabs: TABS, content });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result).toMatchObject({ tabId: 1, url: "https://tender.example/tenders", filled: true });
    expect(typed).toEqual([{ target: "#login", value: "bot" }]);
  });

  it("refuses to fill when the active tab is outside the allowlist (red side)", async () => {
    const tabs: BrowserTabPort = {
      ...TABS,
      async queryActiveTab() {
        return { tabId: 7, url: "https://bank.example/account" };
      },
    };
    let touched = false;
    const content: ContentScriptPort = {
      ...CONTENT,
      async fillElement() {
        touched = true;
        return true;
      },
    };
    const outcome = await executeAction("browser.fill", { target: "#login", value: "bot" }, CONTEXT, { tabs, content });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe(-32013);
    expect(touched).toBe(false);
  });

  it("fails when the selector matches no fillable element", async () => {
    const outcome = await executeAction("browser.fill", { target: "#missing", value: "bot" }, CONTEXT, {
      tabs: TABS,
      content: CONTENT_NO_MATCH,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe(-32602);
  });
});

describe("executeAction: download (part D)", () => {
  it("hands the file back as name, type, size and base64", async () => {
    const outcome = await executeAction("browser.download", { url: "https://tender.example/doc.pdf" }, CONTEXT, {
      tabs: TABS,
      content: CONTENT,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result).toEqual({
      url: "https://tender.example/doc.pdf",
      name: "doc.pdf",
      mimeType: "application/pdf",
      bytes: 4,
      base64: "AAECAw==",
    });
  });

  it("refuses to download when the active tab is outside the allowlist (red side)", async () => {
    const tabs: BrowserTabPort = {
      ...TABS,
      async queryActiveTab() {
        return { tabId: 7, url: "https://bank.example/account" };
      },
    };
    let fetched = false;
    const content: ContentScriptPort = {
      ...CONTENT,
      async downloadFile() {
        fetched = true;
        return { name: "", mimeType: "", byteLength: 0, base64: "" };
      },
    };
    const outcome = await executeAction("browser.download", { url: "https://tender.example/doc.pdf" }, CONTEXT, { tabs, content });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe(-32013);
    expect(fetched).toBe(false);
  });

  it("refuses a file above the bridge ceiling with downloadTooLarge", async () => {
    const content: ContentScriptPort = {
      ...CONTENT,
      async downloadFile() {
        return { name: "huge.bin", mimeType: "application/octet-stream", byteLength: 25 * 1024 * 1024 + 1, base64: "" };
      },
    };
    const outcome = await executeAction("browser.download", { url: "https://tender.example/huge.bin" }, CONTEXT, { tabs: TABS, content });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe(-32021);
  });

  it("reports a fetch failure as an internal error, never as a file", async () => {
    const content: ContentScriptPort = {
      ...CONTENT,
      async downloadFile() {
        throw new Error("download answered 404");
      },
    };
    const outcome = await executeAction("browser.download", { url: "https://tender.example/gone.pdf" }, CONTEXT, { tabs: TABS, content });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe(-32603);
  });
});

describe("executeAction: confirmation primitive (part D)", () => {
  it("asks the person, then runs the action when they confirm", async () => {
    const { prompts, port } = confirming("confirmed");
    const outcome = await executeAction(
      "browser.click",
      { target: "#submit", confirmation: "human" },
      CONTEXT,
      { tabs: TABS, content: CONTENT, confirm: port },
      { requestId: "gw-1" },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result).toMatchObject({ clicked: true });
    expect(prompts).toEqual([{ method: "browser.click", summary: "browser.click → #submit", requestId: "gw-1" }]);
  });

  it("does not run the action when the person refuses (red side)", async () => {
    const { port } = confirming("refused");
    let clicked = false;
    const content: ContentScriptPort = {
      ...CONTENT,
      async clickElement() {
        clicked = true;
        return true;
      },
    };
    const outcome = await executeAction(
      "browser.click",
      { target: "#submit", confirmation: "human" },
      CONTEXT,
      { tabs: TABS, content, confirm: port },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe(-32019);
    expect(clicked).toBe(false);
  });

  it("treats a gateway cancellation as a refusal", async () => {
    let settle: ((decision: ConfirmationDecision) => void) | null = null;
    const port: ConfirmationPort = {
      request: () =>
        new Promise<ConfirmationDecision>((resolve) => {
          settle = resolve;
        }),
      cancel: () => settle?.("refused"),
    };
    const promise = executeAction(
      "browser.click",
      { target: "#submit", confirmation: "human" },
      CONTEXT,
      { tabs: TABS, content: CONTENT, confirm: port },
      { requestId: "gw-9" },
    );
    port.cancel("gw-9");
    const outcome = await promise;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe(-32019);
  });

  it("refuses a confirmable step when the build has no confirmation port", async () => {
    const outcome = await executeAction(
      "browser.open",
      { url: "https://tender.example/tenders", confirmation: "human" },
      CONTEXT,
      { tabs: TABS, content: CONTENT },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe(-32603);
  });

  it("never turns the extension into a signer: no sign capability, no sign action", () => {
    expect([...extensionCapabilityList()]).not.toContain("sign");
    expect(describeAction("browser.fill", { target: "#user" })).toBe("browser.fill → #user");
  });
});

describe("extensionCapabilityList", () => {
  it("declares the read-only set plus the part D primitives", () => {
    expect([...extensionCapabilityList()].sort()).toEqual([
      "click",
      "download",
      "fill",
      "open",
      "read",
      "screenshot",
    ]);
  });
});