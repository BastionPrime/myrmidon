// myrmidon(PARALLEL-HELPERS): pure helpers for the "Parallel helpers" section
// of the agent card.
//
// The card stores `adapterConfig.parallelHelpers = { enabled, maxConcurrent,
// model, childTurnBudget }`. The server resolves it against a company-level
// ceiling (packages/shared/src/myrmidon-parallel-helpers.ts); the bounds below
// are the UI's own sanity bounds, mirroring the shared module's — they keep a
// typo from asking for an absurd fan-out, they do not invent policy.

import {
  HELPER_TURN_BUDGET_MAX,
  HELPER_TURN_BUDGET_MIN,
} from "@paperclipai/shared";

export type BotParallelHelpersCard = Record<string, unknown>;

/** The stored `parallelHelpers` block as a plain object; anything else reads as empty. */
export function readParallelHelpersCard(value: unknown): BotParallelHelpersCard {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as BotParallelHelpersCard;
}

export type HelpersNumberParse = { ok: true; value: number } | { ok: false; message: string };

const LIMIT_MIN = 1;
/** The server clamps to the company ceiling anyway; this only rejects nonsense. */
const LIMIT_MAX = 50;

export function parseHelpersLimit(text: string): HelpersNumberParse {
  const trimmed = text.trim();
  const value = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isFinite(value) || value < LIMIT_MIN || value > LIMIT_MAX) {
    return { ok: false, message: `Enter a whole number from ${LIMIT_MIN} to ${LIMIT_MAX}.` };
  }
  return { ok: true, value };
}

export function parseHelpersTurnBudget(text: string): HelpersNumberParse {
  const trimmed = text.trim();
  const value = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isFinite(value) || value < HELPER_TURN_BUDGET_MIN || value > HELPER_TURN_BUDGET_MAX) {
    return {
      ok: false,
      message: `Enter a whole number from ${HELPER_TURN_BUDGET_MIN} to ${HELPER_TURN_BUDGET_MAX}, or empty for the default.`,
    };
  }
  return { ok: true, value };
}

/**
 * Turning the section on writes an explicit limit: the server resolves an
 * absent one to the company default, and a default that only exists in the UI
 * would hide what the card actually says. The limit is kept when the section
 * is turned back on (so toggling off/on restores the settings), matching the
 * Container section's behavior.
 */
export function enableParallelHelpers(card: BotParallelHelpersCard, defaultLimit: number): BotParallelHelpersCard {
  const next: BotParallelHelpersCard = { ...card, enabled: true };
  if (typeof next.maxConcurrent !== "number") next.maxConcurrent = defaultLimit;
  return next;
}

/** Turning it off keeps the rest, so switching back on restores the settings. */
export function disableParallelHelpers(card: BotParallelHelpersCard): BotParallelHelpersCard | undefined {
  // A card that never had the section stays exactly as it was.
  if (Object.keys(card).length === 0) return undefined;
  return { ...card, enabled: false };
}

/** Sets or clears a string field (the helper model). Empty removes the key:
 *  an unset model means "inherit the parent agent's model". */
export function setHelpersText(
  card: BotParallelHelpersCard,
  key: "model",
  value: string,
): BotParallelHelpersCard {
  const next = { ...card };
  const trimmed = value.trim();
  if (trimmed) next[key] = trimmed;
  else delete next[key];
  return next;
}

/** Sets or clears a number field. An empty value removes the key so the server
 *  default applies; a stored out-of-range number is replaced, not flagged here
 *  (the server clamps). */
export function setHelpersNumber(
  card: BotParallelHelpersCard,
  key: "maxConcurrent" | "childTurnBudget",
  value: number | undefined,
): BotParallelHelpersCard {
  const next = { ...card };
  if (typeof value === "number" && Number.isFinite(value)) next[key] = value;
  else delete next[key];
  return next;
}
