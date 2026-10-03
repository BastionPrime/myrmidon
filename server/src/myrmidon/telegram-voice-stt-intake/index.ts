// server/src/myrmidon/telegram-voice-stt-intake/index.ts
//
// myrmidon(1.6.1 VOICE-STT B): the intake-side of voice transcription for
// Telegram voice/audio messages.
//
// Design decision (the ordering conflict the feature asked to resolve): the
// vendor creates the task comment BEFORE attachments are downloaded, and the
// open task may fetch the comment immediately. This module resolves it by
// PREFETCH: for a Telegram turn whose media are voice/audio, the bytes are
// downloaded and transcribed BEFORE addComment, inside the same inbound
// delivery attempt, with a bounded timeout. The transcript is then part of the
// original comment body — the bot reads it as user input on the same wakeup,
// no post-fact comment edit, no second wakeup, no ordering race. The bytes are
// fetched through the attachment's own fetchData closure (the same bounded,
// authenticated SDK download path the vendor uses later in ingestAttachments);
// the prefetch result is NOT stored — after a successful transcription the
// caller still runs the vendor ingest path unchanged, so the attachment itself
// is stored exactly as before and correctness stays with the vendor lane.
//
// MIME handling mirrors the vendor: a Telegram voice note carries no MIME, so
// the container is identified from the prefetched bytes with the existing
// source-bound identifier (identifyTelegramMedia) — the same closed sniffing
// the vendor storage path applies later. A provider-declared MIME, when
// present, is normalized and used directly.
//
// Failure isolation: every STT failure is a SKIP, never a delivery failure.
// The skip code is stable and redacted (no provider payload, no secret, no
// transcript text) and is returned to the caller for the comment metadata.
// With the setting off the module returns before any byte is fetched — the
// vendor path is byte for byte.

import type { Attachment } from "chat";
import { identifyTelegramMedia } from "../../services/chat-telegram-media-intake.js";
import { telegramVoiceSttEnabled } from "./settings.js";
import {
  composeVoiceCommentBody,
  renderVoiceTranscript,
  type VoiceTranscript,
} from "./transcript.js";

/**
 * The transcription seam this module consumes. Part A1 (the shared STT core,
 * `server/src/myrmidon/stt/`) implements it with `transcribeAudio`; tests pass
 * a mock. The contract is additive-only and pinned in A1's description.
 */
export interface TelegramVoiceTranscriber {
  transcribeAudio(input: {
    companyId: string;
    bytes: Uint8Array;
    mimeType: "audio/ogg" | "audio/mpeg" | "audio/wav" | "audio/mp4";
    durationSec?: number;
  }): Promise<VoiceTranscript>;
}

/** Upper bound on one prefetch+transcribe attempt, protecting the delivery lane. */
export const VOICE_STT_PREFETCH_TIMEOUT_MS = 45_000;

/** Byte ceiling for prefetching a voice note (matches the vendor attachment bound). */
export const VOICE_STT_PREFETCH_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Stable, redacted skip codes recorded in the comment metadata. Nothing but
 * these codes leaves the module on a failure path.
 */
export type VoiceSttSkipCode =
  | "stt_disabled"
  | "stt_unconfigured"
  | "audio_too_long"
  | "audio_too_large"
  | "stt_timeout"
  | "stt_upstream_error";

export interface VoiceSttOutcome {
  /** The comment body to persist (sender text + transcript), when transcription produced text. */
  body: string | null;
  /** Redacted skip code when no transcript was attached; null on success. */
  skip: VoiceSttSkipCode | null;
}

const TIMED_OUT = Symbol("voice-stt-prefetch-timeout");

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | typeof TIMED_OUT> {
  return Promise.race([
    promise,
    new Promise<typeof TIMED_OUT>((resolve) => {
      const timer = setTimeout(() => resolve(TIMED_OUT), ms);
      // myrmidon(1.6.1 VOICE-STT B): do not hold the process open for the
      // timer; the return type of setTimeout varies by lib, check structurally.
      const maybeUnref = (timer as { unref?: () => void }).unref;
      if (typeof maybeUnref === "function") maybeUnref.call(timer);
    }),
  ]);
}

/**
 * Classify an arbitrary transcription failure into a stable skip code. Never
 * lets the error's message, stack or payload leave the failure path.
 */
export function classifyVoiceSttFailure(error: unknown): VoiceSttSkipCode {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string"
  ) {
    const code = (error as { code: string }).code;
    if (
      code === "stt_disabled" ||
      code === "stt_unconfigured" ||
      code === "audio_too_long" ||
      code === "audio_too_large" ||
      code === "stt_timeout" ||
      code === "stt_upstream_error"
    )
      return code;
  }
  return "stt_upstream_error";
}

export interface VoiceSttIntakeInput {
  companyId: string;
  /** The sender's own text (may be empty). */
  senderText: string;
  /** The voice/audio attachments of this turn, already normalized by the runtime. */
  voiceAttachments: ReadonlyArray<Attachment>;
  /** Pre-resolved environment; production reads process.env. */
  env?: NodeJS.ProcessEnv;
  transcriber: TelegramVoiceTranscriber | null;
  fetchTimeoutMs?: number;
}

