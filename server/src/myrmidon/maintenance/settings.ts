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
  hookTimeoutMs: number;
}

export const MIN_TICK_MS = 1_000;

function readMs(env: NodeJS.ProcessEnv, name: string, fallbackMs: number, minMs: number, maxMs: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallbackMs;
  const valueSec = Number(raw);
  if (!Number.isInteger(valueSec) || valueSec < minMs / 1000 || valueSec > maxMs / 1000) return fallbackMs;
  return valueSec * 1000;
}

export function readMaintenanceSettings(env: NodeJS.ProcessEnv = process.env): MaintenanceSettings {
  return {
    defaultDrainTimeoutSec: readInt(env, "MYRMIDON_MAINTENANCE_DRAIN_TIMEOUT_SEC", 900, 0, MAX_DRAIN_TIMEOUT_SEC),
    tickMs: readInt(env, "MYRMIDON_MAINTENANCE_TICK_SEC", 5, 1, 3600) * 1000,
    cacheTtlMs: readInt(env, "MYRMIDON_MAINTENANCE_CACHE_TTL_SEC", 5, 0, 3600) * 1000,
    // myrmidon(HOOK-TIMEOUT): a stuck maintenance integration hook (onExited)
    // must not pin a `leaving` window (OPE-3638): the finishLeaving tail wraps
    // every hook in this timeout. Bounded by the tick interval from above.
    hookTimeoutMs: readMs(env, "MYRMIDON_MAINTENANCE_HOOK_TIMEOUT_MS", 15_000, MIN_TICK_MS, 300_000),
  };
}
