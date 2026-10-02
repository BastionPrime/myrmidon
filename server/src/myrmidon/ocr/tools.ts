// server/src/myrmidon/ocr/tools.ts
//
// myrmidon(EXT-CASE-OCR): the `ocr.pdf` tool a bot calls.
//
// The bot never receives raw PDF bytes from the board: the mail connector and the
// browser bridge hand the document to the OCR path themselves, and this tool is
// the way a bot asks for a document it obtained as base64 (a file downloaded into
// its workspace, an attachment its own MCP server returned). The input is small
// on purpose — a name, the base64 payload and where it came from — so the tool
// description stays a description of one action.
//
// Validation happens before anything is decoded: a payload that is not base64,
// or one whose decoded size would exceed the OCR limit, is refused with
// `invalid_tool_input` / `document_too_large` and not one byte of it is held in
// memory. The decoded bytes are `Uint8Array`, the same thing the mail and bridge
// adapters pass, so all three producers meet the same contract.

import { z } from "zod";
import type { OcrDocumentResult } from "./types.js";
import { OcrError } from "./types.js";

export const OCR_PDF_TOOL_NAME = "ocr.pdf";

/** Strips a `data:` prefix; the rest must be plain base64. */
function normalizeBase64(raw: string): string {
  const comma = raw.indexOf(",");
  const withoutPrefix = raw.startsWith("data:") && comma >= 0 ? raw.slice(comma + 1) : raw;
  return withoutPrefix.replace(/\s+/g, "");
}

/** Bytes a base64 payload decodes to, without decoding it. */
export function estimateBase64Bytes(base64: string): number {
  const normalized = normalizeBase64(base64);
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
}

export function decodeBase64Bytes(base64: string): Uint8Array {
  const normalized = normalizeBase64(base64);
  if (normalized.length === 0 || normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new OcrError("invalid_tool_input", "the ocr.pdf payload is not valid base64");
  }
  return new Uint8Array(Buffer.from(normalized, "base64"));
}

export const ocrPdfToolInput = z.object({
  /** File name; it names the workspace file and the journal entry. */
  name: z.string().min(1).max(255),
  /** The PDF itself, base64 (a `data:` URL prefix is tolerated). */
  base64: z.string().min(1),
  /** Where the bot got it; recorded, not interpreted. */
  origin: z.enum(["mail_attachment", "browser_download"]).optional(),
  /** The producer's identifier of the source, when the bot has one. */
  sourceId: z.string().max(255).nullish(),
});

export const ocrPdfToolDefinition = {
  name: OCR_PDF_TOOL_NAME,
  description:
    "Recognize a PDF and return its text plus the tender structure (requirements, deadlines, " +
    "positions). The text is stored in the workspace; only the file name, size and page count " +
    "reach the journal. Use it for tender documentation received as a PDF or downloaded from a " +
    "tender platform.",
  inputSchema: z.toJSONSchema(ocrPdfToolInput),
};

export interface OcrPdfToolDeps {
  /** Recognizes the decoded document; the same call the mail and bridge paths use. */
  runOcr(input: {
    name: string;
    bytes: Uint8Array;
    origin: "mail_attachment" | "browser_download";
    sourceId: string | null;
  }): Promise<OcrDocumentResult>;
  /** Size limit from the OCR settings, used to refuse oversized payloads before decoding. */
  maxBytes?: number;
}

/** Runs `ocr.pdf`. Throws `OcrError` with a stable code on bad input or failure. */
export async function callOcrPdfTool(args: unknown, deps: OcrPdfToolDeps): Promise<OcrDocumentResult> {
  const parsed = ocrPdfToolInput.safeParse(args);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join(".") || "arguments";
    throw new OcrError("invalid_tool_input", `ocr.pdf: ${where} — ${issue?.message ?? "invalid input"}`);
  }
  const { name, base64, sourceId } = parsed.data;
  const estimated = estimateBase64Bytes(base64);
  if (deps.maxBytes !== undefined && estimated > deps.maxBytes) {
    throw new OcrError(
      "document_too_large",
      `"${name}" is about ${estimated} bytes; the OCR limit is ${deps.maxBytes}`,
    );
  }
  const bytes = decodeBase64Bytes(base64);
  return deps.runOcr({
    name,
    bytes,
    origin: parsed.data.origin ?? "mail_attachment",
    sourceId: sourceId ?? null,
  });
}