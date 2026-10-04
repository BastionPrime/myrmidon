// myrmidon(1.6.1 VOICE-STT A1): merging the per-chunk transcriptions back
// onto the recording's timeline.
//
// Pins: the offsets shift every segment; the texts concatenate in order; the
// speakers are renumbered per recording (two chunks' "1" stay distinct); a
// chunk without speakers keeps its segments unlabeled — speakers are never
// invented.

import { describe, expect, it } from "vitest";
import { mergeChunkResults } from "./merge.js";

describe("mergeChunkResults", () => {
  it("shifts the segments by the chunk offsets and concatenates the text", () => {
    const merged = mergeChunkResults(
      [
        { text: "первый кусок", segments: [{ startMs: 0, endMs: 900, text: "первый" }] },
        { text: "второй кусок", segments: [{ startMs: 100, endMs: 950, text: "второй" }] },
      ],
      [0, 1000],
    );
    expect(merged.text).toBe("первый кусок второй кусок");
    expect(merged.segments).toEqual([
      { startMs: 0, endMs: 900, text: "первый" },
      { startMs: 1100, endMs: 1950, text: "второй" },
    ]);
  });

  it("renumbers the speakers per recording, so two chunks' 1 stay distinct", () => {
    const merged = mergeChunkResults(
      [
        { text: "a", segments: [{ speaker: "1", startMs: 0, endMs: 500, text: "a" }] },
        { text: "b", segments: [{ speaker: "1", startMs: 0, endMs: 500, text: "b" }] },
        { text: "c", segments: [{ speaker: "2", startMs: 0, endMs: 500, text: "c" }] },
      ],
      [0, 1000, 2000],
    );
    expect(merged.segments!.map((segment) => segment.speaker)).toEqual(["1", "2", "3"]);
  });

  it("keeps the same chunk's speaker stable across its segments", () => {
    const merged = mergeChunkResults(
      [
        {
          text: "a b",
          segments: [
            { speaker: "1", startMs: 0, endMs: 500, text: "a" },
            { speaker: "1", startMs: 500, endMs: 900, text: "b" },
          ],
        },
      ],
      [0],
    );
    expect(merged.segments!.map((segment) => segment.speaker)).toEqual(["1", "1"]);
  });

  it("does not invent speakers for chunks that returned none", () => {
    const merged = mergeChunkResults(
      [
        { text: "a", segments: [{ startMs: 0, endMs: 500, text: "a" }] },
        { text: "b", segments: [{ speaker: "1", startMs: 0, endMs: 500, text: "b" }] },
      ],
      [0, 1000],
    );
    expect(merged.segments![0]!.speaker).toBeUndefined();
    expect(merged.segments![1]!.speaker).toBe("1");
  });

  it("takes the first reported language and skips empty texts", () => {
    const merged = mergeChunkResults(
      [{ text: "  ", language: "en" }, { text: "текст", language: "ru" }],
      [0, 1000],
    );
    expect(merged.text).toBe("текст");
    expect(merged.language).toBe("en");
  });
});
