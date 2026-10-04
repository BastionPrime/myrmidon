// myrmidon(1.6.1 VOICE-STT A1): OGG page walking and the long-recording
// split, over synthetic but structurally valid containers.
//
// Pins: a well-formed stream parses; a torn or mixed stream does not (and is
// then sent whole); the split lands at page/frame boundaries; every chunk is
// itself a valid stream (renumbered pages, recomputed CRCs, EOS on the last
// page); the chunk start offsets accumulate.

import { describe, expect, it } from "vitest";
import { chunkAudio, estimateDurationMs, parseMpegFrames, parseOggPages, rebuildOgg } from "./chunk.js";
import { buildMpeg, buildOggOpus } from "./testbytes.js";

const PACKETS_PER_PAGE = 25;
const PAGE_MS = PACKETS_PER_PAGE * 20; // 500 ms per page

function parsePages(bytes: Uint8Array) {
  return parseOggPages(bytes)!;
}

describe("ogg container", () => {
  it("parses a well-formed single stream", () => {
    const bytes = buildOggOpus(4);
    const pages = parsePages(bytes);
    expect(pages).not.toBeNull();
    expect(pages!.length).toBe(5); // head + 4 audio pages
    expect(pages![0]!.header).toBe(true);
    expect(pages![0]!.bos).toBe(true);
    expect(pages![4]!.eos).toBe(true);
  });

  it("rejects a stream with a bad page sequence", () => {
    const bytes = buildOggOpus(4);
    bytes[19] = 0x07; // tear the second page's sequence number
    expect(parseOggPages(bytes)).toBeNull();
  });

  it("rejects trailing garbage", () => {
    const bytes = buildOggOpus(2);
    const withGarbage = new Uint8Array(bytes.length + 3);
    withGarbage.set(bytes, 0);
    expect(parseOggPages(withGarbage)).toBeNull();
  });

  it("estimates the duration from the packet count", () => {
    const bytes = buildOggOpus(4);
    expect(estimateDurationMs(bytes, "audio/ogg")).toBe(4 * PAGE_MS);
  });
});

describe("ogg split", () => {
  it("splits at page boundaries with the header page repeated into every chunk", () => {
    const bytes = buildOggOpus(10);
    const plan = chunkAudio(bytes, "audio/ogg", 1); // 1 s = 2 pages
    expect(plan.split).toBe(true);
    expect(plan.unparseable).toBe(false);
    expect(plan.chunks.length).toBe(5); // 10 pages / 2 pages per chunk
    // Each chunk must itself be a valid stream.
    for (const chunk of plan.chunks) {
      const pages = parseOggPages(chunk.bytes);
      expect(pages).not.toBeNull();
      expect(pages!.length).toBe(3); // repeated head + 2 audio pages
      expect(pages![0]!.bos).toBe(true);
      expect(pages![pages!.length - 1]!.eos).toBe(true);
      expect(pages![1]!.sequence).toBe(1);
    }
  });

  it("carries the start offsets of the chunks", () => {
    const bytes = buildOggOpus(10);
    const plan = chunkAudio(bytes, "audio/ogg", 1);
    expect(plan.chunks.map((chunk) => chunk.startMs)).toEqual([0, 1000, 2000, 3000, 4000]);
  });

  it("returns one chunk when the recording is short enough", () => {
    const bytes = buildOggOpus(2);
    const plan = chunkAudio(bytes, "audio/ogg", 60);
    expect(plan.split).toBe(false);
    expect(plan.chunks.length).toBe(1);
  });

  it("rebuilds a valid stream from a group of pages", () => {
    const bytes = buildOggOpus(3);
    const pages = parsePages(bytes);
    const rebuilt = rebuildOgg(bytes, [pages[0]!, pages[1]!]);
    const reparsed = parseOggPages(rebuilt);
    expect(reparsed).not.toBeNull();
    expect(reparsed!.length).toBe(2);
    expect(reparsed![1]!.eos).toBe(true); // the last page of the new stream
  });
});

describe("mpeg container", () => {
  it("parses a frame train and estimates the duration", () => {
    const bytes = buildMpeg(10);
    const frames = parseMpegFrames(bytes);
    expect(frames).not.toBeNull();
    expect(frames!.length).toBe(10);
    const duration = estimateDurationMs(bytes, "audio/mpeg");
    expect(duration).toBeGreaterThan(250); // 10 frames x ~26.12 ms
    expect(duration).toBeLessThan(280);
  });

  it("splits at frame boundaries with start offsets", () => {
    const bytes = buildMpeg(100);
    const plan = chunkAudio(bytes, "audio/mpeg", 1); // ~26.12 ms per frame, 1 s chunks
    expect(plan.split).toBe(true);
    expect(plan.chunks.length).toBeGreaterThan(1);
    // Each chunk is a prefix of the frame train, so it parses on its own.
    for (const chunk of plan.chunks) {
      expect(parseMpegFrames(chunk.bytes)).not.toBeNull();
    }
    expect(plan.chunks[1]!.startMs).toBeGreaterThan(0);
  });

  it("rejects garbage", () => {
    const bytes = new Uint8Array(600).fill(0x00);
    expect(parseMpegFrames(bytes)).toBeNull();
    const plan = chunkAudio(bytes, "audio/mpeg", 1);
    expect(plan.split).toBe(false);
    expect(plan.unparseable).toBe(true);
  });
});

describe("unparseable containers", () => {
  it("goes whole in one call and is marked", () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const plan = chunkAudio(bytes, "audio/wav", 60);
    expect(plan.split).toBe(false);
    expect(plan.unparseable).toBe(true); // wav has no splitter here: the whole recording is one call
    expect(plan.chunks.length).toBe(1);
    expect(plan.chunks[0]!.startMs).toBe(0);
  });

  it("marks an ogg stream that does not parse", () => {
    const bytes = buildOggOpus(2);
    bytes[50] = bytes[50]! ^ 0xff; // break a payload byte -> CRC mismatch
    const plan = chunkAudio(bytes, "audio/ogg", 1);
    expect(plan.unparseable).toBe(true);
    expect(plan.chunks.length).toBe(1);
    expect(plan.chunks[0]!.bytes.length).toBe(bytes.length);
  });
});
