// server/src/myrmidon/stt/chunk.ts
//
// myrmidon(1.6.1 VOICE-STT A1): container sniffing and the long-recording
// split, in pure TypeScript — the server image has no ffmpeg and must not
// grow one.
//
// The two containers Telegram voice messages actually arrive in are OGG (with
// an Opus stream) and MPEG audio; the byte checks follow the same header
// walk `chat-telegram-media-intake.ts` does (oggOpus()/mp3() there). For the
// split, the same container structure is the tool:
//
//   - OGG pages are self-contained (a page carries whole packets), so a cut
//     at a page boundary leaves every chunk a valid OGG stream — the pages
//     are renumbered from 0 and the CRCs recomputed.
//   - MPEG audio is a frame train; a cut at a frame boundary keeps every
//     chunk decodable.
//
// The chunk duration is *estimated* from the Opus header (20 ms packets are
// the Telegram norm) or the MPEG frame sizes; the estimate is good enough to
// pick a cut point, and the provider's own timing is what the merged result
// reports. WAV and MP4 are not split (the provider takes them whole); a
// container that does not parse is sent whole in one call and the caller
// marks that in the metadata.

import type { SttAudioMime } from "./types.js";

const OGG_CRC = Array.from({ length: 256 }, (_, index) => {
  let crc = index << 24;
  for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ (crc < 0 ? 0x04c11db7 : 0);
  return crc >>> 0;
});

function oggCrc(bytes: Uint8Array, from: number, to: number): number {
  let crc = 0;
  for (let at = from; at < to; at++) {
    const byte = at >= from + 22 && at < from + 26 ? 0 : bytes[at]!;
    crc = ((crc << 8) ^ OGG_CRC[((crc >>> 24) ^ byte) & 255]!) >>> 0;
  }
  return crc >>> 0;
}

/** One OGG page: its byte range in the source, and what the splitter needs from it. */
export interface OggPage {
  start: number;
  end: number;
  /** Sequence number as stored. */
  sequence: number;
  /** Header page (an `OpusHead`), the first page of a logical stream. */
  header: boolean;
  /** Start-of-stream page. */
  bos: boolean;
  /** End-of-stream page. */
  eos: boolean;
  /** Payload byte size (sum of the segment table). */
  payloadSize: number;
}

/**
 * Walks the OGG page chain and returns the pages, or null when the bytes are
 * not a single well-formed OGG stream (bad capture pattern, torn page, mixed
 * serial numbers). Bounded: at most 65536 pages are walked.
 */
export function parseOggPages(bytes: Uint8Array): OggPage[] | null {
  const pages: OggPage[] = [];
  let offset = 0;
  let serial: number | undefined;
  const view = bytes;
  while (offset < bytes.length) {
    if (pages.length >= 65536) return null;
    if (
      offset + 27 > bytes.length ||
      String.fromCharCode(view[offset]!, view[offset + 1]!, view[offset + 2]!, view[offset + 3]!) !== "OggS" ||
      view[offset + 4] !== 0
    )
      return null;
    const flags = view[offset + 5]!;
    const segments = view[offset + 26]!;
    if (flags > 7 || !segments || offset + 27 + segments > bytes.length) return null;
    const storedSequence =
      view[offset + 18]! | (view[offset + 19]! << 8) | (view[offset + 20]! << 16) | (view[offset + 21]! << 24);
    if (pages.length > 0 && storedSequence !== (pages[pages.length - 1]!.sequence + 1) >>> 0) {
      // Sequence numbers must advance by exactly one per page.
      return null;
    }
    if (pages.length === 0) {
      serial =
        view[offset + 14]! | (view[offset + 15]! << 8) | (view[offset + 16]! << 16) | (view[offset + 17]! << 24);
    } else {
      const current =
        view[offset + 14]! | (view[offset + 15]! << 8) | (view[offset + 16]! << 16) | (view[offset + 17]! << 24);
      if (serial !== current) return null;
    }
    let size = 0;
    for (let i = 0; i < segments; i++) size += view[offset + 27 + i]!;
    const end = offset + 27 + segments + size;
    if (end > bytes.length) return null;
    const storedCrc =
      (bytes[offset + 22]! | (bytes[offset + 23]! << 8) | (bytes[offset + 24]! << 16) | (bytes[offset + 25]! << 24)) >>> 0;
    if (oggCrc(bytes, offset, end) !== storedCrc) {
      return null;
    }
    const page: OggPage = {
      start: offset,
      end,
      sequence:
        view[offset + 18]! | (view[offset + 19]! << 8) | (view[offset + 20]! << 16) | (view[offset + 21]! << 24),
      header: pages.length === 0,
      bos: (flags & 2) !== 0,
      eos: (flags & 4) !== 0,
      payloadSize: size,
    };
    pages.push(page);
    if (page.eos) {
      return end === bytes.length ? pages : null;
    }
    offset = end;
  }
  return null; // A stream must end with an EOS page.
}

