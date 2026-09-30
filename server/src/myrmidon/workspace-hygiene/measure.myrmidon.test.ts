// myrmidon(WORKSPACE-HYGIENE) part C: the disk walk behind the workspace quota.
//
// Every case here builds its own small tree in a temporary directory and checks
// what the walk counted. The last cases are the reason the walk has caps at all:
// a real workspace holds node_modules with tens of thousands of entries, and a
// bad checkout can leave a symlink loop behind.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WORKSPACE_SIZE_DEFAULT_MAX_ENTRIES,
  measureWorkspaceSize,
} from "./measure.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-size-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function writeFileWithSize(relativePath: string, bytes: number): Promise<void> {
  const absolutePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, Buffer.alloc(bytes, 1));
}

describe("myrmidon(WORKSPACE-HYGIENE): measuring one workspace", () => {
  it("sums the apparent size of the files it finds, at any depth", async () => {
    await writeFileWithSize("a.txt", 1000);
    await writeFileWithSize("node_modules/pkg/index.js", 2000);
    await writeFileWithSize("src/deep/nested/dir/file.js", 500);

    const measurement = await measureWorkspaceSize(root);

    expect(measurement.sizeBytes).toBe(3500);
    expect(measurement.files).toBe(3);
    expect(measurement.truncated).toBe(false);
    expect(measurement.depthCapped).toBe(false);
  });

  it("counts a shared inode once, so hardlinked stores are not counted per workspace", async () => {
    await writeFileWithSize("store/pkg/file.js", 4096);
    await fs.link(path.join(root, "store/pkg/file.js"), path.join(root, "store/pkg/file-link.js"));

    const measurement = await measureWorkspaceSize(root);

    expect(measurement.sizeBytes).toBe(4096);
    expect(measurement.entries).toBeGreaterThanOrEqual(2);
  });

  it("measures a symlink by itself and never follows it", async () => {
    await writeFileWithSize("real/big.bin", 100_000);
    // A self-referencing link: following it would walk the same tree forever.
    await fs.symlink(root, path.join(root, "real/loop"));
    await fs.symlink(path.join(root, "real/big.bin"), path.join(root, "real/big-link.bin"));

    const measurement = await measureWorkspaceSize(root, { maxEntries: 500 });

    expect(measurement.truncated).toBe(false);
    expect(measurement.sizeBytes).toBeGreaterThanOrEqual(100_000);
    expect(measurement.sizeBytes).toBeLessThan(100_000 + 4096);
  });

  it("stops at the entry cap and reports the measurement as a lower bound", async () => {
    for (let index = 0; index < 300; index += 1) {
      await writeFileWithSize(`many/file-${index}.js`, 10);
    }

    const measurement = await measureWorkspaceSize(root, { maxEntries: 50 });

    expect(measurement.truncated).toBe(true);
    expect(measurement.entries).toBeLessThanOrEqual(51);
    expect(measurement.sizeBytes).toBeLessThanOrEqual(3000);
  });

  it("stops descending at the depth cap on a deep tree", async () => {
    const levels = Array.from({ length: 40 }, (_, index) => `level-${index}`);
    await writeFileWithSize(path.join(...[...levels, "deep.txt"].join("/")), 700);

    const measurement = await measureWorkspaceSize(root, { maxDepth: 5 });

    expect(measurement.depthCapped).toBe(true);
    expect(measurement.sizeBytes).toBe(0);
    expect(measurement.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("stops at the time cap even when the entries keep coming", async () => {
    for (let index = 0; index < 500; index += 1) {
      await writeFileWithSize(`slow/file-${index}.js`, 10);
    }
    let tick = 0;
    const now = () => {
      tick += 10;
      return tick;
    };

    const measurement = await measureWorkspaceSize(root, { maxEntries: 10_000, maxMs: 5, now });

    expect(measurement.truncated).toBe(true);
    expect(measurement.entries).toBeLessThan(500);
  });

  it("returns an empty measurement for a path it cannot read instead of throwing", async () => {
    const missing = await measureWorkspaceSize(path.join(root, "does-not-exist"));
    expect(missing).toMatchObject({ sizeBytes: 0, entries: 0, truncated: false });

    await writeFileWithSize("not-a-directory.txt", 10);
    const asFile = await measureWorkspaceSize(path.join(root, "not-a-directory.txt"));
    expect(asFile.sizeBytes).toBe(0);
  });

  it("keeps its default caps where the file list keeps them", () => {
    // The walk runs on the shared scheduler tick: the cap belongs to the same
    // order of magnitude as the workspace file list's scan cap.
    expect(WORKSPACE_SIZE_DEFAULT_MAX_ENTRIES).toBeGreaterThan(0);
    expect(WORKSPACE_SIZE_DEFAULT_MAX_ENTRIES).toBeLessThanOrEqual(50_000);
  });
});