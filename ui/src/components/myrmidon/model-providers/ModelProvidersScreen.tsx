// myrmidon(1.6.1 MODEL-PROVIDERS C): the "Model providers" settings screen —
// layout + local interaction state; the wire state (queries, mutations) lives
// in ModelProvidersContainer.tsx so tests can drive both tiers separately.
//
// Sections:
//   1. Add provider form — type (dashscope|openai|google|openai-compatible),
//      display name, base URL, API key, free/paid flag. The key input is
//      write-only: it lives in local state only while the form is open and is
//      cleared on save; the saved provider renders a hasKey dot, never the
//      value. Rotate uses the same rule — a "new key" field that exists only
//      while the rotate form is open.
//   2. Provider cards — type/name/base URL, free/paid flag, models list with
//      enable checkboxes and per-model free/paid flags (owner rule: free
//      models first, free DashScope models at the very top), remove with
//      confirmation, rotate.
//   3. Change log — the add/rotate/remove/models_updated entries from the
//      Part A API.
//
// Key non-leak rule (tested): after any save the component renders only the
// API's key-free fields; the raw key never enters props, cache or DOM.
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Boxes, KeyRound, Trash2 } from "lucide-react";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  modelProvidersApi,
  MODEL_PROVIDER_TYPES,
  sortModels,
  type AddModelProviderInput,
  type ModelProviderType,
  type ModelProvidersView,
  type ModelProviderView,
} from "./modelProvidersApi";

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function providerTypeLabel(type: ModelProviderType): string {
  return type; // machine-facing value shown in mono — not translated prose
}

const EMPTY_FORM: AddModelProviderInput = {
  type: "dashscope",
  name: "",
  baseUrl: "",
  key: "",
  free: false,
};

