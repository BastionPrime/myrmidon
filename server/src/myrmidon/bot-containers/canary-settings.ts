// myrmidon(R5-B): bot image canary settings (MYRMIDON_BOT_CANARY_*). See
// docs/myrmidon/SETTINGS.md and docs/myrmidon/design/bot-canary.md.
//
// Everything is off or neutral by default: no rollout is possible until
// MYRMIDON_BOT_CANARY=1 AND MYRMIDON_BOT_CANARY_SELECTOR names a canary bot —
// an instance that never opted in behaves exactly as before.

function readInt(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) return fallback;
  return value;
}

function readBool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

function readString(env: NodeJS.ProcessEnv, name: string): string | null {
  const raw = env[name]?.trim();
  return raw ? raw : null;
}

export interface BotCanarySettings {
  enabled: boolean;
  /** The bot key of the canary agent; null means the feature cannot run. */
  canaryBotKey: string | null;
  /** How many bots one wave rolls out. Mirrors the reconciler's concurrency bound by default. */
  waveSize: number;
  /** After this many ms in one non-terminal status the rollout aborts itself. */
  stepTimeoutMs: number;
  /** How long the canary's container must stay healthy before the smoke run. */
  healthSettleMs: number;
  /** Budget of the smoke run, ms. */
  smokeTimeoutMs: number;
  /** How often the tick reconciles the open rollout with facts. */
  tickMs: number;
  /** Digest verification: how long the registry/GitHub checks may take. */
  verifyTimeoutMs: number;
}

export function readBotCanarySettings(env: NodeJS.ProcessEnv = process.env): BotCanarySettings {
  return {
    enabled: readBool(env, "MYRMIDON_BOT_CANARY", false),
    canaryBotKey: readString(env, "MYRMIDON_BOT_CANARY_SELECTOR"),
    waveSize: readInt(env, "MYRMIDON_BOT_CANARY_WAVE_SIZE", 4, 1, 32),
    stepTimeoutMs: readInt(env, "MYRMIDON_BOT_CANARY_STEP_TIMEOUT_SEC", 1800, 60, 86_400) * 1000,
    healthSettleMs: readInt(env, "MYRMIDON_BOT_CANARY_HEALTH_SETTLE_SEC", 90, 0, 3600) * 1000,
    smokeTimeoutMs: readInt(env, "MYRMIDON_BOT_CANARY_SMOKE_TIMEOUT_SEC", 300, 10, 3600) * 1000,
    tickMs: readInt(env, "MYRMIDON_BOT_CANARY_TICK_SEC", 5, 1, 3600) * 1000,
    verifyTimeoutMs: readInt(env, "MYRMIDON_BOT_CANARY_VERIFY_TIMEOUT_SEC", 30, 1, 300) * 1000,
  };
}
