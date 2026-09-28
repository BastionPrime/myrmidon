import { describe, expect, it } from "vitest";
import { buildUstarArchive, UstarError, type UstarEntry } from "./ustar.js";

const FIXED_MTIME = new Date("2026-01-01T00:00:00Z");

function baseEntry(overrides: Partial<UstarEntry> = {}): UstarEntry {
  return {
    path: "config.yaml",
    content: Buffer.from("key: value\n", "utf8"),
    mode: 0o644,
    uid: 10001,
    gid: 10001,
    mtime: FIXED_MTIME,
    ...overrides,
  };
}

function readCString(buf: Buffer, offset: number, width: number): string {
  const slice = buf.subarray(offset, offset + width);
  const nul = slice.indexOf(0);
  return (nul === -1 ? slice : slice.subarray(0, nul)).toString("ascii");
}

function readOctal(buf: Buffer, offset: number, width: number): number {
  const raw = readCString(buf, offset, width).trim();
  return raw.length === 0 ? 0 : parseInt(raw, 8);
}

describe("buildUstarArchive", () => {
  it("writes a single-block header immediately followed by padded content and two zero blocks", () => {
    const archive = buildUstarArchive([baseEntry()]);
    const content = Buffer.from("key: value\n", "utf8");
    const paddedContentSize = 512; // 11 bytes rounds up to one 512-byte block
    expect(archive.length).toBe(512 /* header */ + paddedContentSize + 1024 /* terminator */);

    expect(readCString(archive, 0, 100)).toBe("config.yaml");
    expect(readOctal(archive, 100, 8)).toBe(0o644);
    expect(readOctal(archive, 108, 8)).toBe(10001); // uid
    expect(readOctal(archive, 116, 8)).toBe(10001); // gid
    expect(readOctal(archive, 124, 12)).toBe(content.length);
    expect(readOctal(archive, 136, 12)).toBe(Math.floor(FIXED_MTIME.getTime() / 1000));
    expect(archive[156]).toBe(0x30); // typeflag '0'
    expect(readCString(archive, 257, 6)).toBe("ustar");
    expect(readCString(archive, 263, 2)).toBe("00");
    expect(readCString(archive, 345, 155)).toBe(""); // no prefix needed

    const fileBytes = archive.subarray(512, 512 + content.length);
    expect(fileBytes.equals(content)).toBe(true);
    // rest of the padded block is zero
    expect(archive.subarray(512 + content.length, 1024).every((b) => b === 0)).toBe(true);
    // archive terminator: two 512-byte zero blocks at the end
    expect(archive.subarray(archive.length - 1024).every((b) => b === 0)).toBe(true);
  });

  it("computes the POSIX checksum (sum of all header bytes with the checksum field read as spaces)", () => {
    const archive = buildUstarArchive([baseEntry()]);
    const header = Buffer.from(archive.subarray(0, 512));
    header.fill(0x20, 148, 156);
    let expectedSum = 0;
    for (const byte of header) expectedSum += byte;

    const checksumField = archive.subarray(148, 156);
    const checksumDigits = checksumField.subarray(0, 6).toString("ascii");
    expect(parseInt(checksumDigits, 8)).toBe(expectedSum);
    expect(checksumField[6]).toBe(0); // NUL terminator
    expect(checksumField[7]).toBe(0x20); // trailing space
  });

  it("masks the mode down to 12 bits and forces the regular-file typeflag", () => {
    const archive = buildUstarArchive([baseEntry({ mode: 0o1000600 })]);
    expect(readOctal(archive, 100, 8)).toBe(0o0600);
    expect(archive[156]).toBe(0x30);
  });

  it("concatenates multiple entries back to back, each on its own 512-byte header boundary", () => {
    const a = baseEntry({ path: "a.txt", content: Buffer.from("a", "utf8") });
    const b = baseEntry({ path: "b.txt", content: Buffer.from("bb", "utf8") });
    const archive = buildUstarArchive([a, b]);
    // a: header(512) + content padded to 512 = 1024; b starts right after
    expect(readCString(archive, 1024, 100)).toBe("b.txt");
    expect(archive.length).toBe(1024 + 512 + 512 + 1024);
  });

  it("splits a path longer than 100 bytes into prefix + name at a '/' boundary", () => {
    const longDir = "a".repeat(90);
    const path = `${longDir}/config.yaml`; // 90 + 1 + 11 = 102 bytes, over NAME_MAX
    const archive = buildUstarArchive([baseEntry({ path })]);
    const name = readCString(archive, 0, 100);
    const prefix = readCString(archive, 345, 155);
    expect(name).toBe("config.yaml");
    expect(prefix).toBe(longDir);
    expect(`${prefix}/${name}`).toBe(path);
  });

  it("rejects a single path segment longer than 100 bytes with no split point", () => {
    const path = "a".repeat(150); // no "/" at all
    expect(() => buildUstarArchive([baseEntry({ path })])).toThrow(UstarError);
  });

  it("rejects a path where every '/'-split still overflows the name or prefix field", () => {
    // A 200-byte trailing segment can never fit in the 100-byte name field no
    // matter where the path is split.
    const path = `dir/${"a".repeat(200)}`;
    expect(() => buildUstarArchive([baseEntry({ path })])).toThrow(UstarError);
  });

  it("accepts a path exactly at the 100-byte name boundary without a prefix", () => {
    const path = `${"a".repeat(96)}.txt`; // exactly 100 bytes
    expect(path.length).toBe(100);
    const archive = buildUstarArchive([baseEntry({ path })]);
    expect(readCString(archive, 0, 100)).toBe(path);
    expect(readCString(archive, 345, 155)).toBe("");
  });
});
