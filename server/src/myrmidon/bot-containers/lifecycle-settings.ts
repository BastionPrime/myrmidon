import { z } from 'zod';

// Validation schema for bot disk lifecycle settings
const BotDiskLifecycleSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  idleTtlMs: z.number().min(5 * 60 * 1000).max(30 * 24 * 60 * 60 * 1000).optional(), // 5 min to 30 days
  defaultIdleTtlMs: z.number().optional(),
});

// Validation schema for bot disk quota settings
const BotDiskQuotaSettingsSchema = z.object({
  defaultMb: z.number().optional(),
  perBotMb: z.number().optional(),
});

// Validation schema for shared disk settings
const BotDiskSharedSettingsSchema = z.object({
  enabled: z.boolean().optional(),
});

// Validation schema for host signal settings
const BotDiskHostSignalSettingsSchema = z.object({
  thresholdPct: z.number().min(0).max(100).optional(),
  enabled: z.boolean().optional(),
});

// Combined validation schema for all bot disk settings
export const BotDiskSettingsSchema = z.object({
  lifecycle: BotDiskLifecycleSettingsSchema.optional(),
  quota: BotDiskQuotaSettingsSchema.optional(),
  shared: BotDiskSharedSettingsSchema.optional(),
  hostSignal: BotDiskHostSignalSettingsSchema.optional(),
});

export type BotDiskSettings = z.infer<typeof BotDiskSettingsSchema>;

// Default values for bot disk lifecycle settings
export const DEFAULT_BOT_DISK_LIFECYCLE_SETTINGS: z.infer<typeof BotDiskLifecycleSettingsSchema> = {
  enabled: true,
  idleTtlMs: 6 * 60 * 60 * 1000, // 6 hours in milliseconds
  defaultIdleTtlMs: 6 * 60 * 60 * 1000, // 6 hours in milliseconds
};

// Default values for bot disk quota settings
export const DEFAULT_BOT_DISK_QUOTA_SETTINGS: z.infer<typeof BotDiskQuotaSettingsSchema> = {
  defaultMb: 1024, // 1GB default
  perBotMb: 512, // 512MB per bot
};

// Default values for shared disk settings
export const DEFAULT_BOT_DISK_SHARED_SETTINGS: z.infer<typeof BotDiskSharedSettingsSchema> = {
  enabled: false,
};

// Default values for host signal settings
export const DEFAULT_BOT_DISK_HOST_SIGNAL_SETTINGS: z.infer<typeof BotDiskHostSignalSettingsSchema> = {
  thresholdPct: 80, // 80% threshold
  enabled: true,
};

// Combined default settings
export const DEFAULT_BOT_DISK_SETTINGS: BotDiskSettings = {
  lifecycle: DEFAULT_BOT_DISK_LIFECYCLE_SETTINGS,
  quota: DEFAULT_BOT_DISK_QUOTA_SETTINGS,
  shared: DEFAULT_BOT_DISK_SHARED_SETTINGS,
  hostSignal: DEFAULT_BOT_DISK_HOST_SIGNAL_SETTINGS,
};