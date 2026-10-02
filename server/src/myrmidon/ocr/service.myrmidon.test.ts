// myrmidon(EXT-CASE-OCR): the OCR path end to end, over fake ports.
//
// Everything expensive is faked — a backend that returns fixed text, a journal
// that remembers what it was asked to write, a workspace that remembers the
// text — so the suite tests the order and the boundaries of the real service:
// limits before the backend call, text to the workspace, metadata to the
// journal, and never the text into the journal.

import { describe, expect, it, vi } from "vitest";
import type { OcrBackend } from "./backend.js";
import { DEFAULT_OCR_MAX_BYTES, type OcrSettings } from "./settings.js";
import { OCR_JOURNAL_ACTION, ocrPdfDocument, type OcrJournalEntry } from "./service.js";
import { OcrError, type OcrDocumentInput } from "./types.js";
import type { OcrWorkspaceWriter } from "./workspace.js";

const RECOGNIZED_TEXT =
  "Пример закупочной документации\nТребования\nУчастник должен иметь лицензию.\nСрок подачи заявок — до 31.12.2026.\nПозиции\nСтол письменный 12 шт\n";

const SECRET_TOKEN = "SECRET-DOCUMENT-TEXT-MUST-NOT-BE-JOURNALED";

const PDF_BYTES = new Uint8Array(
  Buffer.from("%PDF-1.7\n<< /Type /Pages /Count 2 >>\n<< /Type /Page >>\n<< /Type /Page >>\n%%EOF\n", "latin1"),
);

function settings(overrides: Partial<OcrSettings> = {}): OcrSettings {
  return {
    enabled: true,
    backend: "ragflow",
    baseUrl: "http://ocr.example.com/mcp",
    keySecret: "ocr-key",
    model: null,
    maxBytes: DEFAULT_OCR_MAX_BYTES,
    maxPages: 500,
    maxChars: 2_000_000,
    timeoutMs: 120_000,
    ...overrides,
  };
}

function input(overrides: Partial<OcrDocumentInput> = {}): OcrDocumentInput {
  return { name: "tender.pdf", bytes: PDF_BYTES, origin: "mail_attachment", sourceId: "msg-1", ...overrides };
}

function harness(options: { text?: string; backendPages?: number | null; backendError?: Error } = {}) {
  const written: Array<{ name: string; text: string }> = [];
  const journaled: OcrJournalEntry[] = [];
  const backend: OcrBackend = {
    kind: "ragflow",
    recognize: vi.fn(async () => {
      if (options.backendError) throw options.backendError;
      return { text: options.text ?? RECOGNIZED_TEXT, pages: options.backendPages ?? null };
    }),
  };
  const workspace: OcrWorkspaceWriter = {
    write: async (value) => {
      written.push(value);
      return { path: `/workspace/${value.name}` };
    },
  };
  return {
    written,
    journaled,
    backend,
    deps: {
      settings: settings(),
      backend,
      workspace,
      journal: { record: async (entry: OcrJournalEntry) => void journaled.push(entry) },
    },
  };
}

