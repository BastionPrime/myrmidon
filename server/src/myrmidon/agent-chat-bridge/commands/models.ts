// myrmidon(X8c): the "which value can this chat pick" toolkit shared by
// /model and /think — candidate lists, argument resolution and formatting.

import { listAdapterModels } from "../../../adapters/registry.js";
import { ADAPTER_SPECIAL_MODEL_VALUES } from "../../agent-model-validation.js";
import type { BridgedCommandAgentContext } from "./context.js";

/**
 * "default" / "auto" (ADAPTER_SPECIAL_MODEL_VALUES, agent-model-validation.ts)
 * mean "let the adapter decide" on the card — they are a valid card value,
 * not a real model name, so /model and /think must never list or report
 * them as if a specific model were chosen.
 */
function isSpecialModelValue(value: string): boolean {
  return ADAPTER_SPECIAL_MODEL_VALUES.includes(value.trim().toLowerCase());
}

export interface ChatModelCandidate {
  id: string;
  label: string;
}

export const MAX_LISTED_CHAT_MODEL_CANDIDATES = 30;

/**
 * Adapter types whose `config.model` is read on a run (design doc fact F13).
 * Kept here, not imported from each adapter, so a change to any adapter's
 * execute.ts cannot silently widen or narrow what /model claims to control.
 * `hermes_gateway` is deliberately absent until gap G4 lands (it does not
 * pass a model to the run yet).
 */
export const MODEL_OVERRIDE_ALLOWED_ADAPTER_TYPES: readonly string[] = [
  "hermes_local",
  "claude_local",
  "codex_local",
  "cursor",
  "cursor_cloud",
  "gemini_local",
  "grok_local",
  "kimi_local",
  "opencode_local",
  "pi_local",
];

/** Adapter types whose `config.effort` is honored today. */
export const THINK_OVERRIDE_ALLOWED_ADAPTER_TYPES: readonly string[] = ["hermes_local"];

/**
 * packages/adapters/hermes/src/server/myrmidon-profile-config.ts:232
 * (`HERMES_REASONING_EFFORTS`, not exported — that package is hot, see
 * docs/myrmidon/CONVENTIONS.md section 8, so the list is duplicated here).
 */
