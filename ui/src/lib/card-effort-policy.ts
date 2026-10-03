/**
 * myrmidon(BOT-TUNING-C): per-model reasoning effort options for the card UI.
 *
 * UI twin of the server effort policy (server/src/myrmidon/effort-policy):
 * the same static per-model knowledge, mirrored so the picker only offers
 * the values the selected model accepts. When the model-provider registry
 * (cards A/D) carries `efforts`/`defaultEffort` on the model row, the caller
 * passes that entry and it wins over the static prefixes; an empty entry
 * falls back to the global Hermes list. Keep this table in sync with the
 * server module — the server validation (422) is the source of truth; the
 * picker is a convenience so a valid value never needs a round trip.
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

/** A model row's effort fields (the A/D model list contract). */
export interface ModelEffortEntry {
  /** Lowercased effort ids accepted by the model, ascending by strength. */
  readonly efforts: readonly string[];
  /** The model's own safe default; falls back to `efforts[0]` when absent. */
  readonly defaultEffort?: string;
}

/**
 * Static per-model knowledge. Keys are lowercase model name prefixes
 * matched against the bare model name (after any "provider/" prefix is
 * stripped). Longest matching prefix wins.
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

function staticEntryForModel(model: string | null | undefined): ModelEffortEntry | undefined {
  const bare = model ? bareModelName(model) : "";
  if (!bare) return undefined;
  let match: ModelEffortEntry | undefined;
  let matchLength = -1;
  for (const [prefix, entry] of MODEL_EFFORT_PREFIXES) {
    if (bare.startsWith(prefix) && prefix.length > matchLength) {
      match = entry;
      matchLength = prefix.length;
    }
  }
  return match;
}

/** The effort list accepted by a model; empty entry falls back to the global list. */
export function effortsForModel(model: string | null | undefined, entry?: ModelEffortEntry): readonly string[] {
  if (entry && entry.efforts.length > 0) return entry.efforts;
  return staticEntryForModel(model)?.efforts ?? HERMES_GLOBAL_REASONING_EFFORTS;
}

/**
 * The model's safe default effort: what an empty "Thinking effort" field
 * resolves to. A registry entry wins; without one the static table decides;
 * a model with no entry at all falls back to the global list's default.
 */
export function defaultEffortForModel(model: string | null | undefined, entry?: ModelEffortEntry): string {
  const list = effortsForModel(model, entry);
  const fromEntry = entry && entry.efforts.length > 0 ? entry.defaultEffort : undefined;
  const fromStatic = entry && entry.efforts.length > 0 ? undefined : staticEntryForModel(model)?.defaultEffort;
  return fromEntry ?? fromStatic ?? list[Math.min(1, list.length - 1)]!;
}
