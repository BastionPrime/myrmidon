// server/src/myrmidon/stt/backend-dashscope.ts
//
// myrmidon(1.6.1 VOICE-STT A1): the default backend — a speech model behind
// the shared LiteLLM gateway, called over the OpenAI-compatible audio
// transcription endpoint (`POST /v1/audio/transcriptions`, multipart file).
//
// The gateway answers `Invalid model name` for any model that is not
// registered on it; that answer becomes a stable `stt_unconfigured` so the
// callers survive the window before an operator registers the recognition
// model. Every other failure is `stt_upstream_error` with the HTTP status —
// never the body, which can echo the request.
//
// The adapter takes `fetch` as a dependency and the key for the lifetime of
// one call only; no key value reaches a message or a log line.

import { SttError } from "./types.js";
import type { SttSegment } from "./types.js";

export interface DashscopeTranscribeInput {
  bytes: Uint8Array;
  mimeType: string;
  language: "auto" | "ru";
}

export interface DashscopeTranscriptionResult {
  text: string;
  segments?: Array<{ speaker?: string; startMs: number; endMs: number; text: string }>;
  language?: string;
}

export interface DashscopeBackendDeps {
  fetch: typeof fetch;
  baseUrl: string;
  /** Read from the company's secrets for this call; never stored on the backend. */
  apiKey: string;
  model: string;
  timeoutMs: number;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

/** `/v1/audio/transcriptions` unless the configured address already ends with `/v1`. */
function transcriptionsUrl(baseUrl: string): string {
  return /\/v1$/.test(baseUrl.replace(/\/+$/, ""))
    ? joinUrl(baseUrl, "/audio/transcriptions")
    : joinUrl(baseUrl, "/v1/audio/transcriptions");
}

function secondsToMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.round(value * 1000);
  return null;
}

/** Segments from an OpenAI-style transcription answer (`segments` with `start`/`end` in seconds). */
function readSegments(payload: unknown): Array<{ speaker?: string; startMs: number; endMs: number; text: string }> | undefined {
  const segments = (payload as { segments?: unknown } | null)?.segments;
  if (!Array.isArray(segments) || segments.length === 0) return undefined;
  const parsed: Array<{ speaker?: string; startMs: number; endMs: number; text: string }> = [];
  for (const segment of segments) {
    if (typeof segment !== "object" || segment === null) continue;
    const record = segment as { start?: unknown; end?: unknown; text?: unknown; speaker?: unknown };
    const startMs = secondsToMs(record.start);
    const endMs = secondsToMs(record.end);
    if (startMs === null || endMs === null || typeof record.text !== "string") continue;
    const entry: { speaker?: string; startMs: number; endMs: number; text: string } = {
      startMs,
      endMs,
      text: record.text,
    };
    if (typeof record.speaker === "string" && record.speaker.trim() !== "") entry.speaker = record.speaker.trim();
    else if (typeof record.speaker === "number" && Number.isInteger(record.speaker)) {
      entry.speaker = String(record.speaker);
    }
    parsed.push(entry);
  }
  return parsed.length > 0 ? parsed : undefined;
}

/** True when the gateway rejected the model name (the model is not registered on it). */
function isModelNameRejection(body: string): boolean {
  const lowered = body.toLowerCase();
  return lowered.includes("invalid model name") || lowered.includes("model_not_found");
}

export async function dashscopeTranscribe(
  input: DashscopeTranscribeInput,
  deps: DashscopeBackendDeps,
): Promise<DashscopeTranscriptionResult> {
  const form = new FormData();
  const view = new Uint8Array(input.bytes.byteLength);
  view.set(input.bytes);
  form.append("file", new Blob([view], { type: input.mimeType }), "audio.ogg");
  form.append("model", deps.model);
  if (input.language !== "auto") form.append("language", input.language);
  // A prompt-free request; no response format is forced — the plain text and
  // the verbose JSON shape are both handled below.

  let response: Response;
  try {
    response = await deps.fetch(transcriptionsUrl(deps.baseUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${deps.apiKey}` },
      body: form,
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
    // The body names the model the gateway does not know — that is the
    // documented pre-registration window, not an upstream outage.
    const body = await response.text().catch(() => "");
    if (isModelNameRejection(body)) {
      throw new SttError("stt_unconfigured", `the STT model is not registered on the gateway (HTTP ${response.status})`);
    }
    throw new SttError("stt_upstream_error", `STT backend answered HTTP ${response.status}`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new SttError("stt_upstream_error", "STT backend answered with a body that is not JSON");
  }

  const record = payload as { text?: unknown; language?: unknown } | null;
  if (typeof record?.text !== "string") {
    throw new SttError("stt_upstream_error", "STT backend answer has no text");
  }
  return {
    text: record.text,
    segments: readSegments(payload),
    language: typeof record.language === "string" ? record.language : undefined,
  };
}
