/**
 * X8 settings contract (agent-chat-bridge).
 *
 * Number parsing follows the same rule as `readContinuationHistoryLimit`
 * (../continuation-history-limit.ts): unset or blank falls back to the
 * default, and anything that is not a non-negative integer also falls back
 * to the default rather than being clamped or rejected.
 */

export const TELEGRAM_DM_CONVERSATIONS_ENV = "MYRMIDON_TELEGRAM_DM_CONVERSATIONS";

/**
 * Whether the standing-conversation bridge applies to a given Telegram
 * endpoint. `MYRMIDON_TELEGRAM_DM_CONVERSATIONS` is a comma-separated list
 * of endpoint ids, or `*` for every endpoint. List entries are trimmed and
 * empty entries are dropped, so `"a, ,b"` behaves like `"a,b"`. Unset or
 * blank means off for every endpoint.
 */
export function telegramDmConversationsEnabled(
  endpointId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env[TELEGRAM_DM_CONVERSATIONS_ENV]?.trim();
  if (!raw) return false;
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return entries.includes("*") || entries.includes(endpointId);
}

export const CROSS_CHANNEL_MESSAGES_ENV = "MYRMIDON_CHAT_CROSS_CHANNEL_MESSAGES";
export const CROSS_CHANNEL_MESSAGE_CHARS_ENV = "MYRMIDON_CHAT_CROSS_CHANNEL_MESSAGE_CHARS";
export const CROSS_CHANNEL_TOTAL_CHARS_ENV = "MYRMIDON_CHAT_CROSS_CHANNEL_TOTAL_CHARS";
export const CROSS_CHANNEL_LOOKBACK_HOURS_ENV = "MYRMIDON_CHAT_CROSS_CHANNEL_LOOKBACK_HOURS";

export const DEFAULT_CROSS_CHANNEL_MESSAGES = 12;
export const DEFAULT_CROSS_CHANNEL_MESSAGE_CHARS = 600;
export const DEFAULT_CROSS_CHANNEL_TOTAL_CHARS = 4000;
export const DEFAULT_CROSS_CHANNEL_LOOKBACK_HOURS = 168;

export interface CrossChannelSettings {
  messages: number;
  messageChars: number;
  totalChars: number;
  lookbackHours: number;
}

function readNonNegativeInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : fallback;
}

/**
 * Non-numeric or negative values fall back to the default; `messages: 0`
 * disables cross-channel awareness (the other three still parse, they are
 * just unused by a caller that checks `messages` first).
 */
export function readCrossChannelSettings(
  env: NodeJS.ProcessEnv = process.env,
): CrossChannelSettings {
  return {
    messages: readNonNegativeInt(env, CROSS_CHANNEL_MESSAGES_ENV, DEFAULT_CROSS_CHANNEL_MESSAGES),
    messageChars: readNonNegativeInt(
      env,
      CROSS_CHANNEL_MESSAGE_CHARS_ENV,
      DEFAULT_CROSS_CHANNEL_MESSAGE_CHARS,
    ),
    totalChars: readNonNegativeInt(env, CROSS_CHANNEL_TOTAL_CHARS_ENV, DEFAULT_CROSS_CHANNEL_TOTAL_CHARS),
    lookbackHours: readNonNegativeInt(
      env,
      CROSS_CHANNEL_LOOKBACK_HOURS_ENV,
      DEFAULT_CROSS_CHANNEL_LOOKBACK_HOURS,
    ),
  };
}
