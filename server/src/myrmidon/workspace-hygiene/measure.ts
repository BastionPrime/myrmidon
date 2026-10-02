import fs from "node:fs/promises";
import path from "node:path";

/**
 * Disk size of one execution workspace (myrmidon WORKSPACE-HYGIENE, part C).
 *
 * A Node equivalent of `du` that cannot hang the server: the walk is limited by
 * depth, by the number of entries it looks at and by wall time, and it never
 * follows a symlink. Those three caps are the same defence the workspace file
 * list uses (`WORKSPACE_FILE_LIST_MAX_SCANNED_ENTRIES` in
 * `server/src/services/workspace-file-resources.ts`): a workspace holds
 * `node_modules` with tens of thousands of files and, after a bad checkout, a
 * symlink loop, and the sweep runs on the server's shared scheduler tick.
 *
 * What counts, and what does not:
 *
 * - regular files and symlinks count their apparent size (`stat.st_size`), not
 *   the allocated blocks, because the quota is about how much the workspace
 *   holds;
 * - a file with more than one hard link counts once. A pnpm store imported by
 *   hardlinks shares an inode across workspaces; counting every link would
 *   report the same bytes in every workspace and signal on all of them;
 * - directory inode sizes are not counted;
 * - symlinks are measured but never followed, so a link to the workspace root
 *   or to `/` cannot make the walk unbounded.
 */

/** Stop the walk after this many entries; a workspace stays measurable, not exact. */
export const WORKSPACE_SIZE_DEFAULT_MAX_ENTRIES = 20_000;
/** Stop descending at this depth; the deepest directories are counted by name only. */
export const WORKSPACE_SIZE_DEFAULT_MAX_DEPTH = 24;
/** Stop the walk after this long; a slow disk must not hold the scheduler tick. */
export const WORKSPACE_SIZE_DEFAULT_MAX_MS = 2_000;

export interface WorkspaceSizeMeasurement {
  /** Apparent size of the counted files and symlinks, in bytes. */
  sizeBytes: number;
  /** Entries the walk looked at. */
  entries: number;
  directories: number;
  files: number;
  /** True when the walk stopped at the entry or time cap: `sizeBytes` is a lower bound. */
  truncated: boolean;
  /** True when the walk stopped descending at the depth cap. */
  depthCapped: boolean;
  elapsedMs: number;
}

export interface MeasureWorkspaceSizeOptions {
  maxEntries?: number;
  maxDepth?: number;
  maxMs?: number;
  /** Clock, injected so a test can prove the time cap without waiting. */
  now?: () => number;
}

interface PendingDirectory {
  absolutePath: string;
  depth: number;
}

export async function measureWorkspaceSize(
  rootPath: string,
  options: MeasureWorkspaceSizeOptions = {},
): Promise<WorkspaceSizeMeasurement> {
  const maxEntries = options.maxEntries ?? WORKSPACE_SIZE_DEFAULT_MAX_ENTRIES;
  const maxDepth = options.maxDepth ?? WORKSPACE_SIZE_DEFAULT_MAX_DEPTH;
  const maxMs = options.maxMs ?? WORKSPACE_SIZE_DEFAULT_MAX_MS;
  const now = options.now ?? (() => Date.now());
  const startedAt = now();

  const directories: PendingDirectory[] = [{ absolutePath: rootPath, depth: 0 }];
  // Only files with a second hard link need this set: without it the map would
  // hold every file of the workspace, and only shared inodes can be double
  // counted anyway.
  const hardLinkKeys = new Set<string>();
  const measurement: WorkspaceSizeMeasurement = {
    sizeBytes: 0,
    entries: 0,
    directories: 0,
    files: 0,
    truncated: false,
    depthCapped: false,
    elapsedMs: 0,
  };

  walk: while (directories.length > 0) {
    const directory = directories.pop()!;
    let entries;
    try {
      entries = await fs.readdir(directory.absolutePath, { withFileTypes: true });
    } catch {
      // An unreadable or vanished directory contributes nothing; the rest of the
      // workspace is still measured.
      continue;
    }

    for (const entry of entries) {
      measurement.entries += 1;
      if (measurement.entries > maxEntries) {
        measurement.truncated = true;
        break walk;
      }
      if (measurement.entries % 128 === 0 && now() - startedAt > maxMs) {
        measurement.truncated = true;
        break walk;
      }

      const absolutePath = path.join(directory.absolutePath, entry.name);
      if (entry.isSymbolicLink()) {
        measurement.files += 1;
        measurement.sizeBytes += await linkOwnSize(absolutePath);
        continue;
      }
      if (entry.isDirectory()) {
        measurement.directories += 1;
        if (directory.depth + 1 > maxDepth) {
          measurement.depthCapped = true;
          continue;
        }
        directories.push({ absolutePath, depth: directory.depth + 1 });
        continue;
      }

      let stats;
      try {
        stats = await fs.lstat(absolutePath);
      } catch {
        continue;
      }
      if (!stats.isFile()) {
        measurement.files += 1;
        continue;
      }
      if (stats.nlink > 1) {
        const key = `${stats.dev}:${stats.ino}`;
        if (hardLinkKeys.has(key)) continue;
        hardLinkKeys.add(key);
      }
      measurement.files += 1;
      measurement.sizeBytes += stats.size;
    }
  }

  measurement.elapsedMs = Math.max(0, now() - startedAt);
  return measurement;
}

async function linkOwnSize(absolutePath: string): Promise<number> {
  try {
    return (await fs.lstat(absolutePath)).size;
  } catch {
    return 0;
  }
}