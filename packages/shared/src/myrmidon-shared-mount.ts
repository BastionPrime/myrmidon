import { z } from "zod";

/**
 * Shared mount configuration for instances (myrmidon 1.6.1, BOT-DISK D).
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

/**
 * The settings-side validator: `general.sharedMount` in instance settings.
 * Absent means "the shared mount is disabled" (deny by default).
 */
export const sharedMountSettingsSchema = z
  .object({
    enabled: z.boolean(),
    hostPath: z.string().min(1).optional(),
    writable: z.boolean().optional(),
    allowedBots: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type SharedMountSettingsPatch = z.infer<typeof sharedMountSettingsSchema>;