// server/src/myrmidon/telegram-voice-stt-intake/transcript.ts
//
// myrmidon(1.6.1 VOICE-STT B): shape of the transcript block and how it is
// rendered into an inbound task comment.
//
// Pure functions only: the caller (intake.ts) owns the fallback behavior.
// Rendering rules:
//   - the plain text goes in verbatim (already provider-redacted upstream);
//   - when the core returned per-speaker segments, the body renders them as
//     «Говорящий N [mm:ss]: …» lines as the feature contract requires;
//   - a speaker-less segment still gets its [mm:ss] timestamp;
//   - the block is capped so one huge transcript cannot blow the inbound
//     comment body budget (MAX_INBOUND_TEXT, 100k chars upstream).

export interface VoiceTranscript {
  text: string;
  segments?: ReadonlyArray<{
    speaker?: string;
    startMs: number;
    endMs: number;
    text: string;
  }>;
  language?: string;
  durationMs?: number;
  truncated: boolean;
  backend: string;
}

/** Hard cap on the transcript block, aligned with the upstream comment budget. */
export const MAX_TRANSCRIPT_BLOCK_CHARS = 90_000;

function mmss(ms: number): string {
  const total = Math.max(0, Math.trunc(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function renderSegments(
  segments: ReadonlyArray<{
    speaker?: string;
    startMs: number;
    endMs: number;
    text: string;
  }>,
): string {
  return segments
    .filter((segment) => segment.text.trim().length > 0)
    .map((segment) => {
      const stamp = mmss(segment.startMs);
      const speaker = segment.speaker?.trim();
      const body = segment.text.trim();
      // myrmidon(1.6.1 VOICE-STT B): never invent a speaker label the provider
      // did not return — a speaker-less line stays timestamped only.
      return speaker
        ? `Говорящий ${speaker} [${stamp}]: ${body}`
        : `[${stamp}]: ${body}`;
    })
    .filter((line) => line.trim().length > 0)
    .join("\n");
}

/**
 * The transcript as it is appended to the inbound comment body, or null when
 * the recognition produced no usable text (the caller then records a skip).
 */
export function renderVoiceTranscript(
  transcript: VoiceTranscript,
): string | null {
  const segments = transcript.segments?.length
    ? renderSegments(transcript.segments)
    : "";
  const plain = transcript.text.trim();
  if (!plain && !segments) return null;
  const parts = [plain, segments].filter((part) => part.length > 0);
  const body = parts.join("\n\n");
  if (!body) return null;
  // myrmidon(1.6.1 VOICE-STT B): cap the block, then mark the cut so the bot
  // and the reader know the transcript was shortened, not silent.
  if (body.length <= MAX_TRANSCRIPT_BLOCK_CHARS) return body;
  return `${body.slice(0, MAX_TRANSCRIPT_BLOCK_CHARS)}\n[transcript truncated]`;
}

/**
 * The comment body for a voice turn: the sender's own text (kept when present)
 * followed by the transcript block. The caller slices to MAX_INBOUND_TEXT.
 */
export function composeVoiceCommentBody(input: {
  senderText: string;
  transcriptBlock: string;
}): string {
  const senderText = input.senderText.trim();
  if (!senderText) return input.transcriptBlock;
  return `${senderText}\n\n${input.transcriptBlock}`;
}