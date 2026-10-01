// server/src/myrmidon/ocr/pdf.ts
//
// myrmidon(EXT-CASE-OCR): cheap, dependency-free facts about a PDF.
//
// The OCR path needs two things before it spends a backend call: is this a PDF
// at all, and how many pages does it have (the journal records the count, and a
// page cap keeps a wrong file from eating the backend). The bot image carries no
// PDF tooling, and the board server should not grow one for a page count, so the
// two facts are read straight from the bytes.
//
// Counting scans for `/Page` dictionary markers and skips `/Pages` (the page
// *tree* node, not a page) by requiring the next byte after the marker to be a
// non-letter: `/Page`, `/Page<`, `/Page/`, `/Page>` count, while `/Pages`,
// `/PageMode` and `/PageLayout` do not. A file whose page objects live inside
// compressed object streams exposes no markers; there the largest `/Count` of
// the page tree is used instead, and a file that shows neither is counted as 0
// pages rather than guessed at.

const PDF_HEADER = "%PDF-";
/** How far into the file the header may sit (readers tolerate leading junk). */
const HEADER_WINDOW = 1024;

function indexOfBytes(haystack: Uint8Array, needle: readonly number[], from: number): number {
  const last = haystack.length - needle.length;
  for (let i = Math.max(0, from); i <= last; i += 1) {
    let hit = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) {
        hit = false;
        break;
      }
    }
    if (hit) return i;
  }
  return -1;
}

function isAsciiLetter(byte: number | undefined): boolean {
  if (byte === undefined) return false;
  return (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a);
}

const PAGE_MARKER = [0x2f, 0x50, 0x61, 0x67, 0x65]; // "/Page"
const COUNT_MARKER = [0x2f, 0x43, 0x6f, 0x75, 0x6e, 0x74]; // "/Count"
const DIGIT = (byte: number | undefined): boolean => byte !== undefined && byte >= 0x30 && byte <= 0x39;

/** True when the bytes carry a PDF header within the reader's tolerance window. */
export function isPdf(bytes: Uint8Array): boolean {
  const window = bytes.subarray(0, Math.min(bytes.length, HEADER_WINDOW));
  return indexOfBytes(window, [...PDF_HEADER].map((char) => char.charCodeAt(0)), 0) >= 0;
}

/** Pages found as `/Page` dictionary markers, skipping the `/Pages` tree node. */
function countPageMarkers(bytes: Uint8Array): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = indexOfBytes(bytes, PAGE_MARKER, from);
    if (at < 0) return count;
    if (!isAsciiLetter(bytes[at + PAGE_MARKER.length])) count += 1;
    from = at + PAGE_MARKER.length;
  }
}

/** The largest integer written after a `/Count` token (the page tree's own count). */
function largestCountToken(bytes: Uint8Array): number {
  let largest = 0;
  let from = 0;
  for (;;) {
    const at = indexOfBytes(bytes, COUNT_MARKER, from);
    if (at < 0) return largest;
    from = at + COUNT_MARKER.length;
    // `/Count` must be followed by whitespace before the number, not by a letter
    // (`/Counter` is a different key).
    if (isAsciiLetter(bytes[from])) continue;
    let cursor = from;
    while (cursor < bytes.length && !DIGIT(bytes[cursor]) && !isAsciiLetter(bytes[cursor])) cursor += 1;
    let value = 0;
    let digits = 0;
    while (cursor < bytes.length && DIGIT(bytes[cursor])) {
      value = value * 10 + (bytes[cursor]! - 0x30);
      cursor += 1;
      digits += 1;
      if (digits > 9) break;
    }
    if (digits > 0 && value > largest) largest = value;
  }
}

/**
 * Pages in the file: the number of page dictionaries, or the page tree's own
 * count when the objects are compressed. 0 means "could not be read from the
 * bytes" — callers keep the document but must not claim a page number.
 */
export function countPdfPages(bytes: Uint8Array): number {
  const markers = countPageMarkers(bytes);
  if (markers > 0) return markers;
  return largestCountToken(bytes);
}