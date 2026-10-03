/**
 * Shared mount configuration for instances
 */
export interface SharedMountSettings {
  /** Whether shared mount feature is enabled for this instance */
  enabled: boolean;
  /** Host path for the shared directory (defaults to MYRMIDON_BOT_VOLUME_ROOT/shared) */
  hostPath?: string;
  /** Whether bots can write to the shared directory */
  writable?: boolean;
  /** Allowlist of bot IDs that can access the shared directory */
  allowedBots?: string[];
}