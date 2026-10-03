// myrmidon(1.6.1 WIP-LIMIT B): pure helpers for the "WIP limit" settings
// screen and the agent badge. No React, no network — unit-testable as is.
//
// The stored row is `{ defaultLimit: number | null, perAgent: Record<agentId,
// number | null> }`: an absent per-agent key and an explicit null both mean
// "use the default". The UI never invents policy — the sanity bounds below
// only keep a typo from saving an absurd number; the server clamps the same
// range anyway.

import type { WipLimitSettings, WipLimitStatusEntry } from "./wipLimitApi";

/** UI sanity bounds, mirroring the server's (part A) clamps. */
export const WIP_LIMIT_MIN = 1;
export const WIP_LIMIT_MAX = 100;

export type WipLimitParse =
  | { ok: true; value: number | null }
  | { ok: false; message: string };

/** An empty string means "no limit" (null); anything else must be a positive integer. */
export function parseWipLimitValue(text: string): WipLimitParse {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, value: null };
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, message: "Enter a whole number, or leave it empty for no limit." };
  }
  const value = Number(trimmed);
  if (value < WIP_LIMIT_MIN || value > WIP_LIMIT_MAX) {
    return { ok: false, message: `Enter a whole number from ${WIP_LIMIT_MIN} to ${WIP_LIMIT_MAX}, or leave it empty.` };
  }
  return { ok: true, value };
}

/** The limit one agent is resolved against: its override, else the default. */
export function resolveAgentLimit(
  settings: Pick<WipLimitSettings, "defaultLimit" | "perAgent">,
  agentId: string,
): number | null {
  if (Object.prototype.hasOwnProperty.call(settings.perAgent, agentId)) {
    return settings.perAgent[agentId] ?? settings.defaultLimit;
  }
  return settings.defaultLimit;
}

/** Draft text for an input: empty when the limit is null. */
export function limitToText(limit: number | null | undefined): string {
  return typeof limit === "number" ? String(limit) : "";
}

/**
 * Set (or clear) one agent's override. Clearing an override that matches the
 * default removes the key — the row stays minimal and the agent reads as
 * "uses the default".
 */
export function setPerAgentLimit(
  settings: Pick<WipLimitSettings, "defaultLimit" | "perAgent">,
  agentId: string,
  limit: number | null,
): WipLimitSettings {
  const perAgent = { ...settings.perAgent };
  if (limit === null) {
    delete perAgent[agentId];
  } else {
    perAgent[agentId] = limit;
  }
  return { defaultLimit: settings.defaultLimit, perAgent };
}

/** `wip / limit` label text; a null limit renders without the denominator. */
export function wipBadgeText(status: Pick<WipLimitStatusEntry, "wip" | "limit">): string {
  return status.limit === null ? `${status.wip}` : `${status.wip}/${status.limit}`;
}