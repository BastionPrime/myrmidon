// myrmidon(U1): settings for the Telegram DM status surface (1.4, п. 3).
//
// The vendor path is unchanged unless explicitly enabled: the bridged
// Telegram DM keeps suppressing routine run milestones (X8h) when the
// setting is unset, and long structured Markdown keeps going out as one
// attachment (telegram_markdown_attachment) as the vendor does.
//
// Number parsing follows the same rule as the agent-chat-bridge settings:
// unset or blank falls back to the default; anything that is not a
// non-negative integer also falls back to the default.

import { getEffectiveChannelSettings } from './channel-settings/settings.js';

/**
 * Whether the bridged Telegram DM gets an editable "working on it" status
 * message: one provider message per run that later milestones edit in place
 * (the run's final answer replaces it, as it already does for progress
 * placeholders). Off by default: deployment value, the operator enables it.
 */
export function telegramDmStatusEnabled(
  instanceSettings: any = null,
  companySettings: any = null,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const settings = getEffectiveChannelSettings(instanceSettings, companySettings, env);
  return settings.telegramDmStatus.value;
}

/**
 * How many durable inline parts a long Telegram publication may be split
 * into before it falls back to the vendor's single Markdown attachment.
 * 0 (the default) keeps the vendor behavior byte for byte; the owner
 * enables inline splitting for readability.
 */
export function telegramSplitMaxParts(
  instanceSettings: any = null,
  companySettings: any = null,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const settings = getEffectiveChannelSettings(instanceSettings, companySettings, env);
  return settings.telegramSplitMaxParts.value;
}
