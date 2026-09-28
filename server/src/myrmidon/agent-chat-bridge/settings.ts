// myrmidon(X8): cross-channel awareness window (docs/myrmidon/SETTINGS.md,
// track 4). See identity.ts's header: shipped here as a standalone copy of
// the X8 contract so this PR does not depend on X8a merging first.

function readInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) return fallback;
  return value;
}

export interface CrossChannelSettings {
  /** How many of the other conversation's messages a turn may see. `0` disables it. */
  messages: number;
  /** Characters kept per quoted message. */
  messageChars: number;
  /** Characters kept for the whole quoted block. */
  totalChars: number;
  /** How far back a quoted message may be. */
  lookbackHours: number;
}

export function readCrossChannelSettings(
  env: NodeJS.ProcessEnv = process.env,
): CrossChannelSettings {
  return {
    messages: readInt(env, "MYRMIDON_CHAT_CROSS_CHANNEL_MESSAGES", 12, 0, 200),
    messageChars: readInt(env, "MYRMIDON_CHAT_CROSS_CHANNEL_MESSAGE_CHARS", 600, 1, 20_000),
    totalChars: readInt(env, "MYRMIDON_CHAT_CROSS_CHANNEL_TOTAL_CHARS", 4000, 1, 100_000),
    lookbackHours: readInt(env, "MYRMIDON_CHAT_CROSS_CHANNEL_LOOKBACK_HOURS", 168, 1, 8760),
  };
}
