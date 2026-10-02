// myrmidon(EXT-CASE-OCR): PDF facts read from the bytes.
//
// The fixtures are hand-built PDFs with neutral content ("Example tender"),
// because the point of the suite is the shape of the bytes, not a real file:
// an uncompressed page tree (markers visible) and a compressed one (only
// `/Count` visible) are the two cases the counters must tell apart.

import { describe, expect, it } from "vitest";
import { countPdfPages, isPdf } from "./pdf.js";

function latin1(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "latin1"));
}

const PAGE = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>";

function uncompressedPdf(pages: number): Uint8Array {
  const body = Array.from({ length: pages }, () => PAGE).join("\n");
  return latin1(`%PDF-1.7\n1 0 obj\n<< /Type /Pages /Kids [] /Count ${pages} >>\nendobj\n${body}\ntrailer\n%%EOF\n`);
}

describe("isPdf", () => {
  it("accepts a PDF header anywhere inside the reader's window", () => {
    expect(isPdf(latin1("%PDF-1.7\n"))).toBe(true);
    expect(isPdf(latin1("\uFEFFjunk junk %PDF-1.4 body"))).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isPdf(latin1("PK\u0003\u0004 a zip"))).toBe(false);
    expect(isPdf(new Uint8Array(0))).toBe(false);
    expect(isPdf(latin1("%PD"))).toBe(false);
  });
});

describe("countPdfPages", () => {
  it("counts page dictionaries, not the page tree node", () => {
    const pdf = uncompressedPdf(3);
    // The fixture has one `/Type /Pages` node and three `/Type /Page` pages:
    // counting the tree node as well would answer 4.
    expect(countPdfPages(pdf)).toBe(3);
  });

  it("does not count /PageMode, /PageLayout or /Pages as pages", () => {
    const pdf = latin1(
      "%PDF-1.7\n<< /Type /Catalog /PageLayout /SinglePage /PageMode /UseNone >>\n" +
        "<< /Type /Pages /Count 2 >>\n" +
        "<< /Type /Page /Parent 3 0 R >>\n<< /Type /Page /Parent 3 0 R >>",
    );
    expect(countPdfPages(pdf)).toBe(2);
  });

  it("falls back to the page tree count when page objects are compressed", () => {
    const pdf = latin1(
      "%PDF-1.5\n1 0 obj\n<< /Type /Pages /Kids [4 0 R] /Count 7 >>\nendobj\n4 0 obj\n<< /Length 20 /Filter /FlateDecode >>\nstream\n\u0000\u0001binary\nendstream",
    );
    expect(countPdfPages(pdf)).toBe(7);
  });

  it("ignores a /Count-like key and answers 0 when nothing is readable", () => {
    expect(countPdfPages(latin1("%PDF-1.7\n<< /Counter 42 >>\nno pages here"))).toBe(0);
    expect(countPdfPages(new Uint8Array(0))).toBe(0);
  });

  it("takes the largest /Count, not the first", () => {
    const pdf = latin1("%PDF-1.5\n<< /Type /Pages /Count 1 >>\n<< /Type /Pages /Count 12 >>");
    expect(countPdfPages(pdf)).toBe(12);
  });
});