describe("ocrPdfDocument", () => {
  it("returns the recognized text, the page count and the tender structure", async () => {
    const { deps, written, journaled } = harness();
    const result = await ocrPdfDocument(input(), deps);

    expect(result.text).toBe(RECOGNIZED_TEXT);
    expect(result.pages).toBe(2);
    expect(result.structure.requirements.map((item) => item.text)).toEqual(["Участник должен иметь лицензию."]);
    expect(result.structure.deadlines).toEqual([
      { text: "Срок подачи заявок — до 31.12.2026.", date: "2026-12-31" },
    ]);
    expect(result.structure.positions).toEqual([{ name: "Стол письменный", quantity: "12", unit: "шт" }]);
    expect(written).toEqual([{ name: "tender.pdf", text: RECOGNIZED_TEXT }]);
    expect(journaled).toHaveLength(1);
    expect(journaled[0]!.action).toBe(OCR_JOURNAL_ACTION);
  });

  it("journals metadata only — the text and the bytes never reach the entry", async () => {
    const { deps, journaled } = harness({ text: `${RECOGNIZED_TEXT}\n${SECRET_TOKEN}` });
    await ocrPdfDocument(input(), deps);

    const entry = journaled[0]!;
    expect(entry.metadata).toEqual({
      name: "tender.pdf",
      sizeBytes: PDF_BYTES.byteLength,
      pages: 2,
      origin: "mail_attachment",
      sourceId: "msg-1",
      backend: "ragflow",
      chars: RECOGNIZED_TEXT.length + 1 + SECRET_TOKEN.length,
      truncated: false,
    });
    expect(JSON.stringify(entry)).not.toContain(SECRET_TOKEN);
    expect(JSON.stringify(entry)).not.toContain("%PDF");
  });

  it("refuses the document before the backend when the limits are exceeded", async () => {
    const tooLarge = harness();
    await expect(
      ocrPdfDocument(input(), { ...tooLarge.deps, settings: settings({ maxBytes: 10 }) }),
    ).rejects.toMatchObject({ code: "document_too_large" });
    expect(tooLarge.backend.recognize).not.toHaveBeenCalled();

    const tooManyPages = harness();
    await expect(
      ocrPdfDocument(input(), {
        ...tooManyPages.deps,
        settings: settings({ maxPages: 1 }),
      }),
    ).rejects.toMatchObject({ code: "too_many_pages" });
    expect(tooManyPages.backend.recognize).not.toHaveBeenCalled();
  });

  it("refuses a file that is not a PDF and an empty file", async () => {
    const notPdf = harness();
    await expect(
      ocrPdfDocument(input({ bytes: new Uint8Array(Buffer.from("not a pdf", "latin1")) }), notPdf.deps),
    ).rejects.toMatchObject({ code: "not_a_pdf" });
    expect(notPdf.backend.recognize).not.toHaveBeenCalled();

    const empty = harness();
    await expect(ocrPdfDocument(input({ bytes: new Uint8Array(0) }), empty.deps)).rejects.toMatchObject({
      code: "empty_document",
    });
    expect(empty.backend.recognize).not.toHaveBeenCalled();
  });

  it("is closed when the instance has no OCR contour", async () => {
    const { deps } = harness();
    await expect(
      ocrPdfDocument(input(), { ...deps, settings: settings({ baseUrl: null, enabled: false }) }),
    ).rejects.toMatchObject({ code: "ocr_disabled" });
    await expect(
      ocrPdfDocument(input(), { ...deps, backend: null }),
    ).rejects.toMatchObject({ code: "ocr_disabled" });
  });

  it("reports an empty recognition as an empty document", async () => {
    const { deps } = harness({ text: "   \n" });
    await expect(ocrPdfDocument(input(), deps)).rejects.toMatchObject({ code: "empty_document" });
  });

  it("wraps a backend failure in a stable code", async () => {
    const { deps } = harness({ backendError: new OcrError("backend_failed", "OCR backend answered 502") });
    await expect(ocrPdfDocument(input(), deps)).rejects.toMatchObject({ code: "backend_failed" });
  });

  it("falls back to the backend's own page count when the bytes carry none", async () => {
    const compressed = new Uint8Array(Buffer.from("%PDF-1.5\nno page markers here", "latin1"));
    const { deps } = harness({ backendPages: 4 });
    const result = await ocrPdfDocument(input({ bytes: compressed }), deps);
    expect(result.pages).toBe(4);
  });

  it("caps the text and says so", async () => {
    const { deps } = harness({ text: "abcdefghij" });
    const result = await ocrPdfDocument(input(), { ...deps, settings: settings({ maxChars: 4 }) });
    expect(result.text).toBe("abcd");
    expect(result.metadata.truncated).toBe(true);
    expect(result.metadata.chars).toBe(4);
  });

  it("fails the call when the workspace cannot store the text, and when the journal cannot record it", async () => {
    const { deps } = harness();
    await expect(
      ocrPdfDocument(input(), {
        ...deps,
        workspace: { write: async () => { throw new Error("disk full"); } },
      }),
    ).rejects.toMatchObject({ code: "workspace_write_failed" });

    const { deps: deps2 } = harness();
    await expect(
      ocrPdfDocument(input(), { ...deps2, journal: { record: async () => { throw new Error("db down"); } } }),
    ).rejects.toMatchObject({ code: "journal_failed" });
  });
});