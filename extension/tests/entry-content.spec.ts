import { beforeAll, beforeEach, describe, expect, it } from "vitest";

// The isolated-world content script entry, exercised against a jsdom page.
// The page itself can only run what a browser page can run: it cannot fire
// chrome.runtime.onMessage, which is the only door the script listens at.

type Listener = (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean | void;

const listeners: Listener[] = [];

function installChromeRuntime() {
  (globalThis as Record<string, unknown>).chrome = {
    runtime: {
      onMessage: {
        addListener(listener: Listener) {
          listeners.push(listener);
        },
      },
    },
  };
}

// The entry registers its listener once on import; the module cache keeps it.
// pageSend always talks to the registered listener.
beforeAll(async () => {
  installChromeRuntime();
  await import("../src/entry-content");
});

function pageSend(message: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const listener = listeners[listeners.length - 1];
    if (typeof listener !== "function") throw new Error("no content-script listener registered");
    const kept = listener(message, {}, (response) => resolve((response ?? {}) as Record<string, unknown>));
    void kept;
  });
}

describe("entry-content (isolated world)", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <main>
        <h1>Tenders of the day</h1>
        <p id="notice">Five lots close today.</p>
        <button id="next-page" type="button">Next page</button>
      </main>
    `;
  });

  it("reads the visible text of the page", async () => {
    const response = await pageSend({ type: "bridge-page-read" });
    expect(typeof response.text).toBe("string");
    expect(String(response.text)).toContain("Tenders of the day");
    expect(String(response.text)).toContain("Five lots close today.");
  });

  it("clicks a selector that matches", async () => {
    let clicked = 0;
    document.getElementById("next-page")?.addEventListener("click", () => {
      clicked += 1;
    });
    const response = await pageSend({ type: "bridge-page-click", target: "#next-page" });
    expect(response.clicked).toBe(true);
    expect(clicked).toBe(1);
  });

  it("reports false for a selector that matches nothing", async () => {
    const response = await pageSend({ type: "bridge-page-click", target: "#does-not-exist" });
    expect(response.clicked).toBe(false);
  });

  it("reports false for an invalid selector", async () => {
    const response = await pageSend({ type: "bridge-page-click", target: "###[" });
    expect(response.clicked).toBe(false);
  });

  it("answers unknown message types with ignored (never executes them)", async () => {
    const response = await pageSend({ type: "some-other-message", target: "#next-page" });
    expect(response).toEqual({ ignored: true });
  });

  it("answers messages without a type with ignored", async () => {
    const response = await pageSend({ no: "type" });
    expect(response).toEqual({ ignored: true });
  });

  it("answers non-object messages with ignored", async () => {
    const response = await pageSend("junk");
    expect(response).toEqual({ ignored: true });
  });
});

describe("entry-content with an empty page body", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("reads an empty page without crashing", async () => {
    const response = await pageSend({ type: "bridge-page-read" });
    expect(typeof response.text).toBe("string");
  });
});
