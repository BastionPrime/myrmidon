import { readdir, stat, rm } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Default idle TTL is 6 hours in milliseconds
const DEFAULT_IDLE_TTL_MS = 6 * 60 * 60 * 1000;

interface BotDiskLifecycleConfig {
  enabled: boolean;
  idleTtlMs: number;
  defaultIdleTtlMs: number;
}

/**
 * Checks if a directory is considered alive by looking for process group markers
 */
async function isAliveDirectory(dirPath: string): Promise<boolean> {
  // Check for run-scratch.ts markers indicating an active run
  const heartbeatMarker = join(dirPath, '.heartbeat');
  try {
    await stat(heartbeatMarker);
    return true;
  } catch {
    return false;
  }
}

/**
 * Determines if a directory is a scratch or workspace directory that should be cleaned up
 */
function isCleanupCandidate(dirPath: string): boolean {
  // Check if this is a bot volume directory containing scratch or workspace
  const pathSegments = dirPath.split('/');
  const isScratchOrWorkspace = pathSegments.includes('scratch') || pathSegments.includes('workspace');
  const isHermesDir = pathSegments.includes('hermes'); // Don't clean hermes directories
  
  return isScratchOrWorkspace && !isHermesDir;
}

/**
 * Gets the last modification time of a directory
 */
async function getLastModifiedTime(dirPath: string): Promise<number> {
  const stats = await stat(dirPath);
  return stats.mtime.getTime();
}

/**
 * Removes a directory if it's safe to do so
 */
async function safeRemoveDirectory(dirPath: string): Promise<boolean> {
  try {
    // Double-check this is a cleanup candidate before removing
    if (!isCleanupCandidate(dirPath)) {
      console.log(`Skipping removal of ${dirPath} - not a cleanup candidate`);
      return false;
    }

    console.log(`Removing directory: ${dirPath}`);
    await rm(dirPath, { recursive: true, force: true });
    return true;
  } catch (error) {
    console.error(`Failed to remove directory ${dirPath}:`, error);
    return false;
  }
}

/**
 * Sweeps a single bot volume root and cleans up stale directories
 */
export async function sweepBotVolume(
  botVolumeRoot: string,
  config: BotDiskLifecycleConfig
): Promise<void> {
  if (!config.enabled) {
    console.log('Bot disk lifecycle is disabled, skipping sweep');
    return;
  }

  try {
    const bots = await readdir(botVolumeRoot);
    
    for (const botKey of bots) {
      const botPath = join(botVolumeRoot, botKey);
      
      try {
        const botStats = await stat(botPath);
        if (!botStats.isDirectory()) {
          continue;
        }

        // Only scratch/ and workspace/ clones are cleanup candidates;
        // the hermes/ volume (memory + instructions) is never touched.
        for (const sub of ['scratch', 'workspace']) {
          const subPath = join(botPath, sub);
          try {
            const subStats = await stat(subPath);
            if (!subStats.isDirectory()) {
              continue;
            }
          } catch {
            continue; // no such subvolume on this bot
          }
          const entries = await readdir(subPath);
          for (const entry of entries) {
            const entryPath = join(subPath, entry);
            await reapIfStale(entryPath, config);
          }
        }
      } catch (error) {
        console.error(`Error processing bot volume ${botPath}:`, error);
      }
    }
  } catch (error) {
    console.error(`Error sweeping bot volume ${botVolumeRoot}:`, error);
  }
}

async function reapIfStale(dirPath: string, config: BotDiskLifecycleConfig): Promise<void> {
  if (!isCleanupCandidate(dirPath)) {
    return;
  }
  // Skip if it's currently alive (has active run markers)
  if (await isAliveDirectory(dirPath)) {
    return;
  }
  const lastModified = await getLastModifiedTime(dirPath);
  const now = Date.now();
  const idleTime = now - lastModified;
  if (idleTime > config.idleTtlMs) {
    await safeRemoveDirectory(dirPath);
  }
}

/**
 * Performs a sweep of all bot volumes in the system
 */
export async function sweepAllBotVolumes(config: BotDiskLifecycleConfig): Promise<void> {
  const botVolumeRoot = process.env.MYRMIDON_BOT_VOLUME_ROOT || '/tmp/myrmidon-bots';
  
  console.log(`Starting bot disk lifecycle sweep with TTL: ${config.idleTtlMs}ms`);
  
  await sweepBotVolume(botVolumeRoot, config);
}

/**
 * Gets the default configuration for bot disk lifecycle
 */
export function getDefaultLifecycleConfig(): BotDiskLifecycleConfig {
  return {
    enabled: true,
    idleTtlMs: DEFAULT_IDLE_TTL_MS,
    defaultIdleTtlMs: DEFAULT_IDLE_TTL_MS,
  };
}