/** Reads the Opus packet duration (ms) from the first audio packet of an OGG/Opus stream, or null. */
export function opusPacketDurationMs(bytes: Uint8Array, pages: OggPage[]): number | null {
  // The TOC byte of the first *audio* packet — the header page carries
  // "OpusHead", not a packet, so the first audio page (pages[1]) is the one
  // whose payload starts with a TOC.
  const audio = pages[1];
  const header = pages[0];
  if (!header || !audio) return null;
  const segments = bytes[audio.start + 26]!;
  if (segments < 1) return null;
  const toc = bytes[audio.start + 27]!;
  return OPUS_CONFIG_MS[(toc >> 3) & 31] ?? 20;
}

/**
 * Packet duration in ms per Opus TOC configuration (RFC 6716 table 2).
 * Configs 0..15 are SILK/hybrid, 16..31 CELT; the frame count code in the
 * low TOC bits multiplies the per-frame duration at the packet level, so
 * the duration here is per *frame* — packets of this stream are counted
 * by the segment table, and each packet carries the frame count the TOC
 * says, which for a fixed stream is constant.
 */
const OPUS_CONFIG_MS: readonly number[] = [
  10, 20, 40, 60, // 0-3: SILK NB
  10, 20, 40, 60, // 4-7: SILK MB
  10, 20, 40, 60, // 8-11: SILK WB
  10, 20, 40, 60, // 12-15: hybrid
  2.5, 5, 10, 20, // 16-19: CELT NB
  2.5, 5, 10, 20, // 20-23: CELT MB
  2.5, 5, 10, 20, // 24-27: CELT WB
  2.5, 5, 10, 20, // 28-31: CELT SWB
];

/** One MPEG audio frame: its byte range and duration in milliseconds. */
export interface MpegFrame {
  start: number;
  end: number;
  durationMs: number;
}

const MPEG_V1_L3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG_V2_L3_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const MPEG_FREQUENCIES = [44100, 48000, 32000];

/**
 * Walks the MPEG audio frame train, or returns null when the bytes are not a
 * Layer III stream (an ID3v2 tag in front is skipped). Bounded: at most
 * 2,000,000 frames are walked.
 */
export function parseMpegFrames(bytes: Uint8Array): MpegFrame[] | null {
  let offset = 0;
  if (bytes.length >= 3 && String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!) === "ID3") {
    if (bytes.length < 10) return null;
    const size = (bytes[6]! << 21) | (bytes[7]! << 14) | (bytes[8]! << 7) | bytes[9]!;
    offset = 10 + size;
  }
  const frames: MpegFrame[] = [];
  while (offset < bytes.length) {
    if (frames.length >= 2_000_000) return null;
    if (offset + 4 > bytes.length) return null;
    if (bytes[offset] !== 255 || (bytes[offset + 1]! & 0xe0) !== 0xe0) return null;
    const version = (bytes[offset + 1]! >> 3) & 3;
    const layer = (bytes[offset + 1]! >> 1) & 3;
    const rate = (bytes[offset + 2]! >> 4) & 15;
    const sample = (bytes[offset + 2]! >> 2) & 3;
    if (version === 1 || layer !== 1 || rate === 0 || rate === 15 || sample === 3) return null;
    const bitrate =
      (version === 3 ? MPEG_V1_L3_BITRATES : MPEG_V2_L3_BITRATES)[rate]! * 1000;
    const frequency = MPEG_FREQUENCIES[sample]! / (version === 3 ? 1 : version === 2 ? 2 : 4);
    const length =
      Math.floor(((version === 3 ? 144 : 72) * bitrate) / frequency) + ((bytes[offset + 2]! >> 1) & 1);
    if (length <= 0 || offset + length > bytes.length) return null;
    frames.push({ start: offset, end: offset + length, durationMs: (1152 / frequency) * 1000 });
    offset += length;
  }
  return frames.length > 0 ? frames : null;
}

