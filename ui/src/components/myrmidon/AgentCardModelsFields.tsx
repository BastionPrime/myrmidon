import { useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CollapsibleSection, Field } from "../agent-config-primitives";

/**
 * myrmidon(M1): extra models on the agent card, stored as
 * `adapterConfig.models = { vision, video, stt, tts, fallbacks: [] }`.
 * The text model stays `adapterConfig.model`, the reasoning level stays the
 * vendor "Thinking effort" setting. Only model names are stored.
 */
export type AgentCardModels = {
  vision?: string;
  video?: string;
  stt?: string;
  tts?: string;
  fallbacks?: string[];
};

type SingleModelKey = "vision" | "video" | "stt" | "tts";

const SINGLE_MODEL_FIELDS: ReadonlyArray<{ key: SingleModelKey; label: string; hint: string }> = [
  { key: "vision", label: "Vision model", hint: "Model for image analysis. Empty keeps the profile setting." },
  { key: "video", label: "Video model", hint: "Model for video input. Empty keeps the profile setting." },
  { key: "stt", label: "Speech-to-text model", hint: "Model for transcribing audio. Empty keeps the profile setting." },
  { key: "tts", label: "Text-to-speech model", hint: "Model for voice replies. Empty keeps the profile setting." },
];

/** Which card model fields each adapter applies to its runs. */
const SUPPORTED_FIELDS_BY_ADAPTER: Record<string, ReadonlySet<SingleModelKey | "fallbacks">> = {
  // Hermes has no separate video model; the run log warns when one is set.
  hermes_local: new Set(["vision", "stt", "tts", "fallbacks"]),
};

export function isCardModelFieldSupported(adapterType: string, key: SingleModelKey | "fallbacks"): boolean {
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