export const HERMES_REASONING_EFFORTS: readonly string[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The chat-level override's `adapterConfig`, or `{}` if there is none. */
export function readOverrideAdapterConfig(
  assigneeAdapterOverrides: Record<string, unknown> | null,
): Record<string, unknown> {
  const config = assigneeAdapterOverrides?.adapterConfig;
  return isRecord(config) ? config : {};
}

function readStringField(config: Record<string, unknown>, key: string): string | null {
  const value = config[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** A named field's value, or null when unset or one of the "let the adapter decide" sentinels. */
function readSpecificModelField(config: Record<string, unknown>, key: string): string | null {
  const value = readStringField(config, key);
  return value && !isSpecialModelValue(value) ? value : null;
}

/** The card's own value for this key, or the literal "adapter default" when the card sets none. */
export function describeCardValue(
  cardAdapterConfig: Record<string, unknown>,
  key: "model" | "effort",
): string {
  return readSpecificModelField(cardAdapterConfig, key) ?? "adapter default";
}

/** The value this chat actually uses right now, and who decided it. */
export function describeEffectiveChatValue(
  overrideAdapterConfig: Record<string, unknown>,
  cardAdapterConfig: Record<string, unknown>,
  key: "model" | "effort",
): { value: string; source: "this chat" | "agent default" | "adapter default" } {
  const override = readSpecificModelField(overrideAdapterConfig, key);
  if (override) return { value: override, source: "this chat" };
  const card = readSpecificModelField(cardAdapterConfig, key);
  return card ? { value: card, source: "agent default" } : { value: "adapter default", source: "adapter default" };
}

function readModelFallbacks(cardAdapterConfig: Record<string, unknown>): string[] {
  const models = cardAdapterConfig.models;
  if (!isRecord(models)) return [];
  const fallbacks = models.fallbacks;
  if (!Array.isArray(fallbacks)) return [];
  return fallbacks.filter(
    (entry): entry is string =>
      typeof entry === "string" && entry.trim().length > 0 && !isSpecialModelValue(entry),
  );
}

/** Model names this chat can choose from: card model, its fallbacks, then the adapter's list — deduplicated, in that order. */
export async function listModelCandidates(
  adapterType: string,
  cardAdapterConfig: Record<string, unknown>,
): Promise<ChatModelCandidate[]> {
  const seen = new Set<string>();
  const candidates: ChatModelCandidate[] = [];
  const push = (id: string, label: string) => {
    const trimmedId = id.trim();
    if (!trimmedId || seen.has(trimmedId)) return;
    seen.add(trimmedId);
    candidates.push({ id: trimmedId, label: label.trim() || trimmedId });
  };

  const cardModel = readSpecificModelField(cardAdapterConfig, "model");
  if (cardModel) push(cardModel, cardModel);
  for (const fallback of readModelFallbacks(cardAdapterConfig)) push(fallback, fallback);

  let discovered: { id: string; label: string }[] = [];
  try {
    discovered = await listAdapterModels(adapterType);
  } catch {
    // Model discovery failing must not make /model unusable; fall back to the card's own values.
    discovered = [];
  }
  for (const entry of discovered) {
    const id = entry.id ?? "";
    if (!id || isSpecialModelValue(id)) continue;
    push(id, entry.label ?? id);
  }

  return candidates;
}

/** Reasoning levels this chat can choose from — a fixed list, independent of the card. */
export function listThinkCandidates(): ChatModelCandidate[] {
  return HERMES_REASONING_EFFORTS.map((level) => ({ id: level, label: level }));
}

/** Resolves a /model or /think argument: exact name (any case), 1-based index, or an unambiguous "/"-suffix. */
export function resolveChatChoiceArgument(
  candidates: ChatModelCandidate[],
  arg: string,
): ChatModelCandidate | null {
  const trimmed = arg.trim();
  if (!trimmed) return null;
  const asIndex = Number(trimmed);
  if (Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= candidates.length) {
    return candidates[asIndex - 1]!;
  }
  const lower = trimmed.toLowerCase();
  const exact = candidates.find((candidate) => candidate.id.toLowerCase() === lower);
  if (exact) return exact;
  const suffix = `/${lower}`;
  const bySuffix = candidates.filter((candidate) => candidate.id.toLowerCase().endsWith(suffix));
  return bySuffix.length === 1 ? bySuffix[0]! : null;
}

export function formatChatChoiceList(candidates: ChatModelCandidate[]): string {
  return candidates
    .slice(0, MAX_LISTED_CHAT_MODEL_CANDIDATES)
    .map((candidate, index) => `${index + 1}) ${candidate.id}`)
    .join("\n");
}

/** One of /model or /think: what it is called, which adapterConfig key it edits, and how it lists candidates. */
export interface ChatModelChooser {
  /** Lowercase noun used in prose: "model" / "reasoning effort". */
  noun: string;
  /** Capitalized label for status-style lines: "Model" / "Reasoning". */
  statusLabel: string;
  /** Command name, used in "/model"/"/think" usage hints. */
  commandName: "model" | "think";
  adapterConfigKey: "model" | "effort";
  isAllowedAdapterType: (adapterType: string) => boolean;
  listCandidates: (
    adapterType: string,
    cardAdapterConfig: Record<string, unknown>,
  ) => Promise<ChatModelCandidate[]>;
}

export const MODEL_CHOOSER: ChatModelChooser = {
  noun: "model",
  statusLabel: "Model",
  commandName: "model",
  adapterConfigKey: "model",
  isAllowedAdapterType: (adapterType) => MODEL_OVERRIDE_ALLOWED_ADAPTER_TYPES.includes(adapterType),
  listCandidates: listModelCandidates,
};

export const THINK_CHOOSER: ChatModelChooser = {
  noun: "reasoning effort",
  statusLabel: "Reasoning",
  commandName: "think",
  adapterConfigKey: "effort",
  isAllowedAdapterType: (adapterType) => THINK_OVERRIDE_ALLOWED_ADAPTER_TYPES.includes(adapterType),
  listCandidates: async () => listThinkCandidates(),
};

export interface ChooserAvailability {
  available: boolean;
  candidates: ChatModelCandidate[];
}

export async function checkChooserAvailability(
  chooser: ChatModelChooser,
  agent: BridgedCommandAgentContext,
): Promise<ChooserAvailability> {
  if (!chooser.isAllowedAdapterType(agent.adapterType)) return { available: false, candidates: [] };
  const candidates = await chooser.listCandidates(agent.adapterType, agent.adapterConfig);
  return { available: candidates.length > 0, candidates };
}

/**
 * Shared with the caller's post-resolution re-check in overrides.ts
 * (applyChatAdapterOverride's `refuseIfTurnInProgress`), so both the early
 * read here and the later, authoritative check right before the write
 * report the same refusal in the same words.
 */
export const TURN_IN_PROGRESS_TEXT = "A reply is in progress. Try again after it or send /stop.";

export type ChooserSelectionResult =
  | { kind: "set"; candidate: ChatModelCandidate }
  | { kind: "default" }
  | { kind: "error"; text: string };

/**
 * Resolves a /model or /think argument against this chat's agent: not
 * available, a reply in progress, an unknown value, "default", or a
 * resolved candidate. Does not write anything; callers apply the result.
 */
export async function resolveChooserSelection(input: {
  chooser: ChatModelChooser;
  agent: BridgedCommandAgentContext;
  arg: string;
  turnInProgress: boolean;
  checkTurnInProgress: boolean;
}): Promise<ChooserSelectionResult> {
  const availability = await checkChooserAvailability(input.chooser, input.agent);
  if (!availability.available) {
    return { kind: "error", text: `Switching the ${input.chooser.noun} is not available for this agent.` };
  }
  if (input.checkTurnInProgress && input.turnInProgress) {
    return { kind: "error", text: TURN_IN_PROGRESS_TEXT };
  }
  const trimmed = input.arg.trim();
  if (trimmed.toLowerCase() === "default") {
    return { kind: "default" };
  }
  const candidate = resolveChatChoiceArgument(availability.candidates, trimmed);
  if (!candidate) {
    return {
      kind: "error",
      text: `Unknown ${input.chooser.noun} "${trimmed}".\n${formatChatChoiceList(availability.candidates)}`,
    };
  }
  return { kind: "set", candidate };
}
