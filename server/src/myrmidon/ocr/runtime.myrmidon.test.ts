// myrmidon(EXT-CASE-OCR): the instance settings and the runtime over them.

import { describe, expect, it, vi } from "vitest";
import { createOcrRuntime, type OcrRuntimeOptions } from "./index.js";
import {
  DEFAULT_OCR_MAX_BYTES,
  DEFAULT_OCR_MAX_PAGES,
  DEFAULT_OCR_TIMEOUT_SEC,
  ocrSettingsProblem,
  readOcrSettings,
} from "./settings.js";
import type { OcrJournalEntry } from "./service.js";

const PDF_BASE64 = Buffer.from("%PDF-1.7\n<< /Type /Page >>\n%%EOF\n", "latin1").toString("base64");

function ragflowResponse(text: string): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id: "ocr", result: { content: [{ type: "text", text }] } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("readOcrSettings", () => {
  it("is closed by default and opens with an address and a key secret", () => {
    const closed = readOcrSettings({});
    expect(closed).toMatchObject({
      enabled: false,
      backend: "ragflow",
      baseUrl: null,
      keySecret: null,
      maxBytes: DEFAULT_OCR_MAX_BYTES,
      maxPages: DEFAULT_OCR_MAX_PAGES,
      timeoutMs: DEFAULT_OCR_TIMEOUT_SEC * 1000,
    });
    const open = readOcrSettings({
      MYRMIDON_OCR_BASE_URL: "http://ocr.example.com/mcp",
      MYRMIDON_OCR_KEY_SECRET: "ocr-key",
      MYRMIDON_OCR_BACKEND: "litellm",
      MYRMIDON_OCR_MODEL: "ocr-model",
      MYRMIDON_OCR_MAX_BYTES: "1024",
    });
    expect(open).toMatchObject({
      enabled: true,
      backend: "litellm",
      model: "ocr-model",
      maxBytes: 1024,
    });
  });

  it("falls back to the default for a value that is present but unusable", () => {
    const settings = readOcrSettings({
      MYRMIDON_OCR_BASE_URL: "http://ocr.example.com/mcp",
      MYRMIDON_OCR_KEY_SECRET: "ocr-key",
      MYRMIDON_OCR_BACKEND: "something-else",
      MYRMIDON_OCR_MAX_BYTES: "not-a-number",
      MYRMIDON_OCR_MAX_PAGES: "-4",
      MYRMIDON_OCR_TIMEOUT_SEC: "1",
    });
    expect(settings.backend).toBe("ragflow");
    expect(settings.maxBytes).toBe(DEFAULT_OCR_MAX_BYTES);
    expect(settings.maxPages).toBe(DEFAULT_OCR_MAX_PAGES);
    // The timeout has a floor, so a one-second value cannot cut a real parse.
    expect(settings.timeoutMs).toBe(5_000);
  });

  it("names the missing settings in the problem, never a value", () => {
    expect(ocrSettingsProblem(readOcrSettings({ MYRMIDON_OCR_BASE_URL: "http://ocr.example.com/mcp" }))).toContain(
      "MYRMIDON_OCR_KEY_SECRET",
    );
    const problem = ocrSettingsProblem(
      readOcrSettings({ MYRMIDON_OCR_KEY_SECRET: "ocr-key" }),
    );
    expect(problem).toContain("MYRMIDON_OCR_BASE_URL");
    expect(problem).not.toContain("ocr-key");
    expect(
      ocrSettingsProblem(
        readOcrSettings({ MYRMIDON_OCR_BASE_URL: "http://ocr.example.com/mcp", MYRMIDON_OCR_KEY_SECRET: "ocr-key" }),
      ),
    ).toBeNull();
  });
});

describe("createOcrRuntime", () => {
  const env = {
    MYRMIDON_OCR_BASE_URL: "http://ocr.example.com/mcp",
    MYRMIDON_OCR_KEY_SECRET: "ocr-key",
  };

  function runtime(options: Partial<OcrRuntimeOptions> = {}) {
    const journaled: Array<{ companyId: string; entry: OcrJournalEntry }> = [];
    const created = createOcrRuntime({
      env,
      fetch: vi.fn(async () => ragflowResponse("Позиции\nСтол 2 шт\n")) as unknown as typeof fetch,
      readCompanyKey: vi.fn(async () => "key-value"),
      recordJournal: vi.fn(async (companyId, entry) => void journaled.push({ companyId, entry })),
      ...options,
    });
    return { runtime: created, journaled };
  }

  it("recognizes through the company's key and journals under the company", async () => {
    const readCompanyKey = vi.fn(async () => "key-value");
    const { runtime: created, journaled } = runtime({ readCompanyKey });
    const companyId = "22222222-2222-4222-8222-222222222222";

    const result = await created.recognize(companyId, {
      name: "tender.pdf",
      bytes: new Uint8Array(Buffer.from("%PDF-1.7\n<< /Type /Page >>\n%%EOF\n", "latin1")),
      origin: "browser_download",
      sourceId: "https://tender.example.com/list",
    });

    expect(readCompanyKey).toHaveBeenCalledWith(companyId, "ocr-key");
    expect(result.text).toContain("Стол 2 шт");
    expect(result.pages).toBe(1);
    expect(journaled).toHaveLength(1);
    expect(journaled[0]!.companyId).toBe(companyId);
    expect(journaled[0]!.entry.metadata).toMatchObject({ origin: "browser_download", backend: "ragflow" });
  });

  it("is closed when the company has no key", async () => {
    const { runtime: created, journaled } = runtime({ readCompanyKey: async () => null });
    await expect(
      created.recognize("22222222-2222-4222-8222-222222222222", {
        name: "tender.pdf",
        bytes: new Uint8Array(Buffer.from("%PDF-1.7\n", "latin1")),
        origin: "mail_attachment",
      }),
    ).rejects.toMatchObject({ code: "ocr_disabled" });
    expect(journaled).toHaveLength(0);
  });

  it("runs the tool with the same path and the configured size limit", async () => {
    const fetchImpl = vi.fn(async () => ragflowResponse("recognized"));
    const { runtime: created } = runtime({ fetch: fetchImpl as unknown as typeof fetch });
    const result = await created.callTool("22222222-2222-4222-8222-222222222222", {
      name: "tender.pdf",
      base64: PDF_BASE64,
    });
    expect(result.text).toBe("recognized");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses a litellm contour without a model", async () => {
    const { runtime: created } = runtime({
      settings: readOcrSettings({ ...env, MYRMIDON_OCR_BACKEND: "litellm" }),
    });
    await expect(
      created.recognize("22222222-2222-4222-8222-222222222222", {
        name: "tender.pdf",
        bytes: new Uint8Array(Buffer.from("%PDF-1.7\n", "latin1")),
        origin: "mail_attachment",
      }),
    ).rejects.toMatchObject({ code: "ocr_disabled" });
  });
});