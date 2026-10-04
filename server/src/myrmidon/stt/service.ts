// server/src/myrmidon/stt/service.ts
//
// myrmidon(1.6.1 VOICE-STT A1): one recording in, one SttResult out.
//
// The order of the steps is the whole design:
//
//   1. the settings are checked *before* any key is read or any request is
//      attempted: a disabled or unconfigured path answers `stt_disabled` /
//      `stt_unconfigured` with zero outbound requests;
//   2. the recording is checked against the limits (duration, size) — again
//      before any outbound request;
//   3. the recording is split into chunks of at most `chunkSec` seconds
//      (pure TS, no ffmpeg; a container that does not parse goes whole in
//      one call and the metadata says so);
//   4. each chunk is transcribed once — no retries: a retry would multiply a
//      slow, expensive call;
//   5. the per-chunk results are merged back onto the recording's timeline
//      (offsets from the split, speakers renumbered globally).
//
// Nothing in this file puts text, bytes or a key value into a log line or an
// error message: the messages carry codes, counts and settings names only.

import { chunkAudio, estimateDurationMs } from "./chunk.js";
import { dashscopeTranscribe } from "./backend-dashscope.js";
import { deepgramTranscribe } from "./backend-deepgram.js";
import { mergeChunkResults } from "./merge.js";
import { sttSettingsProblem, sttKeySecretEnvName, type SttSettings } from "./settings.js";
import { SttError, type SttAudioMime, type SttResult } from "./types.js";

export interface SttTranscribeInput {
  companyId: string;
  bytes: Uint8Array;
  mimeType: SttAudioMime;
  /** The producer's own duration estimate; the container's estimate is used when absent. */
  durationSec?: number;
}

export interface SttServiceDeps {
  settings: SttSettings;
  fetch: typeof fetch;
  /** Resolves the company secret named by the settings; null when it is missing. */
  readCompanyKey(companyId: string, secretName: string): Promise<string | null>;
  now?: () => number;
}

export interface SttTranscribeMetadata {
  /** Which backend produced the text (`dashscope`, `deepgram`). */
  backend: string;
  /** Bytes of the recording. */
  sizeBytes: number;
  /** Duration in ms: the producer's or the container's estimate, null when neither. */
  durationMs: number | null;
  /** Chunks the recording was split into (1 — not split). */
  chunks: number;
  /** True when the container did not parse and the whole recording went as one call. */
  unparseableContainer: boolean;
  /** True when the merged text hit the provider's per-chunk answers and the result was cut. */
  truncated: boolean;
}

export interface SttTranscribeOutcome {
  result: SttResult;
  /** Metadata only — safe for the activity journal. */
  metadata: SttTranscribeMetadata;
}

export async function transcribeAudio(input: SttTranscribeInput, deps: SttServiceDeps): Promise<SttResult> {
  const outcome = await transcribeAudioWithMetadata(input, deps);
  return outcome.result;
}

/** The same call, with the metadata the caller may journal. */
export async function transcribeAudioWithMetadata(
  input: SttTranscribeInput,
  deps: SttServiceDeps,
): Promise<SttTranscribeOutcome> {
  // 1. Settings gate — before any key read, before any request.
  const problem = sttSettingsProblem(deps.settings);
  if (problem) throw new SttError(problem.code, problem.message);

  // 2. Limits — before any request.
  const sizeBytes = input.bytes.byteLength;
  if (sizeBytes === 0) throw new SttError("stt_upstream_error", "the recording is empty");
  if (sizeBytes > deps.settings.maxBytes) {
    throw new SttError(
      "audio_too_large",
      `the recording is ${sizeBytes} bytes; the STT limit is ${deps.settings.maxBytes}`,
    );
  }
  const containerMs = estimateDurationMs(input.bytes, input.mimeType);
  const durationMs =
    typeof input.durationSec === "number" && input.durationSec > 0
      ? Math.round(input.durationSec * 1000)
      : containerMs;
  if (durationMs !== null && durationMs > deps.settings.maxDurationSec * 1000) {
    throw new SttError(
      "audio_too_long",
      `the recording is about ${Math.round(durationMs / 1000)} s; the STT limit is ${deps.settings.maxDurationSec} s`,
    );
  }

  // 3. The key, read for the lifetime of this call only.
  const secretName = deps.settings.keySecret!;
  const apiKey = await deps.readCompanyKey(input.companyId, secretName);
  if (!apiKey) {
    throw new SttError(
      "stt_unconfigured",
      `the STT API key secret "${secretName}" is not available to this company (named by ${sttKeySecretEnvName(deps.settings)})`,
    );
  }

  // 4. The split.
  const plan = chunkAudio(input.bytes, input.mimeType, deps.settings.chunkSec);

  // 5. One transcription per chunk, in order; the first failure fails the call.
  const transcriptions: Array<Awaited<ReturnType<typeof dashscopeTranscribe>>> = [];
  for (const chunk of plan.chunks) {
    const transcription =
      deps.settings.backend === "deepgram"
        ? await deepgramTranscribe(
            { bytes: chunk.bytes, mimeType: chunk.mimeType, language: deps.settings.language, diarization: deps.settings.diarization },
            { fetch: deps.fetch, baseUrl: deps.settings.baseUrl!, apiKey, timeoutMs: deps.settings.timeoutMs },
          )
        : await dashscopeTranscribe(
            { bytes: chunk.bytes, mimeType: chunk.mimeType, language: deps.settings.language },
            { fetch: deps.fetch, baseUrl: deps.settings.baseUrl!, apiKey, model: deps.settings.model!, timeoutMs: deps.settings.timeoutMs },
          );
    transcriptions.push(transcription);
  }

  // 6. The merge.
  const offsets = plan.chunks.map((chunk) => chunk.startMs);
  const merged = mergeChunkResults(transcriptions, offsets);
  const truncated = plan.unparseable && durationMs !== null && durationMs > deps.settings.timeoutMs * 1000;

  return {
    result: {
      text: merged.text,
      segments: merged.segments && merged.segments.length > 0 ? merged.segments : undefined,
      language: merged.language,
      durationMs: durationMs ?? undefined,
      truncated,
      backend: deps.settings.backend,
    },
    metadata: {
      backend: deps.settings.backend,
      sizeBytes,
      durationMs,
      chunks: plan.chunks.length,
      unparseableContainer: plan.unparseable,
      truncated,
    },
  };
}
