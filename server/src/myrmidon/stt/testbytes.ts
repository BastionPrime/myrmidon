// server/src/myrmidon/stt/testbytes.ts (test helper, imported by the suites)
//
// myrmidon(1.6.1 VOICE-STT A1): builders of tiny but structurally valid
// OGG/Opus and MPEG audio for the chunking tests — no real audio, no keys,
// neutral data only.

const OGG_CRC = Array.from({ length: 256 }, (_, index) => {
  let crc = index << 24;
  for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ (crc < 0 ? 0x04c11db7 : 0);
  return crc >>> 0;
});

function crc32(bytes: Uint8Array, from: number, to: number): number {
  let crc = 0;
  for (let at = from; at < to; at++) {
    const byte = at >= from + 22 && at < from + 26 ? 0 : bytes[at]!;
    crc = ((crc << 8) ^ OGG_CRC[((crc >>> 24) ^ byte) & 255]!) >>> 0;
  }
  return crc >>> 0;
}

/** One Opus packet of a 20 ms, single-channel, SILK 20 ms configuration (TOC 0x0c). */
const OPUS_PACKET = new Uint8Array([0x0c, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

/**
 * An OGG/Opus stream of `pages` audio pages (plus the OpusHead page), each
 * audio page carrying `packetsPerPage` packets.
 */
export function buildOggOpus(pages: number, packetsPerPage = 25): Uint8Array {
  const chunks: Uint8Array[] = [];
  const pushPage = (sequence: number, payload: Uint8Array, flags: number, segmentTable: number[]) => {
    const header = new Uint8Array(27 + segmentTable.length);
    header.set([0x4f, 0x67, 0x67, 0x53, 0, flags], 0); // "OggS", version 0
    // serial number 0x12345678, page 0..n
    header[14] = 0x78;
    header[15] = 0x56;
    header[16] = 0x34;
    header[17] = 0x12;
    header[18] = sequence & 255;
    header[19] = (sequence >>> 8) & 255;
    header[20] = (sequence >>> 16) & 255;
    header[21] = (sequence >>> 24) & 255;
    header[26] = segmentTable.length;
    header.set(segmentTable, 27);
    const page = new Uint8Array(header.length + payload.length);
    page.set(header, 0);
    page.set(payload, header.length);
    const crc = crc32(page, 0, page.length);
    page[22] = crc & 255;
    page[23] = (crc >>> 8) & 255;
    page[24] = (crc >>> 16) & 255;
    page[25] = (crc >>> 24) & 255;
    chunks.push(page);
  };

  // OpusHead: magic, version 1, 1 channel, preskip 0 at 16..17, then the rest.
  const head = new Uint8Array(19);
  head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0); // "OpusHead"
  head[8] = 1;
  head[9] = 1;
  // head[10..11] preskip 0, head[12..15] sample rate 48000, head[16..17] gain 0, head[18] mapping 0
  head[12] = 0x80;
  head[13] = 0xbb;
  pushPage(0, head, 2, [head.length]); // BOS; one segment of exactly the head size
  for (let page = 1; page <= pages; page++) {
    const payload = new Uint8Array(OPUS_PACKET.length * packetsPerPage);
    for (let i = 0; i < packetsPerPage; i++) payload.set(OPUS_PACKET, i * OPUS_PACKET.length);
    pushPage(page, payload, page === pages ? 4 : 0, Array.from({ length: packetsPerPage }, () => OPUS_PACKET.length));
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** An MPEG Layer III frame (128 kbps, 44100 Hz, no payload bits set). */
function mpegFrame(): Uint8Array {
  const frame = new Uint8Array(417);
  frame[0] = 0xff;
  frame[1] = 0xfb; // MPEG-1 Layer III, no CRC
  frame[2] = 0x90; // 128 kbps, 44100 Hz
  frame[3] = 0x00;
  return frame;
}

/** An MPEG audio stream of `frames` frames (~26.12 ms each at 128 kbps/44100 Hz). */
export function buildMpeg(frames: number): Uint8Array {
  const frame = mpegFrame();
  const out = new Uint8Array(frame.length * frames);
  for (let i = 0; i < frames; i++) out.set(frame, i * frame.length);
  return out;
}

/** TOC byte of the 20 ms SILK NB configuration, for the packet-duration tests. */
export const OPUS_20MS_TOC = 0x0c;
