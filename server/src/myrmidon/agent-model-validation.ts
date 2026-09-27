import { listAdapterModels } from "../adapters/registry.js";
import { unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";

/**
 * myrmidon(S4/M1): a model that is not in the adapter's model list is
 * rejected when the agent card is saved.
 *
 * The list is the one the adapter serves to the UI
 * (`GET /companies/:id/adapters/:type/models`), which includes the instance
 * admin list from `PAPERCLIP_ADAPTER_MODELS`. When the list is empty (Hermes
 * without an admin list, the process adapter) any name is accepted.
 */

/** Values that mean "let the adapter decide" and are never rejected. */
export const ADAPTER_SPECIAL_MODEL_VALUES: readonly string[] = ["default", "auto"];

/**
 * Adapters whose model list depends on something other than the adapter
 * type (provider, remote catalog) or that validate models themselves.
 */
const ADAPTERS_WITHOUT_STATIC_MODEL_LIST: readonly string[] = [
  // Validated by the adapter itself against `opencode models`, and the
  // OpenRouter catalog is provider-specific.
  "opencode_local",
  // The list depends on adapterConfig.provider.
  "paperclip_runner",
];

/** Model fields of the card (M1): single values. */
export const AGENT_CARD_MODEL_FIELDS: readonly string[] = [
  "model",
  "models.vision",
  "models.video",
  "models.stt",
  "models.tts",
];

/** Model fields of the card (M1): ordered lists. */
export const AGENT_CARD_MODEL_LIST_FIELDS: readonly string[] = ["models.fallbacks"];

function readPath(config: Record<string, unknown> | null | undefined, path: string): unknown {
  let current: unknown = config;
  for (const part of path.split(".")) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function normalizedModelNames(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && !ADAPTER_SPECIAL_MODEL_VALUES.includes(item.toLowerCase()));
}

/** Model names on the card that are new compared to the stored card. */
export function collectChangedModelNames(
  previous: Record<string, unknown> | null | undefined,
  next: Record<string, unknown> | null | undefined,
): Array<{ field: string; model: string }> {
  const changed: Array<{ field: string; model: string }> = [];
  for (const field of [...AGENT_CARD_MODEL_FIELDS, ...AGENT_CARD_MODEL_LIST_FIELDS]) {
    const before = new Set(normalizedModelNames(readPath(previous, field)));
    for (const model of normalizedModelNames(readPath(next, field))) {
      if (!before.has(model)) changed.push({ field: `adapterConfig.${field}`, model });
    }
  }
  return changed;
}

export async function assertAgentModelsKnown(input: {
  adapterType: string;
  previousAdapterConfig: Record<string, unknown> | null | undefined;
  nextAdapterConfig: Record<string, unknown> | null | undefined;
  listModels?: (adapterType: string) => Promise<Array<{ id: string }>>;
}): Promise<void> {
  if (ADAPTERS_WITHOUT_STATIC_MODEL_LIST.includes(input.adapterType)) return;
  // Switching adapters starts from an empty card: every model is new.
  const changed = collectChangedModelNames(input.previousAdapterConfig, input.nextAdapterConfig);
  if (changed.length === 0) return;

  let known: Array<{ id: string }>;
  try {
    known = await (input.listModels ?? listAdapterModels)(input.adapterType);
  } catch (err) {
    // Model discovery failing must not make every agent uneditable.
    logger.warn({ err, adapterType: input.adapterType }, "model list unavailable; skipping model validation");
    return;
  }
  if (known.length === 0) return;
  const knownIds = new Set(known.map((model) => model.id));
  const unknown = changed.filter((entry) => !knownIds.has(entry.model));
  if (unknown.length === 0) return;
  throw unprocessable(
    `Unknown model for adapter ${input.adapterType}: ${unknown
      .map((entry) => `${entry.field}="${entry.model}"`)
      .join(", ")}. Choose a model from the adapter model list.`,
    { code: "unknown_model", adapterType: input.adapterType, unknownModels: unknown },
  );
}
