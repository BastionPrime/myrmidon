// server/src/myrmidon/ocr/service.ts
//
// myrmidon(EXT-CASE-OCR): one PDF in, text + structure out, metadata journaled.
//
// The order of the steps is the whole design:
//
//   1. the document is checked against the limits *before* the backend is
//      called, so a wrong file (not a PDF, too large, too many pages) costs
//      nothing and is refused with a stable code;
//   2. the backend recognizes the bytes — its answer is text, and a failure is
//      never retried here: a retry would multiply a slow, expensive call;
//   3. the text is capped to the configured character budget, the structural
//      excerpt is derived from what is left, and the text is written to the
//      workspace FIRST;
//   4. the journal entry is written LAST and only carries metadata. If it fails,
//      the call fails (an unjournaled OCR call is not something to leave behind
//      quietly), but the text is already in the workspace, so the work is not
//      lost.
//
// Nothing in this file puts text into a journal entry, a log line or an error
// message: the error messages carry file names, sizes and counts only.

import type { OcrBackend } from "./backend.js";
import { countPdfPages, isPdf } from "./pdf.js";
import { ocrSettingsProblem, type OcrSettings } from "./settings.js";
import { DEFAULT_STRUCTURE_LIMITS, extractTenderStructure, type TenderStructureLimits } from "./structure.js";
import { OcrError, type OcrDocumentInput, type OcrDocumentMetadata, type OcrDocumentResult } from "./types.js";
import type { OcrWorkspaceWriter } from "./workspace.js";

/** The action recorded in the company's activity journal for a recognized document. */
export const OCR_JOURNAL_ACTION = "myrmidon.ocr.document.recognized";

export interface OcrJournalEntry {
  action: string;
  /** Metadata only. There is no field for the text, and there is no field for the bytes. */
  metadata: OcrDocumentMetadata;
}

export interface OcrJournal {
  record(entry: OcrJournalEntry): Promise<void>;
}

export interface OcrServiceDeps {
  settings: OcrSettings;
  /** Null when the settings cannot build one (a `litellm` contour with no model). */
  backend: OcrBackend | null;
  workspace: OcrWorkspaceWriter;
  journal: OcrJournal;
  /** Excerpt caps; the defaults are used when omitted. */
  structureLimits?: TenderStructureLimits;
}

function truncateTo(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

/** What the journal may record about this document; built from metadata alone. */
export function buildOcrMetadata(input: {
  name: string;
  sizeBytes: number;
  pages: number;
  origin: OcrDocumentInput["origin"];
  sourceId: string | null;
  backend: string;
  chars: number;
  truncated: boolean;
}): OcrDocumentMetadata {
  return {
    name: input.name,
    sizeBytes: input.sizeBytes,
    pages: input.pages,
    origin: input.origin,
    sourceId: input.sourceId,
    backend: input.backend,
    chars: input.chars,
    truncated: input.truncated,
  };
}

/** Recognizes one PDF from mail or the browser bridge. */
export async function ocrPdfDocument(
  input: OcrDocumentInput,
  deps: OcrServiceDeps,
): Promise<OcrDocumentResult> {
  const problem = ocrSettingsProblem(deps.settings);
  if (problem) throw new OcrError("ocr_disabled", problem);
  if (!deps.backend) throw new OcrError("ocr_disabled", "OCR backend is not configured");

  const sizeBytes = input.bytes.byteLength;
  if (sizeBytes === 0) throw new OcrError("empty_document", `"${input.name}" is empty`);
  if (sizeBytes > deps.settings.maxBytes) {
    throw new OcrError(
      "document_too_large",
      `"${input.name}" is ${sizeBytes} bytes; the OCR limit is ${deps.settings.maxBytes}`,
    );
  }
  if (!isPdf(input.bytes)) throw new OcrError("not_a_pdf", `"${input.name}" is not a PDF file`);

  const countedPages = countPdfPages(input.bytes);
  if (countedPages > deps.settings.maxPages) {
    throw new OcrError(
      "too_many_pages",
      `"${input.name}" has ${countedPages} pages; the OCR limit is ${deps.settings.maxPages}`,
    );
  }

  const recognized = await deps.backend.recognize({
    name: input.name,
    mimeType: "application/pdf",
    bytes: input.bytes,
  });
  const { text, truncated } = truncateTo(recognized.text, deps.settings.maxChars);
  if (!text.trim()) throw new OcrError("empty_document", `OCR recognized no text in "${input.name}"`);

  const structure = extractTenderStructure(text, deps.structureLimits ?? DEFAULT_STRUCTURE_LIMITS);
  const pages = countedPages > 0 ? countedPages : (recognized.pages ?? 0);

  try {
    await deps.workspace.write({ name: input.name, text });
  } catch (error) {
    throw new OcrError(
      "workspace_write_failed",
      `the recognized text of "${input.name}" could not be stored: ${error instanceof Error ? error.message : "write failed"}`,
    );
  }

  const metadata = buildOcrMetadata({
    name: input.name,
    sizeBytes,
    pages,
    origin: input.origin,
    sourceId: input.sourceId ?? null,
    backend: deps.backend.kind,
    chars: text.length,
    truncated,
  });

  try {
    await deps.journal.record({ action: OCR_JOURNAL_ACTION, metadata });
  } catch (error) {
    throw new OcrError(
      "journal_failed",
      `the OCR journal entry for "${input.name}" could not be written: ${error instanceof Error ? error.message : "journal failed"}`,
    );
  }

  return { text, pages, structure, metadata };
}

/** A journal that keeps nothing; for deployments that run the path without a company journal. */
export function createDiscardOcrJournal(): OcrJournal {
  return {
    async record() {
      /* nothing to record */
    },
  };
}