/** A sniffed, splittable container. */
export type SplittableContainer =
  | { kind: "ogg"; pages: OggPage[]; packetMs: number | null }
  | { kind: "mpeg"; frames: MpegFrame[] };

/** Sniffs the container for the split; null means "not splittable — send whole". */
export function inspectContainer(bytes: Uint8Array, mimeType: SttAudioMime): SplittableContainer | null {
  if (mimeType === "audio/ogg" || mimeType === "audio/mp4") {
    const pages = parseOggPages(bytes);
    if (!pages) return null;
    return { kind: "ogg", pages, packetMs: opusPacketDurationMs(bytes, pages) };
  }
  if (mimeType === "audio/mpeg") {
    const frames = parseMpegFrames(bytes);
    if (!frames) return null;
    return { kind: "mpeg", frames };
  }
  return null;
}

/** An estimated duration in milliseconds, from the container structure alone. */
export function estimateDurationMs(bytes: Uint8Array, mimeType: SttAudioMime): number | null {
  const container = inspectContainer(bytes, mimeType);
  if (!container) return null;
  if (container.kind === "ogg") {
    const packets = container.pages.slice(1).reduce((sum, page) => sum + segmentPackets(bytes, page), 0);
    return container.packetMs ? Math.round(packets * container.packetMs) : null;
  }
  return Math.round(container.frames.reduce((sum, frame) => sum + frame.durationMs, 0));
}

/** Number of packets a page carries: segment table entries that are not 255 (a 255 continues a packet). */
function segmentPackets(bytes: Uint8Array, page: OggPage): number {
  let packets = 0;
  let open = false;
  for (let i = 0; i < bytes[page.start + 26]!; i++) {
    const lacing = bytes[page.start + 27 + i]!;
    if (lacing < 255) {
      packets++;
      open = false;
    } else {
      open = true;
    }
  }
  return packets;
}

/** One piece of the long recording: the bytes and the offset of its start on the timeline. */
export interface SttChunk {
  bytes: Uint8Array;
  mimeType: SttAudioMime;
  /** Estimated start of the chunk in the original recording, milliseconds. */
  startMs: number;
}

/** How the split went, for the caller's metadata. */
export interface ChunkPlan {
  chunks: SttChunk[];
  /** True when the container was split; false when it was sent whole (not parseable, or short enough). */
  split: boolean;
  /** True when the container did not parse and the whole recording went as one call. */
  unparseable: boolean;
}

/**
 * Splits the recording into pieces of at most `chunkSec` seconds, or returns
 * the whole bytes as one chunk when the container is short enough or does not
 * parse (the provider then handles the duration itself).
 */
