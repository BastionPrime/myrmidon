import { z } from "zod";

/**
 * Host disk usage settings and state (myrmidon BOT-DISK, part E).
 *
 * On 03.10.2026 the host disk filled to 100 % and the board fell over before
 * anything warned about it. Part E is the earliest warning: the server
 * measures the usage of the disk that hosts its own data directory every
 * sweep, keeps a short history so the growth rate per hour is visible, and
 * raises an attention signal when usage crosses a threshold.
 *
 * One value is stored in `instance_settings.general.hostDisk`:
 *
 * - `usageThresholdPercent` — the fill level that raises the signal.
 *
 * The stored object is canonical: the key present, an integer 1–99. A
 * hand-edited row that does not match is ignored as a whole, so the sweep can
 * never read a threshold it did not validate. Precedence is the same
 * three-level shape the workspace quotas use:
 *
 * - the stored settings value, when `general.hostDisk` validates;
 * - otherwise the environment variable (first-start default);
 * - otherwise the built-in default (85).
 *
 * The threshold applies live: the sweep re-reads it every measurement, so a
 * PATCH needs no restart.
 */

/** Environment variable — the first-start default threshold. */
export const HOST_DISK_ENV_KEYS = {
  usageThresholdPercent: "MYRMIDON_HOST_DISK_USAGE_THRESHOLD_PERCENT",
} as const;

export const HOST_DISK_LIMIT_KEYS = ["usageThresholdPercent"] as const;

export type HostDiskLimitKey = (typeof HOST_DISK_LIMIT_KEYS)[number];

/** Where the effective threshold came from: stored settings, the environment, or the default. */
export type HostDiskLimitSource = "settings" | "env" | "default";

/** Built-in threshold: the signal appears at 85 % full. */
export const HOST_DISK_DEFAULT_USAGE_THRESHOLD_PERCENT = 85;

/** Activity action: the disk crossed the threshold. */
export const HOST_DISK_THRESHOLD_EXCEEDED_ACTION = "host.disk_threshold_exceeded";

/** Action of a threshold change, written for every company like every instance settings write. */
export const HOST_DISK_UPDATED_ACTION = "instance.host_disk.updated";

/** A crossed threshold is signalled at most once per this window. */
export const HOST_DISK_SIGNAL_INTERVAL_MS = 6 * 60 * 60 * 1000;

export const BYTES_PER_GB = 1024 * 1024 * 1024;

/** The threshold: an integer 1–99 (0 would never fire, 100 would never help). */
const thresholdPercentSchema = z.number().int().min(1).max(99);

/** The canonical stored shape of `instance_settings.general.hostDisk`. */
export const hostDiskSettingsSchema = z
  .object({
    usageThresholdPercent: thresholdPercentSchema,
  })
  .strict();

/** Body of `PATCH /api/myrmidon/host-disk`. */
export const patchHostDiskSettingsSchema = z
  .object({
    usageThresholdPercent: thresholdPercentSchema.optional(),
  })
  .strict();

export type HostDiskSettings = z.infer<typeof hostDiskSettingsSchema>;
export type HostDiskSettingsPatch = z.infer<typeof patchHostDiskSettingsSchema>;

export interface ResolvedHostDiskSettings {
  settings: HostDiskSettings;
  sources: Record<HostDiskLimitKey, HostDiskLimitSource>;
}

/** An environment value as a threshold; a non-integer or out-of-range value is ignored. */
export function parseHostDiskThresholdValue(raw: string | undefined): number | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  const parsed = thresholdPercentSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The threshold as the environment declares it, or null when unset/invalid. */
export function readHostDiskSettingsFromEnv(
  env: Record<string, string | undefined> = {},
): number | null {
  return parseHostDiskThresholdValue(env[HOST_DISK_ENV_KEYS.usageThresholdPercent]);
}

/** The stored settings value, or null when the row holds nothing usable. */
export function normalizeHostDiskSettings(raw: unknown): HostDiskSettings | null {
  const parsed = hostDiskSettingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Effective threshold and where it came from (see the module comment). */
export function resolveHostDiskSettings(options: {
  stored?: unknown;
  env?: Record<string, string | undefined>;
} = {}): ResolvedHostDiskSettings {
  const env = options.env ?? {};
  const stored = normalizeHostDiskSettings(options.stored);
  if (stored) {
    return { settings: stored, sources: { usageThresholdPercent: "settings" } };
  }
  const fromEnv = readHostDiskSettingsFromEnv(env);
  return {
    settings: {
      usageThresholdPercent: fromEnv ?? HOST_DISK_DEFAULT_USAGE_THRESHOLD_PERCENT,
    },
    sources: {
      usageThresholdPercent: fromEnv === null ? "default" : "env",
    },
  };
}

/** A patch over the effective value, the shape that gets stored. */
export function mergeHostDiskSettings(
  base: HostDiskSettings,
  patch: HostDiskSettingsPatch,
): HostDiskSettings {
  return {
    usageThresholdPercent:
      patch.usageThresholdPercent === undefined
        ? base.usageThresholdPercent
        : patch.usageThresholdPercent,
  };
}

/** One measurement of one filesystem, as the history keeps it. */
export interface HostDiskUsageSample {
  /** ISO timestamp of the measurement. */
  measuredAt: string;
  /** Fill level, percent of capacity, rounded to a whole number. */
  usedPercent: number;
  /** Used bytes. */
  usedBytes: number;
  /** Total bytes of the filesystem. */
  totalBytes: number;
}

/** One top consumer entry: a directory on the same filesystem and its measured size. */
export interface HostDiskConsumerEntry {
  /** Absolute path of the directory. */
  path: string;
  /** Apparent size of the directory in bytes (a capped walk, a lower bound). */
  sizeBytes: number;
}

/** Bytes as whole gigabytes, the unit the signal and the API report. */
export function gigabytesFromBytes(bytes: number): number {
  return Math.max(0, Math.round(bytes / BYTES_PER_GB));
}

/**
 * Growth per hour from two samples: the bytes-per-hour slope between the
 * oldest and the newest sample. Returns null when fewer than two samples or
 * the newest is not strictly newer than the oldest (division by zero).
 */
export function hostDiskGrowthBytesPerHour(samples: HostDiskUsageSample[]): number | null {
  if (samples.length < 2) return null;
  const oldest = samples[0]!;
  const newest = samples[samples.length - 1]!;
  const elapsedMs = Date.parse(newest.measuredAt) - Date.parse(oldest.measuredAt);
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return null;
  const elapsedHours = elapsedMs / (60 * 60 * 1000);
  return (newest.usedBytes - oldest.usedBytes) / elapsedHours;
}

/** True when a measurement crosses the threshold. */
export function isHostDiskOverThreshold(usedPercent: number, thresholdPercent: number): boolean {
  return usedPercent >= thresholdPercent;
}