export function ModelProvidersScreenView({
  view,
  companyId,
  modelsQuery,
  onAdd,
  adding,
  addError,
  onRotate,
  rotating,
  onRemove,
  removing,
  onToggleModel,
  savingModels,
  error,
}: {
  view: ModelProvidersView;
  companyId: string;
  /** Query key factory for the per-provider model list (container owns it). */
  modelsQuery: (providerId: string) => readonly unknown[];
  onAdd: (input: AddModelProviderInput) => void;
  adding: boolean;
  addError: string | null;
  onRotate: (providerId: string, key: string) => void;
  rotating: boolean;
  onRemove: (providerId: string) => void;
  removing: boolean;
  onToggleModel: (
    providerId: string,
    models: Array<{ modelName: string; litellmModelName: string; enabled: boolean; free: boolean }>,
  ) => void;
  savingModels: boolean;
  error: string | null;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState<AddModelProviderInput>(EMPTY_FORM);
  const [formOpen, setFormOpen] = useState(false);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [rotateId, setRotateId] = useState<string | null>(null);
  const [rotateKey, setRotateKey] = useState("");

  // The add form resets when the provider list changes after a save: the raw
  // key never survives a successful mutation in this component's state.
  useEffect(() => {
    setForm(EMPTY_FORM);
  }, [view]);

  const submitAdd = () => {
    if (!form.name.trim() || !form.key.trim()) return;
    onAdd({
      ...form,
      name: form.name.trim(),
      baseUrl: (form.baseUrl ?? "").trim() || null,
      key: form.key.trim(),
    });
    // Optimistic clear: the container invalidates on success; on error the
    // user retypes (the key is deliberately not kept in state on failure).
    setForm(EMPTY_FORM);
  };

  const submitRotate = (providerId: string) => {
    if (!rotateKey.trim()) return;
    onRotate(providerId, rotateKey.trim());
    setRotateKey("");
    setRotateId(null);
  };

  const providerFreeLabel = (provider: ModelProviderView) =>
    provider.free ? t("modelProviders.free") : t("modelProviders.paid");

  return (
    <div className="max-w-5xl space-y-6" data-testid="myrmidon-model-providers-screen">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Boxes className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">{t("modelProviders.title")}</h1>
        </div>
        <p className="text-sm text-muted-foreground">{t("modelProviders.intro")}</p>
      </div>

      {error ? (
        <p className="text-sm text-destructive" data-testid="myrmidon-model-providers-mutation-error">
          {error}
        </p>
      ) : null}

      {/* 1. Add provider */}
      <section className="space-y-3" data-testid="myrmidon-model-providers-add">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">{t("modelProviders.add.title")}</h2>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setFormOpen((open) => !open);
              setForm(EMPTY_FORM);
            }}
            data-testid="myrmidon-model-providers-add-toggle"
          >
            {formOpen ? t("modelProviders.add.cancel") : t("modelProviders.add.open")}
          </Button>
        </div>
        {formOpen ? (
          <div className="grid gap-3 md:grid-cols-2" data-testid="myrmidon-model-providers-add-form">
            <div className="space-y-1">
              <Label htmlFor="model-provider-type">{t("modelProviders.add.type")}</Label>
              <select
                id="model-provider-type"
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value as ModelProviderType })}
                data-testid="myrmidon-model-providers-add-type"
              >
                {MODEL_PROVIDER_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {providerTypeLabel(type)}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="model-provider-name">{t("modelProviders.add.name")}</Label>
              <Input
                id="model-provider-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                data-testid="myrmidon-model-providers-add-name"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="model-provider-base-url">{t("modelProviders.add.baseUrl")}</Label>
              <Input
                id="model-provider-base-url"
                value={form.baseUrl ?? ""}
                placeholder={form.type === "openai-compatible" ? "https://…" : ""}
                onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
                data-testid="myrmidon-model-providers-add-base-url"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="model-provider-key">{t("modelProviders.add.key")}</Label>
              <Input
                id="model-provider-key"
                type="password"
                autoComplete="new-password"
                value={form.key}
                onChange={(e) => setForm({ ...form, key: e.target.value })}
                data-testid="myrmidon-model-providers-add-key"
              />
              <p className="text-xs text-muted-foreground">{t("modelProviders.add.keyHint")}</p>
            </div>
            <label className="flex items-center gap-2 text-sm" data-testid="myrmidon-model-providers-add-free">
              <input
                type="checkbox"
                checked={form.free}
                onChange={(e) => setForm({ ...form, free: e.target.checked })}
              />
              {t("modelProviders.add.free")}
            </label>
            <div className="flex items-end gap-2">
              <Button
                size="sm"
                onClick={submitAdd}
                disabled={adding || !form.name.trim() || !form.key.trim()}
                data-testid="myrmidon-model-providers-add-submit"
              >
                {adding ? t("modelProviders.add.saving") : t("modelProviders.add.save")}
              </Button>
            </div>
            {addError ? (
              <p className="text-xs text-destructive md:col-span-2" data-testid="myrmidon-model-providers-add-error">
                {addError}
              </p>
            ) : null}
          </div>
        ) : null}
      </section>

      {/* 2. Providers */}
      <section className="space-y-3" data-testid="myrmidon-model-providers-list">
        <h2 className="text-sm font-semibold">{t("modelProviders.list.title")}</h2>
        {view.providers.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="myrmidon-model-providers-empty">
            {t("modelProviders.list.empty")}
          </p>
        ) : (
          view.providers.map((provider) => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              companyId={companyId}
              modelsQuery={modelsQuery}
              freeLabel={providerFreeLabel(provider)}
              confirmRemove={confirmRemoveId === provider.id}
              onAskRemove={() => setConfirmRemoveId(provider.id)}
              onCancelRemove={() => setConfirmRemoveId(null)}
              onConfirmRemove={() => {
                onRemove(provider.id);
                setConfirmRemoveId(null);
              }}
              removing={removing}
              rotating={rotating}
              rotateOpen={rotateId === provider.id}
              rotateKey={rotateKey}
              onRotateOpen={() => {
                setRotateId(provider.id);
                setRotateKey("");
              }}
              onRotateKeyChange={setRotateKey}
              onRotateSubmit={() => submitRotate(provider.id)}
              onRotateCancel={() => setRotateId(null)}
              onToggleModel={onToggleModel}
              savingModels={savingModels}
              t={t}
            />
          ))
        )}
      </section>

      {/* 3. Change log */}
      <section className="space-y-2" data-testid="myrmidon-model-providers-changelog">
        <h2 className="text-sm font-semibold">{t("modelProviders.changeLog.title")}</h2>
        {view.changeLog.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="myrmidon-model-providers-changelog-empty">
            {t("modelProviders.changeLog.empty")}
          </p>
        ) : (
          <ol className="space-y-1">
            {view.changeLog.map((entry) => (
              <li
                key={entry.id}
                className="flex flex-col border-b border-border pb-1 last:border-b-0 text-sm"
                data-testid="myrmidon-model-providers-changelog-entry"
              >
                <span className="font-mono text-xs">{entry.action}</span>
                <span className="text-xs text-muted-foreground">
                  {formatTime(entry.at)} · {entry.summary}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function ProviderCard({
  provider,
  companyId,
  modelsQuery,
  freeLabel,
  confirmRemove,
  onAskRemove,
  onCancelRemove,
  onConfirmRemove,
  removing,
  rotating,
  rotateOpen,
  rotateKey,
  onRotateOpen,
  onRotateKeyChange,
  onRotateSubmit,
  onRotateCancel,
  onToggleModel,
  savingModels,
  t,
}: {
  provider: ModelProviderView;
  companyId: string;
  modelsQuery: (providerId: string) => readonly unknown[];
  freeLabel: string;
  confirmRemove: boolean;
  onAskRemove: () => void;
  onCancelRemove: () => void;
  onConfirmRemove: () => void;
  removing: boolean;
  rotating: boolean;
  rotateOpen: boolean;
  rotateKey: string;
  onRotateOpen: () => void;
  onRotateKeyChange: (value: string) => void;
  onRotateSubmit: () => void;
  onRotateCancel: () => void;
  onToggleModel: (
    providerId: string,
    models: Array<{ modelName: string; litellmModelName: string; enabled: boolean; free: boolean }>,
  ) => void;
  savingModels: boolean;
  t: (key: string) => string;
}) {
  const modelsQueryResult = useQuery({
    queryKey: modelsQuery(provider.id),
    queryFn: () => modelProvidersApi.models(companyId, provider.id),
    staleTime: 60_000,
  });
  const models = sortModels(modelsQueryResult.data?.models ?? []);

  const toggle = (modelName: string) => {
    const next = models.map((model) =>
      model.modelName === modelName ? { ...model, enabled: !model.enabled } : model,
    );
    onToggleModel(provider.id, next);
  };

  return (
    <div
      className="space-y-3 rounded-lg border border-border p-4"
      data-testid={`myrmidon-model-provider-card-${provider.id}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium" data-testid="myrmidon-model-provider-name">
            {provider.name}
          </span>
          <span className="font-mono text-xs text-muted-foreground">
            {provider.type}
            {provider.baseUrl ? ` · ${provider.baseUrl}` : ""}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className="rounded-md border border-border px-1.5 py-0.5 text-xs"
            data-testid={`myrmidon-model-provider-tier-${provider.id}`}
          >
            {freeLabel}
          </span>
          <span
            className="inline-flex items-center gap-1 text-xs text-muted-foreground"
            data-testid={`myrmidon-model-provider-haskey-${provider.id}`}
          >
            <KeyRound className="h-3 w-3" aria-hidden="true" />
            {provider.hasKey ? t("modelProviders.list.keyStored") : t("modelProviders.list.keyMissing")}
          </span>
        </div>
      </div>

      {/* Models */}
      <div className="space-y-2" data-testid={`myrmidon-model-provider-models-${provider.id}`}>
        {modelsQueryResult.isLoading ? (
          <p className="text-xs text-muted-foreground">{t("modelProviders.list.modelsLoading")}</p>
        ) : models.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("modelProviders.list.modelsEmpty")}</p>
        ) : (
          <ul className="space-y-1">
            {models.map((model) => (
              <li
                key={model.modelName}
                className="flex items-center justify-between gap-2 text-sm"
                data-testid={`myrmidon-model-row-${provider.id}-${model.modelName}`}
              >
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={model.enabled}
                    disabled={savingModels}
                    onChange={() => toggle(model.modelName)}
                    data-testid={`myrmidon-model-toggle-${provider.id}-${model.modelName}`}
                  />
                  <span className="font-mono text-xs">{model.modelName}</span>
                </label>
                <span
                  className="rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground"
                  data-testid={`myrmidon-model-tier-${provider.id}-${model.modelName}`}
                >
                  {model.free ? t("modelProviders.free") : t("modelProviders.paid")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Rotate + remove */}
      <div className="flex flex-wrap items-center gap-2">
        {rotateOpen ? (
          <div className="flex flex-wrap items-center gap-2" data-testid={`myrmidon-model-provider-rotate-${provider.id}`}>
            <Input
              type="password"
              autoComplete="new-password"
              value={rotateKey}
              onChange={(e) => onRotateKeyChange(e.target.value)}
              placeholder={t("modelProviders.rotate.placeholder")}
              className="w-64"
              data-testid={`myrmidon-model-provider-rotate-key-${provider.id}`}
            />
            <Button size="sm" onClick={onRotateSubmit} disabled={rotating || !rotateKey.trim()}>
              {rotating ? t("modelProviders.rotate.saving") : t("modelProviders.rotate.save")}
            </Button>
            <Button size="sm" variant="outline" onClick={onRotateCancel}>
              {t("modelProviders.rotate.cancel")}
            </Button>
          </div>
        ) : (
          <Button size="sm" variant="outline" onClick={onRotateOpen} data-testid={`myrmidon-model-provider-rotate-open-${provider.id}`}>
            {t("modelProviders.rotate.open")}
          </Button>
        )}
        {confirmRemove ? (
          <div className="flex items-center gap-2" data-testid={`myrmidon-model-provider-confirm-${provider.id}`}>
            <Button size="sm" variant="destructive" onClick={onConfirmRemove} disabled={removing}>
              {removing ? t("modelProviders.remove.removing") : t("modelProviders.remove.confirm")}
            </Button>
            <Button size="sm" variant="outline" onClick={onCancelRemove}>
              {t("modelProviders.remove.cancel")}
            </Button>
          </div>
        ) : (
          <Button size="sm" variant="outline" onClick={onAskRemove} data-testid={`myrmidon-model-provider-remove-open-${provider.id}`}>
            <Trash2 className="h-3 w-3" aria-hidden="true" />
            {t("modelProviders.remove.open")}
          </Button>
        )}
      </div>
    </div>
  );
}
