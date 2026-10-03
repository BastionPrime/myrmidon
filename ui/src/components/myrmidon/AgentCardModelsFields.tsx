import { useEffect, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CollapsibleSection, Field } from "../agent-config-primitives";
import { defaultEffortForModel, effortsForModel } from "@/lib/card-effort-policy";

/**
 * myrmidon(M1): extra models on the agent card, stored as
 * `adapterConfig.models = { vision, video, stt, tts, fallbacks: [] }`.
 * The text model stays `adapterConfig.model`, the reasoning level stays the
 * vendor "Thinking effort" setting. Only model names are stored.
 *
 * myrmidon(BOT-TUNING-C): new fields wrap the compiler part B inputs —
 * `contextLength` (the model's context window in tokens, written to
 * `model.context_length`) and the auxiliary `titleGeneration` /
 * `compressionSummary` models (`auxiliary.title_generation.model` /
 * `auxiliary.compression.model`). They read and write
 * `adapterConfig.models` only.
 */
export type AgentCardModels = {
  vision?: string;
  video?: string;
  stt?: string;
  tts?: string;
  fallbacks?: string[];
  /** myrmidon(BOT-TUNING-C): explicit context window (tokens) for the card's model. */
  contextLength?: number;
  /** myrmidon(BOT-TUNING-C): model for auxiliary title generation. */
  titleGeneration?: string;
  /** myrmidon(BOT-TUNING-C): model for auxiliary compression summaries. */
  compressionSummary?: string;
};

type SingleModelKey = "vision" | "video" | "stt" | "tts";

const SINGLE_MODEL_FIELDS: ReadonlyArray<{ key: SingleModelKey; label: string; hint: string }> = [
  { key: "vision", label: "Vision model", hint: "Model for image analysis. Empty keeps the profile setting." },
  { key: "video", label: "Video model", hint: "Model for video input. Empty keeps the profile setting." },
  { key: "stt", label: "Speech-to-text model", hint: "Model for transcribing audio. Empty keeps the profile setting." },
  { key: "tts", label: "Text-to-speech model", hint: "Model for voice replies. Empty keeps the profile setting." },
];

/** myrmidon(BOT-TUNING-C): the auxiliary model fields from the card block. */
const AUXILIARY_MODEL_FIELDS: ReadonlyArray<{
  key: "titleGeneration" | "compressionSummary";
  label: string;
  hint: string;
}> = [
  {
    key: "titleGeneration",
    label: "Title generation model",
    hint: "Model for auxiliary title generation. Empty keeps the instance default.",
  },
  {
    key: "compressionSummary",
    label: "Compression model",
    hint: "Model for auxiliary compression summaries. Empty keeps the instance default.",
  },
];

/** Which card model fields each adapter applies to its runs. */
const SUPPORTED_FIELDS_BY_ADAPTER: Record<
  string,
  ReadonlySet<CardModelFieldKey>
> = {
  // Hermes has no separate video model; the run log warns when one is set.
  // BOT-TUNING-C: contextLength and the auxiliary models map to
  // model.context_length and auxiliary.title_generation/compression.
  hermes_local: new Set([
    "vision",
    "stt",
    "tts",
    "fallbacks",
    "contextLength",
    "titleGeneration",
    "compressionSummary",
  ]),
};

export type CardModelFieldKey =
  | SingleModelKey
  | "fallbacks"
  | "contextLength"
  | "titleGeneration"
  | "compressionSummary";

export function isCardModelFieldSupported(adapterType: string, key: CardModelFieldKey): boolean {
  return SUPPORTED_FIELDS_BY_ADAPTER[adapterType]?.has(key) ?? false;
}

function normalize(value: unknown): AgentCardModels {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as AgentCardModels;
}

