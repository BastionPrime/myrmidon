// Maintenance mode settings (MYRMIDON_MAINTENANCE_*). See docs/myrmidon/SETTINGS.md.

function readInt(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) return fallback;
  return value;
}

export const MAX_DRAIN_TIMEOUT_SEC = 86_400;

export interface MaintenanceSettings {
  defaultDrainTimeoutSec: number;
  tickMs: number;
  cacheTtlMs: number;
}

export function readMaintenanceSettings(env: NodeJS.ProcessEnv = process.env): MaintenanceSettings {
  return {
    defaultDrainTimeoutSec: readInt(env, "MYRMIDON_MAINTENANCE_DRAIN_TIMEOUT_SEC", 900, 0, MAX_DRAIN_TIMEOUT_SEC),
    tickMs: readInt(env, "MYRMIDON_MAINTENANCE_TICK_SEC", 5, 1, 3600) * 1000,
    cacheTtlMs: readInt(env, "MYRMIDON_MAINTENANCE_CACHE_TTL_SEC", 5, 0, 3600) * 1000,
  };
}
