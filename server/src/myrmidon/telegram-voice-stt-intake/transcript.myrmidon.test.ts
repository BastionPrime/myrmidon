// server/src/myrmidon/telegram-voice-stt-intake/transcript.myrmidon.test.ts
//
// myrmidon(1.6.1 VOICE-STT B): rendering of the transcript block that lands
// in the inbound task comment next to the voice attachment.

import { describe, expect, it } from "vitest";
import {
  composeVoiceCommentBody,
  MAX_TRANSCRIPT_BLOCK_CHARS,
  renderVoiceTranscript,
  type VoiceTranscript,
} from "./transcript.js";

const base: VoiceTranscript = {
  text: "hello",
  segments: undefined,
  language: "ru",
  durationMs: 1000,
  truncated: false,
  backend: "mock",
};

describe("renderVoiceTranscript", () => {
  it("returns the plain text when there are no segments", () => {
    expect(renderVoiceTranscript(base)).toBe("hello");
  });

  it("renders speaker segments as «Говорящий N [mm:ss]: …» lines", () => {
    const rendered = renderVoiceTranscript({
      ...base,
      text: "",
      segments: [
        { speaker: "1", startMs: 0, endMs: 4000, text: "первая фраза" },
        { speaker: "2", startMs: 65000, endMs: 68000, text: "вторая" },
      ],
    });
    expect(rendered).toBe(
      "Говорящий 1 [0:00]: первая фраза\nГоворящий 2 [1:05]: вторая",
    );
  });

  it("keeps a timestamp-only line for a speaker-less segment", () => {
    const rendered = renderVoiceTranscript({
      ...base,
      text: "",
      segments: [{ startMs: 5000, endMs: 9000, text: "no speaker" }],
    });
    expect(rendered).toBe("[0:05]: no speaker");
  });

  it("joins plain text and segments with a blank line", () => {
    const rendered = renderVoiceTranscript({
      ...base,
      segments: [{ speaker: "1", startMs: 120000, endMs: 125000, text: "хвост" }],
    });
    expect(rendered).toBe("hello\n\nГоворящий 1 [2:00]: хвост");
  });

  it("returns null when nothing usable came back", () => {
    expect(renderVoiceTranscript({ ...base, text: "   " })).toBeNull();
  });

  it("drops empty segment lines", () => {
    const rendered = renderVoiceTranscript({
      ...base,
      text: "",
      segments: [
        { speaker: "1", startMs: 0, endMs: 100, text: "  " },
        { speaker: "1", startMs: 200, endMs: 300, text: "ok" },
      ],
    });
    expect(rendered).toBe("Говорящий 1 [0:00]: ok");
  });

  it("caps an oversized transcript and marks the cut", () => {
    const rendered = renderVoiceTranscript({
      ...base,
      text: "x".repeat(MAX_TRANSCRIPT_BLOCK_CHARS + 500),
    })!;
    expect(rendered.length).toBe(
      MAX_TRANSCRIPT_BLOCK_CHARS + "\n[transcript truncated]".length,
    );
    expect(rendered.endsWith("\n[transcript truncated]")).toBe(true);
  });
});

describe("composeVoiceCommentBody", () => {
  it("appends the transcript under the sender text", () => {
    expect(
      composeVoiceCommentBody({ senderText: "посмотри", transcriptBlock: "текст" }),
    ).toBe("посмотри\n\nтекст");
  });

  it("returns the transcript alone when the sender text is empty", () => {
    expect(
      composeVoiceCommentBody({ senderText: "   ", transcriptBlock: "текст" }),
    ).toBe("текст");
  });
});