/** Drop empty single fields so an untouched card stores nothing. */
export function compactCardModels(models: AgentCardModels): AgentCardModels | undefined {
  const next: AgentCardModels = {};
  for (const { key } of SINGLE_MODEL_FIELDS) {
    const value = models[key]?.trim();
    if (value) next[key] = value;
  }
  // Empty rows stay while being edited; the server and the run ignore them.
  const fallbacks = (models.fallbacks ?? []).map((item) => item.trim());
  if (fallbacks.length > 0) next.fallbacks = fallbacks;
  // myrmidon(BOT-TUNING-C): the compiler part B fields compact the same way:
  // the context window only when a finite number, model names only when non-empty.
  if (typeof models.contextLength === "number" && Number.isFinite(models.contextLength)) {
    next.contextLength = models.contextLength;
  }
  const title = models.titleGeneration?.trim();
  if (title) next.titleGeneration = title;
  const compression = models.compressionSummary?.trim();
  if (compression) next.compressionSummary = compression;
  return Object.keys(next).length > 0 ? next : undefined;
}

export type ModelPickerRenderer = (props: {
  value: string;
  onChange: (id: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => ReactNode;

function UnsupportedNote() {
  return <p className="text-xs text-muted-foreground">Not supported by this adapter.</p>;
}

/**
 * myrmidon(BOT-TUNING-C): the "Thinking effort" picker for the card. Only
 * the values the selected model accepts are offered (the UI twin of the
 * server effort policy, ui/src/lib/card-effort-policy); the model's safe
 * default wears a "default" badge, and an empty selection compiles to it.
 */
export function CardEffortPicker({
  model,
  value,
  onChange,
}: {
  /** The card's model (`adapterConfig.model`), used to pick the effort list. */
  model: string | undefined;
  value: string;
  onChange: (effort: string) => void;
}) {
  const efforts = effortsForModel(model);
  const safeDefault = defaultEffortForModel(model);
  const selected = value || safeDefault;
  return (
    <Field label="Thinking effort" hint="Reasoning depth. Only values the selected model accepts are offered; empty uses the model's default.">
      <div className="space-y-1" data-testid="myrmidon-card-effort-picker">
        <div className="flex flex-wrap items-center gap-1">
          {efforts.map((effort) => (
            <button
              key={effort}
              type="button"
              className={
                selected === effort
                  ? "rounded-md border border-border bg-accent px-2.5 py-1.5 text-sm transition-colors"
                  : "rounded-md border border-border px-2.5 py-1.5 text-sm transition-colors hover:bg-accent/50"
              }
              aria-pressed={selected === effort}
              data-effort={effort}
              onClick={() => onChange(value === effort ? "" : effort)}
            >
              {effort}
              {effort === safeDefault ? (
                <span className="ml-1.5 text-(length:--text-nano) text-muted-foreground" data-effort-default>
                  default
                </span>
              ) : null}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground" data-testid="myrmidon-card-effort-hint">
          {value ? `Selected: ${value}` : `Empty compiles to the model default: ${safeDefault}`}
        </p>
      </div>
    </Field>
  );
}

/**
 * myrmidon(BOT-TUNING-C): the context window field, validated against the
 * same range the compiler part B enforces on `model.context_length`.
 */
const CONTEXT_LENGTH_MIN = 8_000;
const CONTEXT_LENGTH_MAX = 10_000_000;

function parseTokens(draft: string): { ok: true; value: number | undefined } | { ok: false; message: string } {
  const n = Number(draft);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { ok: false, message: "Context length must be a whole number of tokens." };
  }
  if (n < CONTEXT_LENGTH_MIN || n > CONTEXT_LENGTH_MAX) {
    return {
      ok: false,
      message: `Context length must be between ${CONTEXT_LENGTH_MIN} and ${CONTEXT_LENGTH_MAX}.`,
    };
  }
  return { ok: true, value: n };
}

export function CardContextLengthField({
  value,
  onChange,
}: {
  value: number | undefined;
  onChange: (tokens: number | undefined) => void;
}) {
  const shown = value === undefined ? "" : String(value);
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);
  const parsed = draft.trim() === "" ? ({ ok: true, value: undefined } as const) : parseTokens(draft);
  return (
    <Field label="Context length (tokens)" hint="Explicit context window for the model. Empty keeps the profile setting.">
      <input
        type="text"
        inputMode="numeric"
        aria-label="Context length"
        aria-invalid={!parsed.ok}
        data-testid="myrmidon-card-context-length"
        className="w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40"
        placeholder="auto"
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          const next = event.target.value.trim() === "" ? ({ ok: true, value: undefined } as const) : parseTokens(event.target.value);
          if (next.ok) onChange(next.value);
        }}
      />
      {!parsed.ok && (
        <p className="mt-1 text-xs text-amber-400" data-testid="myrmidon-card-context-length-error">
          {parsed.message}
        </p>
      )}
    </Field>
  );
}

export function AgentCardModelsFields({
  adapterType,
  value,
  onChange,
  renderModelPicker,
}: {
  adapterType: string;
  value: unknown;
  onChange: (next: AgentCardModels | undefined) => void;
  /** Same picker and model list as the main model field. */
  renderModelPicker: ModelPickerRenderer;
}) {
  const models = normalize(value);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(() => compactCardModels(models) !== undefined);
  const fallbacks = models.fallbacks ?? [];

  const update = (patch: AgentCardModels) => onChange(compactCardModels({ ...models, ...patch }));
  const picker = (key: string, current: string, set: (id: string) => void) =>
    renderModelPicker({
      value: current,
      onChange: set,
      open: openKey === key,
      onOpenChange: (open) => setOpenKey(open ? key : null),
    });
  const moveFallback = (from: number, to: number) => {
    if (to < 0 || to >= fallbacks.length) return;
    const next = [...fallbacks];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    update({ fallbacks: next });
  };

  return (
    <CollapsibleSection title="Additional models" open={expanded} onToggle={() => setExpanded((open) => !open)}>
      <div className="space-y-3">
      {SINGLE_MODEL_FIELDS.map((field) => (
        <Field key={field.key} label={field.label} hint={field.hint}>
          {picker(field.key, models[field.key] ?? "", (id) => update({ [field.key]: id }))}
          {!isCardModelFieldSupported(adapterType, field.key) && <UnsupportedNote />}
        </Field>
      ))}
      {/* myrmidon(BOT-TUNING-C): auxiliary models for title generation and compression. */}
      {AUXILIARY_MODEL_FIELDS.map((field) => (
        <Field key={field.key} label={field.label} hint={field.hint}>
          {picker(field.key, models[field.key] ?? "", (id) => update({ [field.key]: id }))}
          {!isCardModelFieldSupported(adapterType, field.key) && <UnsupportedNote />}
        </Field>
      ))}
      {/* myrmidon(BOT-TUNING-C): explicit context window for the card's model. */}
      <Field label="Context length (tokens)" hint="Explicit context window for the model. Empty keeps the profile setting.">
        {isCardModelFieldSupported(adapterType, "contextLength") ? (
          <CardContextLengthField
            value={models.contextLength}
            onChange={(tokens) => update({ contextLength: tokens })}
          />
        ) : (
          <UnsupportedNote />
        )}
      </Field>
      <Field label="Fallback models" hint="Tried in order when the main model fails.">
        <div className="space-y-2">
          {fallbacks.map((model, index) => (
            <div key={`${index}-${model}`} className="flex items-center gap-1">
              <div className="min-w-0 flex-1">
                {picker(`fallback-${index}`, model, (id) => {
                  const next = [...fallbacks];
                  next[index] = id;
                  update({ fallbacks: next });
                })}
              </div>
              <Button variant="ghost" size="icon-sm" aria-label="Move up" onClick={() => moveFallback(index, index - 1)}>
                <ArrowUp />
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label="Move down" onClick={() => moveFallback(index, index + 1)}>
                <ArrowDown />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Remove fallback model"
                onClick={() => update({ fallbacks: fallbacks.filter((_, i) => i !== index) })}
              >
                <X />
              </Button>
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={() => update({ fallbacks: [...fallbacks, ""] })}>
            <Plus />
            Add fallback model
          </Button>
          {!isCardModelFieldSupported(adapterType, "fallbacks") && <UnsupportedNote />}
        </div>
      </Field>
      </div>
    </CollapsibleSection>
  );
}
