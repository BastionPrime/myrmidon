/**
 * myrmidon(BOT-TUNING-C): per-model reasoning effort policy.
 *
 * The Hermes global effort list (none…ultra) is only a superset: a concrete
 * model accepts a subset (GLM models via the DashScope route reject
 * "medium", which silently makes the LLM gateway fall back to another model
 * on every call). This module is the single static source for the subset we
 * know today; the model-provider registry (cards part D) will later carry
 * `efforts: string[]` + `defaultEffort?` per model and this module accepts
 * that contract-shaped entry so the caller does not change shape when the
 * registry arrives.
 *
 * Contract with the compiler part: the compiler (part B) READS
 * adapterConfig.effort through `effortForModel` — it compiles the value.
 * This part only validates input (API + UI); the contract functions here are
 * the shared seam. Empty `efforts` on an entry falls back to the global
 * Hermes list.
 */

/** The global Hermes reasoning effort list (superset, ascending strength). */
export const HERMES_GLOBAL_REASONING_EFFORTS: readonly string[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];

/**
 * A model entry from the model list (the A/D card contract):
 * `efforts` is the accepted set sorted ascending by strength,
 * `defaultEffort` is the model's safe default when the card is empty.
 */
export interface ModelEffortEntry {
  /** Lowercased effort ids accepted by the model, ascending by strength. */
  readonly efforts: readonly string[];
  /** The model's own safe default; falls back to `efforts[0]` when absent. */
  readonly defaultEffort?: string;
}

/**
 * Static per-model knowledge. Keys are lowercase model name prefixes
 * matched against the bare model name (after any "provider/" prefix is
 * stripped). Extendable: longest matching prefix wins.
 */
const MODEL_EFFORT_PREFIXES: ReadonlyArray<[prefix: string, entry: ModelEffortEntry]> = [
  // Z.AI / DashScope GLM reasoning models accept low/high/max, not medium.
  ["glm-", { efforts: ["low", "high", "max"], defaultEffort: "high" }],
];

/** Strip any "provider/" prefix and lowercase. */
function bareModelName(model: string): string {
  const lowered = model.trim().toLowerCase();
  const bare = lowered.includes("/") ? lowered.split("/").pop()! : lowered;
  return bare;
}

/** The effort list accepted by a model; empty entry falls back to the global list. */
export function effortsForModel(model: string | null | undefined, entry?: ModelEffortEntry): readonly string[] {
  if (entry && entry.efforts.length > 0) return entry.efforts;
  const bare = model ? bareModelName(model) : "";
  if (bare) {
    let match: readonly string[] | null = null;
    let matchLength = -1;
    for (const [prefix, candidate] of MODEL_EFFORT_PREFIXES) {
      if (bare.startsWith(prefix) && prefix.length > matchLength) {
        match = candidate.efforts;
        matchLength = prefix.length;
      }
    }
    if (match) return match;
  }
  return HERMES_GLOBAL_REASONING_EFFORTS;
}

/** Where the resolved effort value came from. */
export type EffortSource =
  | "declared"
  /** The card value was empty and the model's default was used. */
  | "model_default"
  /** Unknown model: the card value was empty and the global default was used. */
  | "global_default"
  /** The declared value is not accepted by this model (caller decides policy). */
  | "invalid";

export interface EffortResolution {
  /** The effort value to use; empty when nothing was resolved. */
  readonly value: string | undefined;
  readonly source: EffortSource | undefined;
  /** The effort list the decision was made against. */
  readonly efforts: readonly string[];
}

/**
 * Resolve the effort for one model. Pure function, no I/O.
 *
 * - A declared value inside the model's list is returned as-is ("declared").
 * - An empty declared value resolves to the model's safe default
 *   ("model_default") or, for an unknown model, the global default
 *   ("global_default") — never a hardcoded medium.
 * - A declared value OUTSIDE the list is returned with `source: "invalid"`
 *   so API validation can reject it and the compiler can warn; the caller
 *   decides the policy (this function never rewrites a wrong value).
 */
export function effortForModel(
  model: string | null | undefined,
  declared: string | null | undefined,
  entry?: ModelEffortEntry,
): EffortResolution {
  const efforts = effortsForModel(model, entry);
  const trimmed = typeof declared === "string" ? declared.trim() : "";
  if (!trimmed) {
    // An explicit registry entry (cards part D) owns the fallback; without
    // one the STATIC prefix table decides, and only a model with no entry at
    // all falls back to the global list's safe default.
    const fromEntry = entry && entry.efforts.length > 0 ? entry.defaultEffort : undefined;
    const fromPrefix = entry && entry.efforts.length > 0 ? undefined : defaultForModelPrefix(bareModelName(model ?? ""));
    const fallback = fromEntry ?? fromPrefix ?? efforts[Math.min(1, efforts.length - 1)]!;
    if (!fallback) return { value: undefined, source: undefined, efforts };
    const source: EffortSource = fromEntry ?? fromPrefix ? "model_default" : "global_default";
    return { value: fallback, source, efforts };
  }
  const lowered = trimmed.toLowerCase();
  if (efforts.includes(lowered)) {
    return { value: lowered, source: "declared", efforts };
  }
  return { value: lowered, source: "invalid", efforts };
}

/** The static table's defaultEffort for a bare model name, when no registry entry exists. */
function defaultForModelPrefix(bare: string): string | undefined {
  let match: ModelEffortEntry | null = null;
  let matchLength = -1;
  for (const [prefix, candidate] of MODEL_EFFORT_PREFIXES) {
    if (bare.startsWith(prefix) && prefix.length > matchLength) {
      match = candidate;
      matchLength = prefix.length;
    }
  }
  return match?.defaultEffort;
}

/** True when the declared effort is inside the model's accepted list. */
export function isEffortAccepted(
  model: string | null | undefined,
  declared: string | null | undefined,
  entry?: ModelEffortEntry,
): boolean {
  return effortForModel(model, declared, entry).source !== "invalid";
}
