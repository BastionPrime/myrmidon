import { beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";

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

  it("types a value into a field and reports it", async () => {
    document.body.innerHTML = `<form><input id="login" /></form>`;
    const response = await pageSend({ type: "bridge-page-fill", target: "#login", value: "bot" });
    expect(response.filled).toBe(true);
    expect((document.getElementById("login") as HTMLInputElement).value).toBe("bot");
  });

  it("dispatches input and change events when filling", async () => {
    document.body.innerHTML = `<form><input id="login" /></form>`;
    const input = document.getElementById("login") as HTMLInputElement;
    const events: string[] = [];
    input.addEventListener("input", () => events.push("input"));
    input.addEventListener("change", () => events.push("change"));
    await pageSend({ type: "bridge-page-fill", target: "#login", value: "bot" });
    expect(events).toEqual(["input", "change"]);
  });

  it("fills a contenteditable node", async () => {
    document.body.innerHTML = `<div id="editor" contenteditable="true"></div>`;
    const response = await pageSend({ type: "bridge-page-fill", target: "#editor", value: "text" });
    expect(response.filled).toBe(true);
    expect(document.getElementById("editor")?.textContent).toBe("text");
  });

  it("reports false when the fill target matches nothing", async () => {
    const response = await pageSend({ type: "bridge-page-fill", target: "#missing", value: "x" });
    expect(response.filled).toBe(false);
  });

  it("refuses to fill a non-writable element", async () => {
    const response = await pageSend({ type: "bridge-page-fill", target: "#notice", value: "x" });
    expect(response.filled).toBe(false);
  });

  it("fails a fill without a value", async () => {
    const response = await pageSend({ type: "bridge-page-fill", target: "#notice" });
    expect(response.filled).toBe(false);
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

describe("entry-content: download in the page session (part D)", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function stubFetch(body: Uint8Array, headers: Record<string, string>): void {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    })) as unknown as typeof fetch;
  }

  it("fetches the file and answers its bytes as base64", async () => {
    stubFetch(new Uint8Array([1, 2, 3, 4]), {
      "content-type": "application/pdf",
      "content-disposition": 'attachment; filename="doc.pdf"',
    });
    const response = await pageSend({ type: "bridge-page-download", url: "https://tender.example/doc.pdf" });
    expect(response.ok).toBe(true);
    expect(response.file).toEqual({
      name: "doc.pdf",
      mimeType: "application/pdf",
      byteLength: 4,
      base64: "AQIDBA==",
    });
  });

  it("takes the file name from the url when there is no Content-Disposition", async () => {
    stubFetch(new Uint8Array([9]), { "content-type": "application/octet-stream" });
    const response = await pageSend({ type: "bridge-page-download", url: "https://tender.example/files/a.pdf" });
    expect((response.file as { name: string }).name).toBe("a.pdf");
  });

  it("refuses a file above the bridge ceiling before reading the body (red side)", async () => {
    stubFetch(new Uint8Array([1]), { "content-length": String(25 * 1024 * 1024 + 1) });
    const response = await pageSend({ type: "bridge-page-download", url: "https://tender.example/huge.bin" });
    expect(response.ok).toBe(false);
    expect(response.tooLarge).toBe(25 * 1024 * 1024 + 1);
  });

  it("answers a fetch failure as data, never as a file", async () => {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 404,
      headers: { get: () => null },
      arrayBuffer: async () => new ArrayBuffer(0),
    })) as unknown as typeof fetch;
    const response = await pageSend({ type: "bridge-page-download", url: "https://tender.example/gone.pdf" });
    expect(response.ok).toBe(false);
    expect(String(response.message)).toContain("404");
  });

  it("requires a url", async () => {
    const response = await pageSend({ type: "bridge-page-download" });
    expect(response.ok).toBe(false);
  });
});
