// server/src/myrmidon/stt/types.ts
//
// myrmidon(1.6.1 VOICE-STT A1): the contract of the speech-to-text path,
// shared by the producers (Telegram voice and audio intake, part B) and any
// later consumer (meeting minutes, part C). Fixed with parts B and C;
// changes are additive only.
//
// Nothing in this file puts audio bytes, recognized text or a key value into
// an error message: the messages carry counts and codes, so they are safe to
// hand to a bot and to the journal.

/** Mime types the path accepts; the producer's intake has already sniffed the container. */
export type SttAudioMime = "audio/ogg" | "audio/mpeg" | "audio/wav" | "audio/mp4";

/** One recognized utterance with its position on the recording's timeline. */
export interface SttSegment {
  /** Speaker label the provider returned (`1`, `2`, ...); absent when the provider did no diarization. */
  speaker?: string;
  startMs: number;
  endMs: number;
  text: string;
}

/** The full result of one `transcribeAudio` call. */
export interface SttResult {
  text: string;
  segments?: SttSegment[];
  language?: string;
  durationMs?: number;
  truncated: boolean;
  backend: string;
}

/** Error codes of the STT path; stable, part of the contract with parts B and C. */
export type SttErrorCode =
  | "stt_disabled"
  | "stt_unconfigured"
  | "audio_too_long"
  | "audio_too_large"
  | "stt_timeout"
  | "stt_upstream_error";

/** A failure of the STT path with a stable code. The message names no key value. */
export class SttError extends Error {
  readonly code: SttErrorCode;

  constructor(code: SttErrorCode, message: string) {
    super(message);
    this.name = "SttError";
    this.code = code;
  }
}