function toBuffer(fetched: Uint8Array | ArrayBuffer | Buffer): Buffer {
  // myrmidon(1.6.1 VOICE-STT B): accept the view the adapter's fetchData
  // returns (a Buffer IS a Uint8Array at runtime) and a plain ArrayBuffer.
  if (Buffer.isBuffer(fetched)) return fetched;
  if (fetched instanceof Uint8Array)
    return Buffer.from(
      fetched.buffer.slice(
        fetched.byteOffset,
        fetched.byteOffset + fetched.byteLength,
      ),
    );
  return Buffer.from(fetched);
}

/**
 * Prefetch the first voice attachment's bytes, identify the container, run the
 * transcriber and build the comment body. Returns a skip outcome (never
 * throws) on any failure; the caller falls back to the vendor body.
 *
 * Only the FIRST voice attachment is transcribed: Telegram voice notes are
 * single-media turns, and the one-comment/one-wakeup contract does not gain a
 * merge lane here.
 */
export async function transcribeTelegramVoiceIntake(
  input: VoiceSttIntakeInput,
): Promise<VoiceSttOutcome> {
  if (!telegramVoiceSttEnabled(input.env)) {
    // myrmidon(1.6.1 VOICE-STT B): the guard — zero transcriber calls and
    // zero byte downloads when the setting is off.
    return { body: null, skip: "stt_disabled" };
  }
  if (!input.transcriber) {
    // myrmidon(1.6.1 VOICE-STT B): the shared core is not wired yet; until
    // part A1 lands the hook stays null and the vendor body is used.
    return { body: null, skip: "stt_unconfigured" };
  }
  const first = input.voiceAttachments[0];
  if (!first || typeof first.fetchData !== "function") {
    return { body: null, skip: "stt_unconfigured" };
  }
  const declared = first.size;
  if (
    typeof declared === "number" &&
    Number.isSafeInteger(declared) &&
    (declared <= 0 || declared > VOICE_STT_PREFETCH_MAX_BYTES)
  ) {
    return { body: null, skip: "audio_too_large" };
  }
  try {
    const timeout = input.fetchTimeoutMs ?? VOICE_STT_PREFETCH_TIMEOUT_MS;
    const fetched = await withTimeout(
      Promise.resolve().then(() => first.fetchData!()),
      timeout,
    );
    if (fetched === TIMED_OUT) {
      return { body: null, skip: "stt_timeout" };
    }
    const body = toBuffer(fetched);
    if (body.length === 0 || body.length > VOICE_STT_PREFETCH_MAX_BYTES) {
      return { body: null, skip: "audio_too_large" };
    }
    // myrmidon(1.6.1 VOICE-STT B): MIME resolution exactly like the vendor:
    // a declared MIME first, then closed byte identification for the MIME-less
    // Telegram voice note. An unidentified container is a skip, not a failure.
    const mimeType =
      normalizeVoiceMimeType(first.mimeType) ??
      voiceMimeFromBytes(first, body);
    if (!mimeType) {
      return { body: null, skip: "stt_unconfigured" };
    }
    const transcript = await withTimeout(
      input.transcriber.transcribeAudio({
        companyId: input.companyId,
        bytes: toUint8Array(body),
        mimeType,
      }),
      timeout,
    );
    if (transcript === TIMED_OUT) {
      return { body: null, skip: "stt_timeout" };
    }
    const block = renderVoiceTranscript(transcript);
    if (!block) {
      // Recognition succeeded but produced no text: the turn keeps the vendor
      // body and the skip is recorded.
      return { body: null, skip: "stt_upstream_error" };
    }
    return {
      body: composeVoiceCommentBody({
        senderText: input.senderText,
        transcriptBlock: block,
      }),
      skip: null,
    };
  } catch (error) {
    // myrmidon(1.6.1 VOICE-STT B): failure isolation — a skip, never a
    // delivery failure, and never the error's content.
    return { body: null, skip: classifyVoiceSttFailure(error) };
  }
}

function toUint8Array(body: Buffer): Uint8Array {
  return new Uint8Array(
    body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  );
}

function voiceMimeFromBytes(
  attachment: Attachment,
  body: Buffer,
): "audio/ogg" | "audio/mpeg" | "audio/mp4" | null {
  const identified = identifyTelegramMedia(attachment, body);
  if (
    identified === "audio/ogg" ||
    identified === "audio/mpeg" ||
    identified === "audio/mp4"
  )
    return identified;
  return null;
}

function normalizeVoiceMimeType(
  raw: string | undefined,
): "audio/ogg" | "audio/mpeg" | "audio/mp4" | null {
  const value = raw?.trim().toLowerCase();
  switch (value) {
    case "audio/ogg":
    case "audio/opus":
    case "application/ogg":
      return "audio/ogg";
    case "audio/mpeg":
    case "audio/mp3":
      return "audio/mpeg";
    case "audio/mp4":
    case "audio/aac":
    case "audio/x-m4a":
      return "audio/mp4";
    default:
      return null;
  }
}

export { telegramVoiceSttEnabled, TELEGRAM_VOICE_STT_ENV } from "./settings.js";
export {
  MAX_TRANSCRIPT_BLOCK_CHARS,
  composeVoiceCommentBody,
  renderVoiceTranscript,
} from "./transcript.js";
export type { VoiceTranscript } from "./transcript.js";
