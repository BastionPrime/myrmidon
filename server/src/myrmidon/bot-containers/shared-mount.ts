import fs from "fs/promises";
import path from "path";
import type { SharedMountSettings } from "@paperclipai/shared";

/**
 * Default shared mount settings
 */
export const DEFAULT_SHARED_MOUNT_SETTINGS: SharedMountSettings = {
  enabled: false,
  writable: false,
  allowedBots: [],
};

/**
 * Gets the effective shared mount settings for an instance, merging defaults
 */
export function getEffectiveSharedMountSettings(
  settings: Partial<SharedMountSettings> | undefined
): SharedMountSettings {
  return {
    ...DEFAULT_SHARED_MOUNT_SETTINGS,
    ...settings,
    allowedBots: settings?.allowedBots ?? DEFAULT_SHARED_MOUNT_SETTINGS.allowedBots,
  };
}

/**
 * Checks if a bot is allowed to access the shared directory
 */
export function isBotAllowedSharedAccess(botId: string, settings: SharedMountSettings): boolean {
  if (!settings.enabled) {
    return false;
  }
  
  // If no allowlist is specified, all bots are allowed
  if (!settings.allowedBots || settings.allowedBots.length === 0) {
    return true;
  }
  
  return settings.allowedBots.includes(botId);
}

/**
 * Gets the host path for the shared directory
 */
export function getSharedMountHostPath(settings: SharedMountSettings): string {
  const volumeRoot = process.env.MYRMIDON_BOT_VOLUME_ROOT || "/var/lib/myrmidon-bots";
  return settings.hostPath || path.join(volumeRoot, "shared");
}

/**
 * Ensures the shared directory exists with proper permissions
 */
export async function ensureSharedDirectory(settings: SharedMountSettings): Promise<void> {
  if (!settings.enabled) {
    return;
  }

  const sharedPath = getSharedMountHostPath(settings);
  
  try {
    await fs.access(sharedPath);
  } catch {
    // Directory doesn't exist, create it
    await fs.mkdir(sharedPath, { recursive: true, mode: 0o755 });
  }
  
  // Set appropriate permissions
  const mode = settings.writable ? 0o770 : 0o750;
  await fs.chmod(sharedPath, mode);
}

/**
 * Migrates existing hardlink copies to the shared mount system
 * 
 * Previously, bots had individual copies of shared data using hard links.
 * This function migrates those to the unified shared directory.
 */
export async function migrateHardlinkCopies(
  botId: string,
  botVolumePath: string,
  settings: SharedMountSettings
): Promise<void> {
  if (!settings.enabled) {
    return;
  }

  const sharedPath = getSharedMountHostPath(settings);
  const botSharedPath = path.join(botVolumePath, "shared");

  // Check if bot has an old-style shared directory
  try {
    await fs.access(botSharedPath);
  } catch {
    // No old shared directory, nothing to migrate
    return;
  }

  // If the bot's shared directory is not a symlink, it's an old copy that needs migration
  const stat = await fs.lstat(botSharedPath);
  if (!stat.isSymbolicLink()) {
    // This is an old hardlink copy, we need to migrate it to the shared directory
    // The shared directory always exists after a migration (first enablement)
    await ensureSharedDirectory(settings);
    const botSharedContents = await fs.readdir(botSharedPath);
    
    if (botSharedContents.length > 0) {
      // Move contents to the shared directory
      for (const item of botSharedContents) {
        const sourcePath = path.join(botSharedPath, item);
        const destPath = path.join(sharedPath, item);
        
        try {
          // Try to move the file/directory
          await fs.rename(sourcePath, destPath);
        } catch (err) {
          console.warn(`Failed to migrate ${sourcePath} to ${destPath}:`, err);
        }
      }
    }

    // Remove the old bot-specific shared directory
    try {
      await fs.rm(botSharedPath, { recursive: true, force: true });
    } catch (err) {
      console.warn(`Failed to remove old bot shared directory ${botSharedPath}:`, err);
    }

    // Create a symlink from the bot's shared directory to the global shared directory
    try {
      await fs.symlink(sharedPath, botSharedPath, "dir");
    } catch (err) {
      console.error(`Failed to create symlink from ${botSharedPath} to ${sharedPath}:`, err);
      throw err;
    }
  }
}

/**
 * Prepares the shared mount for a specific bot based on instance settings
 */
export async function prepareBotSharedMount(
  botId: string,
  botVolumePath: string,
  settings: SharedMountSettings
): Promise<{ mountPath?: string; readOnly: boolean }> {
  if (!settings.enabled || !isBotAllowedSharedAccess(botId, settings)) {
    return { mountPath: undefined, readOnly: true };
  }

  const sharedPath = getSharedMountHostPath(settings);
  
  // Ensure the shared directory exists
  await ensureSharedDirectory(settings);
  
  // Migrate any old hardlink copies
  await migrateHardlinkCopies(botId, botVolumePath, settings);

  // Create bot-specific symlink if it doesn't exist
  const botSharedPath = path.join(botVolumePath, "shared");
  try {
    await fs.access(botSharedPath);
  } catch {
    // Create symlink to the shared directory
    await fs.symlink(sharedPath, botSharedPath, "dir");
  }

  return {
    mountPath: botSharedPath,
    readOnly: !settings.writable,
  };
}