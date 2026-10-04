// server/src/myrmidon/stt/merge.ts
//
// myrmidon(1.6.1 VOICE-STT A1): merging the per-chunk results of the split
// back into one recording's timeline.
//
// Each chunk reports its own timings from zero; the merge shifts every
// segment by the chunk's estimated start offset, concatenates the text and
// renames the speakers into a stable, recording-global numbering so the
// transcript can say "Говорящий 1/2/…" without two chunks' "1" colliding.
//
// Speaker labels are never invented: a chunk that returned no speaker keeps
// its segments unlabeled.

import type { SttResult, SttSegment } from "./types.js";

export interface ChunkTranscription {
  text: string;
  segments?: Array<{ speaker?: string; startMs: number; endMs: number; text: string }>;
  language?: string;
}

/** Maps a chunk-local speaker label to a recording-global one, allocating on first sight. */
function speakerGrouper() {
  const map = new Map<string, string>();
  return (label: string): string => {
    const existing = map.get(label);
    if (existing) return existing;
    const next = String(map.size + 1);
    map.set(label, next);
    return next;
  };
}

/**
 * Merges chunk transcriptions that were split at the given start offsets.
 * `offsetsMs` must have the same length as `transcriptions`.
 */
export function mergeChunkResults(
  transcriptions: ChunkTranscription[],
  offsetsMs: number[],
): Pick<SttResult, "text" | "segments" | "language"> {
  const texts: string[] = [];
  const segments: SttSegment[] = [];
  const grouper = speakerGrouper();
  let language: string | undefined;
  transcriptions.forEach((chunk, index) => {
    const offset = offsetsMs[index] ?? 0;
    const trimmed = chunk.text.trim();
    if (trimmed) texts.push(trimmed);
    if (chunk.language && !language) language = chunk.language;
    for (const segment of chunk.segments ?? []) {
      const shifted: SttSegment = {
        startMs: segment.startMs + offset,
        endMs: segment.endMs + offset,
        text: segment.text,
      };
      if (segment.speaker !== undefined) shifted.speaker = grouper(`${index}:${segment.speaker}`);
      segments.push(shifted);
    }
  });
  return {
    text: texts.join(" "),
    segments,
    language,
  };
}
