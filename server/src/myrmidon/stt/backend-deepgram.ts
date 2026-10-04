// server/src/myrmidon/stt/backend-deepgram.ts
//
// myrmidon(1.6.1 VOICE-STT A1): the optional backend — Deepgram's
// pre-recorded transcription over plain HTTPS, with diarization behind the
// setting.
//
// Deepgram is addressed directly (the default address is
// https://api.deepgram.com/v1/listen); the key is the company secret named
// by `MYRMIDON_STT_DEEPGRAM_KEY_SECRET`. The same call discipline as the
// DashScope adapter: `fetch` is a dependency, the key lives for one call, a
// failure is a stable code plus the HTTP status, never the body.

import { SttError } from "./types.js";
import type { SttSegment } from "./types.js";

export const DEFAULT_DEEPGRAM_BASE_URL = "https://api.deepgram.com/v1/listen";

export interface DeepgramTranscribeInput {
  bytes: Uint8Array;
  mimeType: string;
  language: "auto" | "ru";
  diarization: boolean;
}

export interface DeepgramTranscriptionResult {
  text: string;
  segments?: Array<{ speaker?: string; startMs: number; endMs: number; text: string }>;
  language?: string;
}

export interface DeepgramBackendDeps {
  fetch: typeof fetch;
  baseUrl: string;
  /** Read from the company's secrets for this call; never stored on the backend. */
  apiKey: string;
  timeoutMs: number;
}

function secondsToMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.round(value * 1000);
  return null;
}

/**
 * Paragraphs-to-words: a Deepgram result carries `results.channels[0]
 * .alternatives[0]` with `paragraphs.paragraphs[].sentences[]` (each sentence
 * with `start`/`end` in seconds and, when diarize was on, a numeric
 * `speaker`) or a flat `words` list. Both are folded into segments; the
 * sentence view wins when present.
 */
function readSegments(payload: unknown): Array<{ speaker?: string; startMs: number; endMs: number; text: string }> | undefined {
  const alternative =
    (
      payload as {
        results?: { channels?: Array<{ alternatives?: Array<{ paragraphs?: unknown; words?: unknown }> }> };
      } | null
    )?.results?.channels?.[0]?.alternatives?.[0] ?? null;
  if (!alternative) return undefined;

  const paragraphs = (alternative.paragraphs as { paragraphs?: Array<{ sentences?: unknown }> } | undefined)?.paragraphs;
  if (Array.isArray(paragraphs)) {
    const parsed: Array<{ speaker?: string; startMs: number; endMs: number; text: string }> = [];
    for (const paragraph of paragraphs) {
      const sentences = paragraph?.sentences;
      if (!Array.isArray(sentences)) continue;
      for (const sentence of sentences) {
        if (typeof sentence !== "object" || sentence === null) continue;
        const record = sentence as { start?: unknown; end?: unknown; text?: unknown; speaker?: unknown };
        const startMs = secondsToMs(record.start);
        const endMs = secondsToMs(record.end);
        if (startMs === null || endMs === null || typeof record.text !== "string") continue;
        const entry: { speaker?: string; startMs: number; endMs: number; text: string } = {
          startMs,
          endMs,
          text: record.text,
        };
        if (typeof record.speaker === "number" && Number.isInteger(record.speaker)) {
          entry.speaker = String(record.speaker);
        } else if (typeof record.speaker === "string" && record.speaker.trim() !== "") {
          entry.speaker = record.speaker.trim();
        }
        parsed.push(entry);
      }
    }
    if (parsed.length > 0) return parsed;
  }

  const words = alternative.words;
  if (Array.isArray(words) && words.length > 0) {
    const parsed: Array<{ speaker?: string; startMs: number; endMs: number; text: string }> = [];
    let current: { speaker?: string; startMs: number; endMs: number; text: string } | null = null;
    for (const word of words) {
      if (typeof word !== "object" || word === null) continue;
      const record = word as { start?: unknown; end?: unknown; word?: unknown; punctuated_word?: unknown; speaker?: unknown };
      const startMs = secondsToMs(record.start);
      const endMs = secondsToMs(record.end);
      const text = typeof record.punctuated_word === "string" ? record.punctuated_word : record.word;
      if (startMs === null || endMs === null || typeof text !== "string") continue;
      const speaker =
        typeof record.speaker === "number" && Number.isInteger(record.speaker)
          ? String(record.speaker)
          : typeof record.speaker === "string" && record.speaker.trim() !== ""
            ? record.speaker.trim()
            : undefined;
      if (current && current.speaker === speaker) {
        current.endMs = endMs;
        current.text = `${current.text} ${text}`;
      } else {
        if (current) parsed.push(current);
        current = { startMs, endMs, text, ...(speaker !== undefined ? { speaker } : {}) };
      }
    }
    if (current) parsed.push(current);
    if (parsed.length > 0) return parsed;
  }
  return undefined;
}

export async function deepgramTranscribe(
  input: DeepgramTranscribeInput,
  deps: DeepgramBackendDeps,
): Promise<DeepgramTranscriptionResult> {
  const url = new URL(deps.baseUrl);
  url.searchParams.set("model", input.language === "ru" ? "general" : "nova-2");
  url.searchParams.set("punctuate", "true");
  if (input.diarization) url.searchParams.set("diarize", "true");

  const view = new Uint8Array(input.bytes.byteLength);
  view.set(input.bytes);

  let response: Response;
  try {
    response = await deps.fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${deps.apiKey}`,
        "content-type": input.mimeType,
      },
      body: view,
      signal: AbortSignal.timeout(deps.timeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new SttError("stt_timeout", `STT backend did not answer within ${deps.timeoutMs} ms`);
    }
    throw new SttError(
      "stt_upstream_error",
      `STT backend is unreachable: ${error instanceof Error ? error.message : "request failed"}`,
    );
  }

  if (!response.ok) {
    throw new SttError("stt_upstream_error", `STT backend answered HTTP ${response.status}`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new SttError("stt_upstream_error", "STT backend answered with a body that is not JSON");
  }

  const transcript =
    (
      payload as {
        results?: { channels?: Array<{ alternatives?: Array<{ transcript?: unknown }> }> };
      } | null
    )?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? null;
  if (typeof transcript !== "string") {
    throw new SttError("stt_upstream_error", "STT backend answer has no transcript");
  }
  return {
    text: transcript,
    segments: readSegments(payload),
  };
}
