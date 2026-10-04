/**
 * X8 settings contract (agent-chat-bridge).
 *
 * Number parsing follows the same rule as `readContinuationHistoryLimit`
 * (../continuation-history-limit.ts): unset or blank falls back to the
 * default, and anything that is not a non-negative integer also falls back
 * to the default rather than being clamped or rejected.
 */

import { getEffectiveChannelSettings } from '../channel-settings/settings.js';

export function telegramDmConversationsEnabled(
  endpointId: string,
  instanceSettings: any = null,
  companySettings: any = null,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const settings = getEffectiveChannelSettings(instanceSettings, companySettings, env);
  const raw = settings.telegramDmConversations.value;
  
  if (!raw) return false;
  
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
    
  return entries.includes("*") || entries.includes(endpointId);
}

/**
 * Whether the telegram DM conversations setting is configured at all: at least
 * one non-empty list entry. Unset, blank, or a list of only separators
 * (",, ,") is "not configured", and every bridge-owned side effect that
 * would otherwise touch the vendor's Telegram service path (X8e's command
 * menu calls) must stay off, so the vendor path is unchanged byte for byte.
 */
export function telegramDmConversationsConfigured(
  instanceSettings: any = null,
  companySettings: any = null,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const settings = getEffectiveChannelSettings(instanceSettings, companySettings, env);
  const raw = settings.telegramDmConversations.value;
  
  if (!raw) return false;
  
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
    
  return entries.length > 0;
}

export interface CrossChannelSettings {
  messages: number;
  messageChars: number;
  totalChars: number;
  lookbackHours: number;
}

/**
 * Non-numeric or negative values fall back to the default; `messages: 0`
 * disables cross-channel awareness (the other three still parse, they are
 * just unused by a caller that checks `messages` first).
 */
export function readCrossChannelSettings(
  instanceSettings: any = null,
  companySettings: any = null,
  env: NodeJS.ProcessEnv = process.env,
): CrossChannelSettings {
  const settings = getEffectiveChannelSettings(instanceSettings, companySettings, env);
  
  return {
    messages: settings.chatCrossChannelMessages.value,
    messageChars: settings.chatCrossChannelMessageChars.value,
    totalChars: settings.chatCrossChannelTotalChars.value,
    lookbackHours: settings.chatCrossChannelLookbackHours.value,
  };
}
