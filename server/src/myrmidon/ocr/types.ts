// server/src/myrmidon/ocr/types.ts
//
// myrmidon(EXT-CASE-OCR): the contract of the OCR path shared by the mail
// connector and the browser bridge.
//
// A PDF reaches this module from one of two places — an attachment the mail
// connector fetched (`mail.attachment`) or a file the browser bridge downloaded
// (`browser.download`) — and both hand over the same thing: the file name and
// its bytes. The module knows nothing about mail or the bridge, so it can be
// built and tested before either of them lands; the two producers are adapted
// in `contracts.ts`.
//
// The result carries the recognized text (the workspace payload) and a small
// structural excerpt for tender documentation (requirements, deadlines,
// positions). Only `OcrDocumentMetadata` may leave the module for the activity
// journal: the text never goes there.

/** Where the document came from. Kept in the journal instead of the bytes. */
export type OcrDocumentOrigin = "mail_attachment" | "browser_download";

/** One PDF handed to the OCR path. */
export interface OcrDocumentInput {
  /** Original file name: the journal records it and the workspace file reuses it. */
  name: string;
  /** Raw PDF bytes. Never logged, never journaled. */
  bytes: Uint8Array;
  /** The producer of the bytes; recorded, not interpreted. */
  origin: OcrDocumentOrigin;
  /**
   * The producer's own identifier of the source — a message id, a page url.
   * Recorded as metadata; a caller without one passes null.
   */
  sourceId?: string | null;
}

/** A requirement or obligatory condition found in the document. */
export interface TenderRequirement {
  /** The sentence as recognized, trimmed to one line. */
  text: string;
}

/** A deadline found in the document. */
export interface TenderDeadline {
  /** The line the date came from, trimmed. */
  text: string;
  /** The date normalized to `YYYY-MM-DD`, or null when the line had no full date. */
  date: string | null;
}

/** A position (lot, goods line, work item) found in the document. */
export interface TenderPosition {
  /** The name of the position. */
  name: string;
  /** Quantity as written (may be null when the line carried only a name). */
  quantity: string | null;
  /** Unit of measure as written (may be null). */
  unit: string | null;
}

/** The structural excerpt a tender document is read for. */
export interface TenderStructure {
  requirements: TenderRequirement[];
  deadlines: TenderDeadline[];
  positions: TenderPosition[];
}

/** What the journal may record about a recognized document. */
export interface OcrDocumentMetadata {
  name: string;
  sizeBytes: number;
  /** Pages counted in the PDF (0 when the file's page tree could not be read). */
  pages: number;
  origin: OcrDocumentOrigin;
  sourceId: string | null;
  /** Which backend produced the text (`ragflow`, `litellm`). */
  backend: string;
  /** Length of the recognized text. */
  chars: number;
  /** True when the text hit the configured character cap and was cut. */
  truncated: boolean;
}

/** The full result of the OCR path. */
export interface OcrDocumentResult {
  /** Recognized text; the workspace payload. */
  text: string;
  /** Pages counted in the PDF before recognition. */
  pages: number;
  /** Structural excerpt for tender documentation. */
  structure: TenderStructure;
  /** Metadata only — safe for the activity journal. */
  metadata: OcrDocumentMetadata;
}

/** Error codes of the OCR path; the message is what a bot sees. */
export type OcrErrorCode =
  | "ocr_disabled"
  | "not_a_pdf"
  | "document_too_large"
  | "too_many_pages"
  | "empty_document"
  | "backend_failed"
  | "workspace_write_failed"
  | "journal_failed"
  | "invalid_tool_input";

/** A failure of the OCR path with a stable code. */
export class OcrError extends Error {
  readonly code: OcrErrorCode;

  constructor(code: OcrErrorCode, message: string) {
    super(message);
    this.name = "OcrError";
    this.code = code;
  }
}