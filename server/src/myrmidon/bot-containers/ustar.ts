// server/src/myrmidon/bot-containers/ustar.ts
//
// Minimal POSIX ustar archive writer, used by docker-driver.ts to PUT a bot's
// compiled profile into its container via the Docker Engine
// `PUT /containers/{id}/archive` endpoint. No third-party tar dependency:
// CONVENTIONS.md §8 asks new dependencies to be justified, and a profile is a
// handful of small text files — full tar (extended/PAX headers, sparse files,
// symlinks, multi-volume) is not needed, only enough of ustar to write plain files.

const BLOCK_SIZE = 512;
const NAME_MAX = 100;
const PREFIX_MAX = 155;

export class UstarError extends Error {}

export interface UstarEntry {
  /** Forward-slash path, no leading "/". */
  path: string;
  content: Buffer;
  /** POSIX permission bits, e.g. 0o600. Only the low 12 bits are kept. */
  mode: number;
  uid: number;
  gid: number;
  mtime?: Date;
}

function octalField(value: number, width: number): Buffer {
  const digits = Math.trunc(value).toString(8);
  if (digits.length > width - 1) {
    throw new UstarError(`value ${value} does not fit in a ${width - 1}-digit octal field`);
  }
  const field = Buffer.alloc(width);
  field.write(digits.padStart(width - 1, "0"), 0, "ascii");
  field[width - 1] = 0;
  return field;
}

function writeAscii(buf: Buffer, offset: number, width: number, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > width) {
    throw new UstarError(`"${value}" does not fit in ${width} bytes`);
  }
  bytes.copy(buf, offset);
}

/**
 * Splits a path into ustar's 100-byte `name` plus 155-byte `prefix` at a "/"
 * boundary, preferring to keep as much as possible in `name`. Throws when no split
 * makes both halves fit — matching tar's own refusal of a name that is too long,
 * rather than silently truncating it (a truncated config path would fail closed in
 * a much more confusing way, inside the container instead of here).
 */
function splitPath(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path, "utf8") <= NAME_MAX) return { name: path, prefix: "" };
  const parts = path.split("/");
  for (let i = parts.length - 1; i > 0; i--) {
    const prefix = parts.slice(0, i).join("/");
    const name = parts.slice(i).join("/");
    if (Buffer.byteLength(prefix, "utf8") <= PREFIX_MAX && Buffer.byteLength(name, "utf8") <= NAME_MAX) {
      return { name, prefix };
    }
  }
  throw new UstarError(
    `path "${path}" is too long for a ustar header (max ${NAME_MAX} bytes, or a "/"-split ${PREFIX_MAX}+${NAME_MAX})`,
  );
}

function buildHeader(entry: UstarEntry): Buffer {
  const { name, prefix } = splitPath(entry.path);
  const buf = Buffer.alloc(BLOCK_SIZE);

  writeAscii(buf, 0, NAME_MAX, name);
  octalField(entry.mode & 0o7777, 8).copy(buf, 100);
  octalField(entry.uid, 8).copy(buf, 108);
  octalField(entry.gid, 8).copy(buf, 116);
  octalField(entry.content.length, 12).copy(buf, 124);
  octalField(Math.floor((entry.mtime ?? new Date()).getTime() / 1000), 12).copy(buf, 136);
  buf.fill(0x20, 148, 156); // checksum field reads as 8 ASCII spaces while it is computed
  buf[156] = 0x30; // typeflag '0': regular file
  writeAscii(buf, 257, 5, "ustar"); // magic; byte 262 stays NUL as its terminator
  writeAscii(buf, 263, 2, "00"); // ustar version
  writeAscii(buf, 265, 32, "myrmidon");
  writeAscii(buf, 297, 32, "myrmidon");
  octalField(0, 8).copy(buf, 329); // devmajor
  octalField(0, 8).copy(buf, 337); // devminor
  writeAscii(buf, 345, PREFIX_MAX, prefix);

  let checksum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) checksum += buf[i];
  const checksumField = Buffer.alloc(8, 0x20);
  checksumField.write(checksum.toString(8).padStart(6, "0"), 0, "ascii");
  checksumField[6] = 0;
  checksumField.copy(buf, 148);

  return buf;
}

function padToBlock(content: Buffer): Buffer {
  const remainder = content.length % BLOCK_SIZE;
  if (remainder === 0) return content;
  return Buffer.concat([content, Buffer.alloc(BLOCK_SIZE - remainder)]);
}

/** Builds a complete tar stream (headers, padded content, the two zero blocks that
 *  terminate an archive) from a flat list of regular-file entries. Directories are
 *  created implicitly by the extractor from each entry's path. */
export function buildUstarArchive(entries: readonly UstarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(buildHeader(entry));
    parts.push(padToBlock(entry.content));
  }
  parts.push(Buffer.alloc(BLOCK_SIZE * 2));
  return Buffer.concat(parts);
}
