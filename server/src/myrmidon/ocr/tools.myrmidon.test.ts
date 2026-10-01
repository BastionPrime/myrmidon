// myrmidon(EXT-CASE-OCR): the `ocr.pdf` tool contract.

import { describe, expect, it, vi } from "vitest";
import { OcrError } from "./types.js";
import {
  callOcrPdfTool,
  decodeBase64Bytes,
  estimateBase64Bytes,
  ocrPdfToolDefinition,
  OCR_PDF_TOOL_NAME,
} from "./tools.js";

const PDF_BYTES = new Uint8Array(Buffer.from("%PDF-1.7\n%%EOF\n", "latin1"));
const PDF_BASE64 = Buffer.from(PDF_BYTES).toString("base64");

const RESULT = {
  text: "recognized",
  pages: 1,
  structure: { requirements: [], deadlines: [], positions: [] },
  metadata: {
    name: "tender.pdf",
    sizeBytes: PDF_BYTES.byteLength,
    pages: 1,
    origin: "mail_attachment" as const,
    sourceId: null,
    backend: "ragflow",
    chars: 10,
    truncated: false,
  },
};

describe("ocr.pdf tool definition", () => {
  it("is named ocr.pdf and declares its input", () => {
    expect(OCR_PDF_TOOL_NAME).toBe("ocr.pdf");
    expect(ocrPdfToolDefinition.name).toBe("ocr.pdf");
    const schema = ocrPdfToolDefinition.inputSchema as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(["name", "base64", "origin", "sourceId"]));
    expect(schema.required).toEqual(["name", "base64"]);
  });
});

describe("base64 handling", () => {
  it("estimates the decoded size without decoding", () => {
    expect(estimateBase64Bytes(PDF_BASE64)).toBe(PDF_BYTES.byteLength);
    expect(estimateBase64Bytes("data:application/pdf;base64,AAAA")).toBe(3);
    expect(estimateBase64Bytes("AAAA")).toBe(3);
    expect(estimateBase64Bytes("AA==")).toBe(1);
  });

  it("decodes a plain payload and a data URL alike", () => {
    expect(Array.from(decodeBase64Bytes(PDF_BASE64))).toEqual(Array.from(PDF_BYTES));
    expect(Array.from(decodeBase64Bytes(`data:application/pdf;base64,${PDF_BASE64}`))).toEqual(
      Array.from(PDF_BYTES),
    );
  });

  it("refuses a payload that is not base64", () => {
    for (const bad of ["", "not base64!", "AAA", "AA=A"]) {
      expect(() => decodeBase64Bytes(bad)).toThrowError(OcrError);
    }
  });
});

describe("callOcrPdfTool", () => {
  type RunOcr = (input: {
    name: string;
    bytes: Uint8Array;
    origin: "mail_attachment" | "browser_download";
    sourceId: string | null;
  }) => Promise<typeof RESULT>;

  it("passes the decoded bytes and the origin to the OCR path", async () => {
    const runOcr = vi.fn<RunOcr>(async () => RESULT);
    const result = await callOcrPdfTool(
      { name: "tender.pdf", base64: PDF_BASE64, origin: "browser_download", sourceId: "https://tender.example.com/list" },
      { runOcr },
    );
    expect(result).toBe(RESULT);
    expect(runOcr).toHaveBeenCalledTimes(1);
    const input = runOcr.mock.calls[0]![0];
    expect(input.name).toBe("tender.pdf");
    expect(Array.from(input.bytes)).toEqual(Array.from(PDF_BYTES));
    expect(input.origin).toBe("browser_download");
    expect(input.sourceId).toBe("https://tender.example.com/list");
  });

  it("defaults the origin to a mail attachment", async () => {
    const runOcr = vi.fn<RunOcr>(async () => RESULT);
    await callOcrPdfTool({ name: "tender.pdf", base64: PDF_BASE64 }, { runOcr });
    expect(runOcr.mock.calls[0]![0].origin).toBe("mail_attachment");
    expect(runOcr.mock.calls[0]![0].sourceId).toBeNull();
  });

  it("refuses invalid arguments before touching the bytes", async () => {
    const runOcr = vi.fn<RunOcr>(async () => RESULT);
    const cases: unknown[] = [
      {},
      { name: "", base64: PDF_BASE64 },
      { name: "tender.pdf" },
      { name: "tender.pdf", base64: PDF_BASE64, origin: "somewhere_else" },
    ];
    for (const args of cases) {
      await expect(callOcrPdfTool(args, { runOcr })).rejects.toMatchObject({ code: "invalid_tool_input" });
    }
    expect(runOcr).not.toHaveBeenCalled();
  });

  it("refuses an oversized payload before decoding it", async () => {
    const runOcr = vi.fn<RunOcr>(async () => RESULT);
    await expect(
      callOcrPdfTool({ name: "tender.pdf", base64: PDF_BASE64 }, { runOcr, maxBytes: 4 }),
    ).rejects.toMatchObject({ code: "document_too_large" });
    expect(runOcr).not.toHaveBeenCalled();
  });
});