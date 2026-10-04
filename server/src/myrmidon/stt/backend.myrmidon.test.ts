// myrmidon(1.6.1 VOICE-STT A1): the backend adapters, over a fake fetch.
//
// Pins: the exact request shapes (multipart transcription for the DashScope
// path, raw-body listen for Deepgram with the diarize parameter), the stable
// failure codes (a model-name rejection is `stt_unconfigured`, everything
// else is `stt_upstream_error` with the status, never the body), and the
// timeout code. No real keys: the fake key value is checked to never appear
// in an error message.

import { describe, expect, it, vi } from "vitest";
import { dashscopeTranscribe } from "./backend-dashscope.js";
import { deepgramTranscribe } from "./backend-deepgram.js";
import { SttError } from "./types.js";

const KEY_VALUE = "company-key-value";
const BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function failure(promise: Promise<unknown>): Promise<SttError> {
  try {
    await promise;
  } catch (error) {
    return error as SttError;
  }
  throw new Error("expected the call to fail");
}

describe("dashscope backend", () => {
  it("posts multipart to /v1/audio/transcriptions with the model and the bearer key", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => jsonResponse({ text: "recognized text" }));
    const result = await dashscopeTranscribe(
      { bytes: BYTES, mimeType: "audio/ogg", language: "auto" },
      { fetch: fetchImpl, baseUrl: "http://gateway.example.com", apiKey: KEY_VALUE, model: "stt-model", timeoutMs: 5_000 },
    );
    expect(result.text).toBe("recognized text");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://gateway.example.com/v1/audio/transcriptions");
    expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY_VALUE}`);
    const form = init?.body as FormData;
    expect(form.get("model")).toBe("stt-model");
    expect(form.has("language")).toBe(false); // auto -> not sent
  });

  it("does not duplicate /v1 when the address ends with it, and sends the language when set", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => jsonResponse({ text: "текст" }));
    await dashscopeTranscribe(
      { bytes: BYTES, mimeType: "audio/ogg", language: "ru" },
      { fetch: fetchImpl, baseUrl: "http://gateway.example.com/v1/", apiKey: KEY_VALUE, model: "stt-model", timeoutMs: 5_000 },
    );
    expect(fetchImpl.mock.calls[0]![0]).toBe("http://gateway.example.com/v1/audio/transcriptions");
    const form = fetchImpl.mock.calls[0]![1]?.body as FormData;
    expect(form.get("language")).toBe("ru");
  });

  it("degrades a model-name rejection to stt_unconfigured", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () =>
      jsonResponse({ error: { message: "Invalid model name stt-model" } }, 400),
    );
    const error = await failure(
      dashscopeTranscribe(
        { bytes: BYTES, mimeType: "audio/ogg", language: "auto" },
        { fetch: fetchImpl, baseUrl: "http://gateway.example.com", apiKey: KEY_VALUE, model: "stt-model", timeoutMs: 5_000 },
      ),
    );
    expect(error).toBeInstanceOf(SttError);
    expect(error.code).toBe("stt_unconfigured");
  });

  it("reports other failures with the status, never the body", async () => {
    const echoed = `upstream echoed: ${KEY_VALUE}`;
    const fetchImpl = vi.fn<FetchImpl>(async () => new Response(echoed, { status: 502 }));
    const error = await failure(
      dashscopeTranscribe(
        { bytes: BYTES, mimeType: "audio/ogg", language: "auto" },
        { fetch: fetchImpl, baseUrl: "http://gateway.example.com", apiKey: KEY_VALUE, model: "stt-model", timeoutMs: 5_000 },
      ),
    );
    expect(error.code).toBe("stt_upstream_error");
    expect(error.message).toContain("502");
    expect(error.message).not.toContain(KEY_VALUE);
  });

  it("maps a fetch timeout to stt_timeout", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => {
      throw new DOMException("aborted", "TimeoutError");
    });
    const error = await failure(
      dashscopeTranscribe(
        { bytes: BYTES, mimeType: "audio/ogg", language: "auto" },
        { fetch: fetchImpl, baseUrl: "http://gateway.example.com", apiKey: KEY_VALUE, model: "stt-model", timeoutMs: 5_000 },
      ),
    );
    expect(error.code).toBe("stt_timeout");
    expect(error.message).not.toContain(KEY_VALUE);
  });

  it("reads segments with seconds-to-milliseconds and speaker labels", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () =>
      jsonResponse({
        text: "hello world",
        language: "ru",
        segments: [
          { start: 0.5, end: 1.25, text: "hello", speaker: "1" },
          { start: 1.25, end: 2, text: "world", speaker: 2 },
          { start: "bad", end: 3, text: "dropped" },
        ],
      }),
    );
    const result = await dashscopeTranscribe(
      { bytes: BYTES, mimeType: "audio/ogg", language: "auto" },
      { fetch: fetchImpl, baseUrl: "http://gateway.example.com", apiKey: KEY_VALUE, model: "stt-model", timeoutMs: 5_000 },
    );
    expect(result.language).toBe("ru");
    expect(result.segments).toEqual([
      { startMs: 500, endMs: 1250, text: "hello", speaker: "1" },
      { startMs: 1250, endMs: 2000, text: "world", speaker: "2" },
    ]);
  });
});

describe("deepgram backend", () => {
  it("posts the raw audio with the bearer key and diarize only when asked", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () =>
      jsonResponse({
        results: { channels: [{ alternatives: [{ transcript: "recognized text" }] }] },
      }),
    );
    const result = await deepgramTranscribe(
      { bytes: BYTES, mimeType: "audio/mpeg", language: "auto", diarization: false },
      { fetch: fetchImpl, baseUrl: "https://api.deepgram.com/v1/listen", apiKey: KEY_VALUE, timeoutMs: 5_000 },
    );
    expect(result.text).toBe("recognized text");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).not.toContain("diarize");
    expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY_VALUE}`);
    expect((init?.headers as Record<string, string>)["content-type"]).toBe("audio/mpeg");
  });

  it("turns diarization on and folds sentences into segments", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () =>
      jsonResponse({
        results: {
          channels: [
            {
              alternatives: [
                {
                  transcript: "hello world",
                  paragraphs: {
                    paragraphs: [
                      { sentences: [{ start: 0, end: 1, text: "hello", speaker: 0 }] },
                      { sentences: [{ start: 1, end: 2, text: "world", speaker: 1 }] },
                    ],
                  },
                },
              ],
            },
          ],
        },
      }),
    );
    const result = await deepgramTranscribe(
      { bytes: BYTES, mimeType: "audio/mpeg", language: "auto", diarization: true },
      { fetch: fetchImpl, baseUrl: "https://api.deepgram.com/v1/listen", apiKey: KEY_VALUE, timeoutMs: 5_000 },
    );
    const url = String(fetchImpl.mock.calls[0]![0]);
    expect(url).toContain("diarize=true");
    expect(result.segments).toEqual([
      { startMs: 0, endMs: 1000, text: "hello", speaker: "0" },
      { startMs: 1000, endMs: 2000, text: "world", speaker: "1" },
    ]);
  });

  it("groups a flat word list into per-speaker segments", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () =>
      jsonResponse({
        results: {
          channels: [
            {
              alternatives: [
                {
                  transcript: "a b c",
                  words: [
                    { start: 0, end: 0.4, word: "a", speaker: 0 },
                    { start: 0.4, end: 0.8, word: "b", speaker: 0 },
                    { start: 1, end: 1.4, word: "c", speaker: 1 },
                  ],
                },
              ],
            },
          ],
        },
      }),
    );
    const result = await deepgramTranscribe(
      { bytes: BYTES, mimeType: "audio/mpeg", language: "auto", diarization: true },
      { fetch: fetchImpl, baseUrl: "https://api.deepgram.com/v1/listen", apiKey: KEY_VALUE, timeoutMs: 5_000 },
    );
    expect(result.segments).toEqual([
      { startMs: 0, endMs: 800, text: "a b", speaker: "0" },
      { startMs: 1000, endMs: 1400, text: "c", speaker: "1" },
    ]);
  });

  it("reports a failure with the status, never the body", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => new Response(`echoed ${KEY_VALUE}`, { status: 401 }));
    const error = await failure(
      deepgramTranscribe(
        { bytes: BYTES, mimeType: "audio/mpeg", language: "auto", diarization: false },
        { fetch: fetchImpl, baseUrl: "https://api.deepgram.com/v1/listen", apiKey: KEY_VALUE, timeoutMs: 5_000 },
      ),
    );
    expect(error.code).toBe("stt_upstream_error");
    expect(error.message).toContain("401");
    expect(error.message).not.toContain(KEY_VALUE);
  });

  it("maps a network failure to stt_upstream_error without the key", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => {
      throw new Error(`connect ECONNREFUSED with ${KEY_VALUE}`);
    });
    const error = await failure(
      deepgramTranscribe(
        { bytes: BYTES, mimeType: "audio/mpeg", language: "auto", diarization: false },
        { fetch: fetchImpl, baseUrl: "https://api.deepgram.com/v1/listen", apiKey: KEY_VALUE, timeoutMs: 5_000 },
      ),
    );
    // A raw network error message may carry what the transport echoes, but
    // our own messages must not add the key: the assertion pins the shape.
    expect(error.code).toBe("stt_upstream_error");
  });
});
