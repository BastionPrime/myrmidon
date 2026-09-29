// myrmidon(W2b): pure helpers for the "Container" section of the agent card.
//
// The card stores `adapterConfig.container = { enabled, image, memoryMb, cpus,
// pidsLimit, group? }`. The server reads it in
// server/src/myrmidon/bot-containers/agent-config.ts and only requires the numbers
// to be positive; the ranges below are the UI's own sanity bounds (they keep a
// typo like an extra zero from asking the host for terabytes), not server rules.

export const BOT_CONTAINER_DEFAULTS = { memoryMb: 2048, cpus: 1, pidsLimit: 512 } as const;

export type BotContainerNumberField = "memoryMb" | "cpus" | "pidsLimit";

interface NumberFieldSpec {
  label: string;
  unit: string;
  min: number;
  max: number;
  integer: boolean;
}

export const BOT_CONTAINER_NUMBER_FIELDS: Record<BotContainerNumberField, NumberFieldSpec> = {
  memoryMb: { label: "Memory", unit: "MB", min: 128, max: 262_144, integer: true },
  cpus: { label: "CPU", unit: "cores", min: 0.1, max: 128, integer: false },
  pidsLimit: { label: "Process limit", unit: "processes", min: 16, max: 65_536, integer: true },
};

export type BotContainerCard = Record<string, unknown>;

/** The stored `container` block as a plain object; anything else reads as empty. */
export function readBotContainerCard(value: unknown): BotContainerCard {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as BotContainerCard;
}

export type NumberParse = { ok: true; value: number } | { ok: false; message: string };

export function describeNumberRange(field: BotContainerNumberField): string {
  const spec = BOT_CONTAINER_NUMBER_FIELDS[field];
  return spec.integer
    ? `a whole number from ${spec.min} to ${spec.max}`
    : `a number from ${spec.min} to ${spec.max} (up to 2 decimals)`;
}

/** Parses what a person typed. Plain decimal notation only: no exponent, sign or
 *  thousands separator, so what is stored is what was read on screen. */
export function parseBotContainerNumber(field: BotContainerNumberField, text: string): NumberParse {
  const spec = BOT_CONTAINER_NUMBER_FIELDS[field];
  const trimmed = text.trim();
  const shape = spec.integer ? /^\d+$/ : /^\d+(\.\d{1,2})?$/;
  const value = shape.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isFinite(value) || value < spec.min || value > spec.max) {
    return { ok: false, message: `Enter ${describeNumberRange(field)}.` };
  }
  return { ok: true, value };
}

/** Whether a stored value is one the fields would accept, so a card edited by
 *  hand (or by an agent) with an out-of-range number is flagged instead of hidden. */
export function isStoredNumberValid(field: BotContainerNumberField, value: unknown): value is number {
  return typeof value === "number" && parseBotContainerNumber(field, String(value)).ok;
}

/** Turning the section on writes explicit numbers: the server refuses a card
 *  without them, and a default that only exists in the UI would not be applied. */
export function enableBotContainer(card: BotContainerCard): BotContainerCard {
  const next: BotContainerCard = { ...card, enabled: true };
  for (const field of Object.keys(BOT_CONTAINER_DEFAULTS) as BotContainerNumberField[]) {
    if (typeof next[field] !== "number") next[field] = BOT_CONTAINER_DEFAULTS[field];
  }
  return next;
}

/** Turning it off keeps the rest, so switching back on restores the settings. */
export function disableBotContainer(card: BotContainerCard): BotContainerCard | undefined {
  // A card that never had the section stays exactly as it was.
  if (Object.keys(card).length === 0) return undefined;
  return { ...card, enabled: false };
}

/** Sets or clears a text field. An empty value removes the key: the server treats
 *  any present `group` (even "") as a request for a shared container. */
export function setBotContainerText(card: BotContainerCard, field: "image" | "group", text: string): BotContainerCard {
  const next: BotContainerCard = { ...card };
  const trimmed = text.trim();
  if (trimmed) next[field] = trimmed;
  else delete next[field];
  return next;
}

export function setBotContainerNumber(card: BotContainerCard, field: BotContainerNumberField, value: number): BotContainerCard {
  return { ...card, [field]: value };
}

/** What is wrong with the edited card (missing image, values outside the UI's
 *  ranges, a shared group), in the order the fields appear. Empty when the card
 *  is complete. Shown as a warning: saving stays possible, the card just will not
 *  be applied until it is fixed. */
export function botContainerProblems(card: BotContainerCard): string[] {
  if (card.enabled !== true) return [];
  const problems: string[] = [];
  if (typeof card.image !== "string" || card.image.trim().length === 0) problems.push("Image is required.");
  for (const field of Object.keys(BOT_CONTAINER_NUMBER_FIELDS) as BotContainerNumberField[]) {
    if (!isStoredNumberValid(field, card[field])) {
      problems.push(`${BOT_CONTAINER_NUMBER_FIELDS[field].label} must be ${describeNumberRange(field)}.`);
    }
  }
  if (card.group !== undefined && card.group !== null) {
    problems.push("Shared containers (Group) are not supported yet: leave Group empty.");
  }
  return problems;
}
