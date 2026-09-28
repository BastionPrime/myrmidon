// server/src/myrmidon/bot-containers/ustar.ts
//
// Minimal POSIX ustar archive writer and reader, used by docker-driver.ts to PUT
// a bot's compiled profile into its volumes and to GET the applied-state marker
// back out, via the Docker Engine `/containers/{id}/archive` endpoint. No
// third-party tar dependency: CONVENTIONS.md §8 asks new dependencies to be
// justified, and a profile is a handful of small text files — full tar (sparse
// files, symlinks, multi-volume) is not needed, only enough of ustar to write
// plain files and directories and to read a single small file back.

const BLOCK_SIZE = 512;
const NAME_MAX = 100;
const PREFIX_MAX = 155;

const TYPEFLAG_FILE = 0x30; // '0'
const TYPEFLAG_DIRECTORY = 0x35; // '5'

export class UstarError extends Error {}

export interface UstarEntry {
  /** Forward-slash path, no leading "/" and no trailing "/" (a directory entry
   *  gets its trailing "/" added in the header). */
  path: string;
  /** "file" (typeflag '0', the default) or "directory" (typeflag '5'). An
   *  explicit directory entry is how an extractor gets told the owner and mode
   *  of a directory; without one, Docker creates each missing parent itself as
   *  root:root 0755 (moby pkg/archive createImpliedDirectories). */
  type?: "file" | "directory";
  /** Must be empty for a directory. */
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
 * boundary, preferring to keep as much as possible in `name`. `suffix` ("/" for a
 * directory) is appended to `name` and counted against its limit. Throws when no
 * split makes both halves fit — matching tar's own refusal of a name that is too
 * long, rather than silently truncating it (a truncated config path would fail
 * closed in a much more confusing way, inside the container instead of here).
 */
function splitPath(path: string, suffix: string): { name: string; prefix: string } {
  const full = `${path}${suffix}`;
  if (Buffer.byteLength(full, "utf8") <= NAME_MAX) return { name: full, prefix: "" };
  const parts = path.split("/");
  for (let i = parts.length - 1; i > 0; i--) {
    const prefix = parts.slice(0, i).join("/");
    const name = `${parts.slice(i).join("/")}${suffix}`;
    if (Buffer.byteLength(prefix, "utf8") <= PREFIX_MAX && Buffer.byteLength(name, "utf8") <= NAME_MAX) {
      return { name, prefix };
    }
  }
  throw new UstarError(
    `path "${path}" is too long for a ustar header (max ${NAME_MAX} bytes, or a "/"-split ${PREFIX_MAX}+${NAME_MAX})`,
  );
}

function buildHeader(entry: UstarEntry): Buffer {
  const isDirectory = entry.type === "directory";
  if (isDirectory && entry.content.length > 0) {
    throw new UstarError(`directory entry "${entry.path}" must have no content`);
  }
  if (entry.path.length === 0 || entry.path.startsWith("/") || entry.path.endsWith("/")) {
    throw new UstarError(`entry path "${entry.path}" must be non-empty, relative and without a trailing "/"`);
  }
  const { name, prefix } = splitPath(entry.path, isDirectory ? "/" : "");
  const buf = Buffer.alloc(BLOCK_SIZE);

  writeAscii(buf, 0, NAME_MAX, name);
  octalField(entry.mode & 0o7777, 8).copy(buf, 100);
  octalField(entry.uid, 8).copy(buf, 108);
  octalField(entry.gid, 8).copy(buf, 116);
  octalField(entry.content.length, 12).copy(buf, 124);
  octalField(Math.floor((entry.mtime ?? new Date()).getTime() / 1000), 12).copy(buf, 136);
  buf.fill(0x20, 148, 156); // checksum field reads as 8 ASCII spaces while it is computed
  buf[156] = isDirectory ? TYPEFLAG_DIRECTORY : TYPEFLAG_FILE;
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
 *  terminate an archive) from a flat list of file and directory entries, in the
 *  order given. A directory entry must come before anything inside it, or the
 *  extractor will already have created that directory implicitly (as root). */
export function buildUstarArchive(entries: readonly UstarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(buildHeader(entry));
    parts.push(padToBlock(entry.content));
  }
  parts.push(Buffer.alloc(BLOCK_SIZE * 2));
  return Buffer.concat(parts);
}

