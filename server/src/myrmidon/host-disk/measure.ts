import fs from "node:fs/promises";
import path from "node:path";

/**
 * Filesystem usage of the host disk (myrmidon BOT-DISK, part E).
 *
 * `statfs` reports capacity and free bytes of the filesystem that holds the
 * given directory. In a container the mount namespace of the server process is
 * the host's for the data volume (the board's database and workspaces live in
 * bind-mounted host directories), so this is the fill level an operator must
 * see before the disk is full. When the process runs somewhere whose
 * `statfs` is unavailable or fails, the measurement fails and the sweep logs
 * it once; a missing measurement never raises a signal.
 */

export interface HostDiskUsage {
  /** Directory the usage was measured for. */
  path: string;
  usedBytes: number;
  totalBytes: number;
  freeBytes: number;
  /** `usedBytes / totalBytes * 100`, rounded to a whole percent. */
  usedPercent: number;
}

export async function readHostDiskUsage(directory: string): Promise<HostDiskUsage | null> {
  let stats;
  try {
    stats = await fs.statfs(directory);
  } catch {
    return null;
  }
  const totalBytes = Number(stats.blocks) * Number(stats.bsize);
  const freeBytes = Number(stats.bavail) * Number(stats.bsize);
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return null;
  const usedBytes = Math.max(0, totalBytes - freeBytes);
  return {
    path: directory,
    usedBytes,
    totalBytes,
    freeBytes,
    usedPercent: Math.min(100, Math.max(0, Math.round((usedBytes / totalBytes) * 100))),
  };
}

/**
 * Apparent size of one directory, capped the same way the workspace
 * measurement is capped (`measureWorkspaceSize`): a bounded number of entries,
 * a bounded depth and a bounded wall time, never following a symlink. The
 * number is a lower bound for a directory the walk could not finish, which is
 * fine for a ranking of the biggest consumers.
 */
export const HOST_DISK_CONSUMER_DEFAULT_MAX_ENTRIES = 30_000;
export const HOST_DISK_CONSUMER_DEFAULT_MAX_DEPTH = 8;
export const HOST_DISK_CONSUMER_DEFAULT_MAX_MS = 3_000;

export interface HostDiskConsumerMeasurement {
  sizeBytes: number;
  truncated: boolean;
}

export interface MeasureHostDiskConsumerOptions {
  maxEntries?: number;
  maxDepth?: number;
  maxMs?: number;
  now?: () => number;
}

export async function measureHostDiskConsumer(
  directory: string,
  options: MeasureHostDiskConsumerOptions = {},
): Promise<HostDiskConsumerMeasurement> {
  const maxEntries = options.maxEntries ?? HOST_DISK_CONSUMER_DEFAULT_MAX_ENTRIES;
  const maxDepth = options.maxDepth ?? HOST_DISK_CONSUMER_DEFAULT_MAX_DEPTH;
  const maxMs = options.maxMs ?? HOST_DISK_CONSUMER_DEFAULT_MAX_MS;
  const now = options.now ?? (() => Date.now());
  const startedAt = now();

  let sizeBytes = 0;
  let entries = 0;
  let truncated = false;
  const hardLinkKeys = new Set<string>();

  const directories: Array<{ absolutePath: string; depth: number }> = [
    { absolutePath: directory, depth: 0 },
  ];

  walk: while (directories.length > 0) {
    const directoryEntry = directories.pop()!;
    let dirents;
    try {
      dirents = await fs.readdir(directoryEntry.absolutePath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of dirents) {
      entries += 1;
      if (entries > maxEntries) {
        truncated = true;
        break walk;
      }
      if (entries % 256 === 0 && now() - startedAt > maxMs) {
        truncated = true;
        break walk;
      }
      const absolutePath = path.join(directoryEntry.absolutePath, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (directoryEntry.depth + 1 > maxDepth) {
          truncated = true;
          continue;
        }
        directories.push({ absolutePath, depth: directoryEntry.depth + 1 });
        continue;
      }
      let stats;
      try {
        stats = await fs.lstat(absolutePath);
      } catch {
        continue;
      }
      if (!stats.isFile()) continue;
      if (stats.nlink > 1) {
        const key = `${stats.dev}:${stats.ino}`;
        if (hardLinkKeys.has(key)) continue;
        hardLinkKeys.add(key);
      }
      sizeBytes += stats.size;
    }
  }

  return { sizeBytes, truncated };
}