export function chunkAudio(
  bytes: Uint8Array,
  mimeType: SttAudioMime,
  chunkSec: number,
): ChunkPlan {
  const container = inspectContainer(bytes, mimeType);
  if (!container) {
    return {
      chunks: [{ bytes, mimeType, startMs: 0 }],
      split: false,
      unparseable: true,
    };
  }
  const chunkMs = chunkSec * 1000;
  if (container.kind === "ogg") {
    const packetMs = container.packetMs ?? 20;
    const boundary = planOggBoundary(container.pages, bytes, packetMs, chunkMs);
    if (boundary.length <= 1) {
      return { chunks: [{ bytes, mimeType, startMs: 0 }], split: false, unparseable: false };
    }
    const chunks: SttChunk[] = boundary.map((group) => ({
      bytes: rebuildOgg(bytes, group.pages),
      mimeType,
      startMs: Math.round(group.startPacket * packetMs),
    }));
    return { chunks, split: true, unparseable: false };
  }
  const boundary = planMpegBoundary(container.frames, chunkMs);
  if (boundary.length <= 1) {
    return { chunks: [{ bytes, mimeType, startMs: 0 }], split: false, unparseable: false };
  }
  const cumulative: number[] = [];
  let acc = 0;
  for (const frame of container.frames) {
    cumulative.push(acc);
    acc += frame.durationMs;
  }
  const chunks: SttChunk[] = boundary.map((group) => ({
    bytes: bytes.subarray(group[0]!.start, group[group.length - 1]!.end),
    mimeType,
    startMs: Math.round(cumulative[container.frames.indexOf(group[0]!)] ?? 0),
  }));
  return { chunks, split: true, unparseable: false };
}

/** Groups of pages that each stay under the chunk duration; page 0 is repeated into every group. */
function planOggBoundary(
  pages: OggPage[],
  bytes: Uint8Array,
  packetMs: number,
  chunkMs: number,
): Array<{ pages: OggPage[]; startPacket: number }> {
  const groups: Array<{ pages: OggPage[]; startPacket: number }> = [];
  let current: OggPage[] = [];
  let currentMs = 0;
  let startPacket = 0;
  let packetCount = 0;
  const first = pages[0]!;
  for (const page of pages) {
    if (page === first) continue;
    const pagePackets = segmentPackets(bytes, page);
    const pageMs = pagePackets * packetMs;
    if (current.length > 0 && currentMs + pageMs > chunkMs) {
      groups.push({ pages: [first, ...current], startPacket });
      startPacket = packetCount;
      current = [];
      currentMs = 0;
    }
    current.push(page);
    currentMs += pageMs;
    packetCount += pagePackets;
  }
  if (current.length > 0) groups.push({ pages: [first, ...current], startPacket });
  return groups;
}

/**
 * Rebuilds a valid single-stream OGG from the given pages: the header page is
 * renumbered 0, the following pages 1..n, sequence numbers, CRCs and the EOS
 * flag of the last page are recomputed.
 */
export function rebuildOgg(bytes: Uint8Array, group: OggPage[]): Uint8Array {
  const total = group.reduce((sum, page) => sum + (page.end - page.start), 0);
  const out = new Uint8Array(total);
  let at = 0;
  group.forEach((page, index) => {
    const size = page.end - page.start;
    out.set(bytes.subarray(page.start, page.end), at);
    const sequence = index;
    out[at + 18] = sequence & 255;
    out[at + 19] = (sequence >>> 8) & 255;
    out[at + 20] = (sequence >>> 16) & 255;
    out[at + 21] = (sequence >>> 24) & 255;
    const flags = index === 0 ? out[at + 5]! | 2 : index === group.length - 1 ? (out[at + 5]! & ~2) | 4 : out[at + 5]! & ~6;
    out[at + 5] = flags;
    out[at + 22] = 0;
    out[at + 23] = 0;
    out[at + 24] = 0;
    out[at + 25] = 0;
    const crc = oggCrc(out, at, at + size);
    out[at + 22] = crc & 255;
    out[at + 23] = (crc >>> 8) & 255;
    out[at + 24] = (crc >>> 16) & 255;
    out[at + 25] = (crc >>> 24) & 255;
    at += size;
  });
  return out;
}

/** Groups MPEG frames so each group stays under the chunk duration. */
function planMpegBoundary(frames: MpegFrame[], chunkMs: number): MpegFrame[][] {
  const groups: MpegFrame[][] = [];
  let current: MpegFrame[] = [];
  let currentMs = 0;
  for (const frame of frames) {
    if (current.length > 0 && currentMs + frame.durationMs > chunkMs) {
      groups.push(current);
      current = [];
      currentMs = 0;
    }
    current.push(frame);
    currentMs += frame.durationMs;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}