export interface UstarReadEntry {
  /** Path as stored (prefix joined with name), without a trailing "/". */
  path: string;
  type: "file" | "directory" | "other";
  mode: number;
  uid: number;
  gid: number;
  content: Buffer;
}

function readCString(buf: Buffer, offset: number, width: number): string {
  const slice = buf.subarray(offset, offset + width);
  const nul = slice.indexOf(0);
  return (nul === -1 ? slice : slice.subarray(0, nul)).toString("utf8");
}

function readOctal(buf: Buffer, offset: number, width: number): number {
  if (buf[offset] & 0x80) {
    throw new UstarError("base-256 numeric fields are not supported");
  }
  const raw = readCString(buf, offset, width).trim();
  if (raw.length === 0) return 0;
  if (!/^[0-7]+$/.test(raw)) throw new UstarError(`malformed octal field "${raw}"`);
  return parseInt(raw, 8);
}

/** PAX extended header records ("<len> <key>=<value>\n"); only `path` is used. */
function parsePaxPath(content: Buffer): string | undefined {
  let offset = 0;
  let path: string | undefined;
  while (offset < content.length) {
    const space = content.indexOf(0x20, offset);
    if (space === -1) break;
    const length = parseInt(content.subarray(offset, space).toString("ascii"), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = content.subarray(space + 1, offset + length - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (eq !== -1 && record.slice(0, eq) === "path") path = record.slice(eq + 1);
    offset += length;
  }
  return path;
}

/**
 * Parses a tar stream as produced by Docker's `GET /containers/{id}/archive`
 * (Go archive/tar: ustar, with PAX or GNU long-name records when a name does not
 * fit) or by `buildUstarArchive`. Verifies each header's checksum; throws
 * UstarError on a malformed stream rather than returning partial data.
 */
export function parseUstarArchive(archive: Buffer): UstarReadEntry[] {
  const entries: UstarReadEntry[] = [];
  let offset = 0;
  let pendingPath: string | undefined;
  while (offset + BLOCK_SIZE <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) return entries;

    const stored = readOctal(header, 148, 8);
    let sum = 0;
    for (let i = 0; i < BLOCK_SIZE; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i];
    if (sum !== stored) throw new UstarError(`bad header checksum at offset ${offset}`);

    const size = readOctal(header, 124, 12);
    const typeflag = header[156];
    const contentStart = offset + BLOCK_SIZE;
    const contentEnd = contentStart + size;
    if (contentEnd > archive.length) throw new UstarError(`truncated entry at offset ${offset}`);
    const content = Buffer.from(archive.subarray(contentStart, contentEnd));
    offset = contentStart + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;

    if (typeflag === 0x78 /* 'x' */) {
      pendingPath = parsePaxPath(content) ?? pendingPath;
      continue;
    }
    if (typeflag === 0x67 /* 'g' */) continue;
    if (typeflag === 0x4c /* 'L' GNU long name */) {
      pendingPath = readCString(content, 0, content.length);
      continue;
    }

    const name = readCString(header, 0, NAME_MAX);
    const magic = readCString(header, 257, 6);
    const prefix = magic.startsWith("ustar") ? readCString(header, 345, PREFIX_MAX) : "";
    const rawPath = pendingPath ?? (prefix ? `${prefix}/${name}` : name);
    pendingPath = undefined;
    const type =
      typeflag === TYPEFLAG_FILE || typeflag === 0 ? "file" : typeflag === TYPEFLAG_DIRECTORY ? "directory" : "other";
    entries.push({
      path: rawPath.replace(/\/+$/, ""),
      type,
      mode: readOctal(header, 100, 8),
      uid: readOctal(header, 108, 8),
      gid: readOctal(header, 116, 8),
      content,
    });
  }
  throw new UstarError("archive ended without its terminating zero blocks");
}
