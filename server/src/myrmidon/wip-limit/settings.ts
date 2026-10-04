// server/src/myrmidon/wip-limit/settings.ts
//
// myrmidon(1.6.1-WIP-LIMIT-A): read and write `instance_settings.general.wipLimit`.
//
// The stored value is the single truth (no env fallback — the limit is a
// policy choice, not a deployment knob); an absent or malformed row means the
// feature counts but never signals (all limits null). This module is the
// database half: read the raw row, normalize it, write the canonical object
// back. The same shape the swarm-claim and autonomy settings use.

import {
  WIP_LIMIT_SETTINGS_KEY,
  normalizeWipLimitSettings,
  wipLimitSettingsSchema,
  type WipLimitSettings,
} from "@paperclipai/shared";
import type { instanceSettingsService } from "../../services/instance-settings.js";

export type WipLimitSettingsService = Pick<
  ReturnType<typeof instanceSettingsService>,
  "getGeneral" | "updateGeneral"
>;

/** Read the settings of one company (or the defaults when absent). */
export async function readWipLimitSettings(
  settings: WipLimitSettingsService,
): Promise<WipLimitSettings> {
  const general = (await settings.getGeneral()) as unknown as Record<string, unknown>;
  return normalizeWipLimitSettings(general[WIP_LIMIT_SETTINGS_KEY]);
}

/** Validate and store the full settings object (PUT semantics). */
export async function writeWipLimitSettings(
  settings: WipLimitSettingsService,
  input: WipLimitSettings,
): Promise<WipLimitSettings> {
  const parsed = wipLimitSettingsSchema.parse(input);
  await settings.updateGeneral({ [WIP_LIMIT_SETTINGS_KEY]: parsed });
  return parsed;
}

/**
 * Keep the stored key across vendor writes of `instance_settings.general` —
 * the same contract every other myrmidon general key follows.
 */
export function preserveWipLimitGeneralKey(storedGeneral: unknown): Record<string, unknown> {
  if (typeof storedGeneral !== "object" || storedGeneral === null) return {};
  const value = (storedGeneral as Record<string, unknown>)[WIP_LIMIT_SETTINGS_KEY];
  return value === undefined ? {} : { [WIP_LIMIT_SETTINGS_KEY]: value };
}
