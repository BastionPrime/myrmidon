// myrmidon(1.6.1 CUSTOM-CASTES C): the "Agent castes" settings screen —
// layout + local interaction state; the wire state (queries, mutations)
// lives in CastesContainer.tsx so tests can drive both tiers separately.
//
// Sections:
//   1. Add caste form — key (latin/hyphen, 1–60; locked after creation),
//      names RU/EN, description, color (token-layer swatches only), icon
//      (curated agent icon set), default model, swarm eligibility, per-caste
//      active task limit (empty = the global swarm limit).
//   2. Caste table — one row per directory entry: key, names, color dot,
//      icon, default model, swarm eligibility, task limit, builtIn badge;
//      edit (inline form: everything except key/builtIn), remove with
//      confirmation. A 409 from the DELETE (live agents hold the role)
//      surfaces as a readable error row, not a stack dump.
//
// Token rule: every color value comes from the token layer; the swatch
// background uses the stored `color` value itself, which the API contract
// pins to the token-layer palette (CASTE_COLOR_VARS below).
import { useState } from "react";
import { Layers, Trash2 } from "lucide-react";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getAgentIcon } from "@/lib/agent-icons";
import { AGENT_ICON_NAMES } from "@paperclipai/shared";
import type { AddCasteInput, CasteView, UpdateCasteInput } from "./castesApi";

/**
 * The color palette a caste may carry. Values are the token-layer color
 * custom properties (`--hex-*` extraction family in ui/src/index.css), so a
 * stored `color` is a rendered token reference, never a literal.
 */
export const CASTE_COLOR_VARS = [
  "var(--hex-6366f1)",
  "var(--hex-8b5cf6)",
  "var(--hex-ec4899)",
  "var(--hex-ef4444)",
  "var(--hex-f97316)",
  "var(--hex-eab308)",
  "var(--hex-22c55e)",
  "var(--hex-14b8a6)",
  "var(--hex-06b6d4)",
  "var(--hex-3b82f6)",
] as const;

/** key constraint from the shared contract: latin letters and hyphen, 1–60. */
const KEY_RE = /^[a-z][a-z0-9-]{0,59}$/;

const EMPTY_FORM: AddCasteInput = {
  key: "",
  nameEn: "",
  nameRu: "",
  description: "",
  color: CASTE_COLOR_VARS[0],
  icon: "bot",
  defaultModel: null,
  swarmEligible: true,
  maxActiveTasks: null,
};

function readableKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
}

export function casteDisplayName(caste: CasteView): string {
  return caste.nameRu || caste.nameEn || caste.key;
}

export function CastesScreenView({
  castes,
  onAdd,
  adding,
  addError,
  onUpdate,
  updating,
  onRemove,
  removing,
  error,
}: {
  castes: CasteView[];
  onAdd: (input: AddCasteInput) => void;
  adding: boolean;
  addError: string | null;
  onUpdate: (key: string, input: UpdateCasteInput) => void;
  updating: boolean;
  onRemove: (key: string) => void;
  removing: boolean;
  error: string | null;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState<AddCasteInput>(EMPTY_FORM);
  const [formOpen, setFormOpen] = useState(false);
  const [editKey, setEditKey] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<UpdateCasteInput>({});
  const [confirmRemoveKey, setConfirmRemoveKey] = useState<string | null>(null);

  const keyValid = KEY_RE.test(readableKey(form.key));
  const namesValid = form.nameEn.trim().length > 0 && form.nameRu.trim().length > 0;

  const submitAdd = () => {
    if (!keyValid || !namesValid) return;
    onAdd({
      ...form,
      key: readableKey(form.key),
      nameEn: form.nameEn.trim(),
      nameRu: form.nameRu.trim(),
      description: form.description.trim(),
      defaultModel: (form.defaultModel ?? "").trim() || null,
    });
    setForm(EMPTY_FORM);
  };

  const startEdit = (caste: CasteView) => {
    setEditKey(caste.key);
    setConfirmRemoveKey(null);
    setEditDraft({
      nameEn: caste.nameEn,
      nameRu: caste.nameRu,
      description: caste.description,
      color: caste.color,
      icon: caste.icon,
      defaultModel: caste.defaultModel,
      swarmEligible: caste.swarmEligible,
      maxActiveTasks: caste.maxActiveTasks,
    });
  };

  const submitEdit = (key: string) => {
    if (!editDraft.nameEn?.trim() || !editDraft.nameRu?.trim()) return;
    onUpdate(key, {
      ...editDraft,
      nameEn: editDraft.nameEn.trim(),
      nameRu: editDraft.nameRu.trim(),
      description: (editDraft.description ?? "").trim(),
      defaultModel: (editDraft.defaultModel ?? "").trim() || null,
    });
    setEditKey(null);
  };

  const editNamesValid = Boolean(editDraft.nameEn?.trim() && editDraft.nameRu?.trim());

  return (
    <div className="max-w-5xl space-y-6" data-testid="myrmidon-castes-screen">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Layers className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">{t("castes.title")}</h1>
        </div>
        <p className="text-sm text-muted-foreground">{t("castes.intro")}</p>
      </div>

      {error ? (
        <p className="text-sm text-destructive" data-testid="myrmidon-castes-mutation-error">
          {error}
        </p>
      ) : null}

      {/* 1. Add caste */}
      <section className="space-y-3" data-testid="myrmidon-castes-add">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">{t("castes.add.title")}</h2>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setFormOpen((open) => !open);
              setForm(EMPTY_FORM);
            }}
            data-testid="myrmidon-castes-add-toggle"
          >
            {formOpen ? t("castes.add.cancel") : t("castes.add.open")}
          </Button>
        </div>
        {formOpen ? (
          <div className="grid gap-3 md:grid-cols-2" data-testid="myrmidon-castes-add-form">
            <div className="space-y-1">
              <Label htmlFor="caste-key">{t("castes.add.key")}</Label>
              <Input
                id="caste-key"
                value={form.key}
                placeholder="e.g. data-steward"
                onChange={(e) => setForm({ ...form, key: readableKey(e.target.value) })}
                data-testid="myrmidon-castes-add-key"
              />
              <p className="text-xs text-muted-foreground">{t("castes.add.keyHint")}</p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="caste-name-en">{t("castes.add.nameEn")}</Label>
              <Input
                id="caste-name-en"
                value={form.nameEn}
                onChange={(e) => setForm({ ...form, nameEn: e.target.value })}
                data-testid="myrmidon-castes-add-name-en"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="caste-name-ru">{t("castes.add.nameRu")}</Label>
              <Input
                id="caste-name-ru"
                value={form.nameRu}
                onChange={(e) => setForm({ ...form, nameRu: e.target.value })}
                data-testid="myrmidon-castes-add-name-ru"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="caste-model">{t("castes.add.defaultModel")}</Label>
              <Input
                id="caste-model"
                value={form.defaultModel ?? ""}
                placeholder="qwen-plus"
                onChange={(e) => setForm({ ...form, defaultModel: e.target.value })}
                data-testid="myrmidon-castes-add-model"
              />
            </div>
            <div className="space-y-1 md:col-span-2">
              <Label htmlFor="caste-description">{t("castes.add.description")}</Label>
              <Input
                id="caste-description"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                data-testid="myrmidon-castes-add-description"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="caste-color">{t("castes.add.color")}</Label>
              <div className="flex flex-wrap gap-1.5" data-testid="myrmidon-castes-add-color">
                {CASTE_COLOR_VARS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    className={`h-6 w-6 rounded-md ${
                      form.color === color ? "ring-2 ring-foreground ring-offset-1 ring-offset-background" : ""
                    }`}
                    style={{ backgroundColor: color }}
                    aria-label={`Select color ${color}`}
                    onClick={() => setForm({ ...form, color })}
                    data-testid={`myrmidon-castes-add-color-${color.slice(2)}`}
                  />
                ))}
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="caste-icon">{t("castes.add.icon")}</Label>
              <select
                id="caste-icon"
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                value={form.icon}
                onChange={(e) => setForm({ ...form, icon: e.target.value })}
                data-testid="myrmidon-castes-add-icon"
              >
                {AGENT_ICON_NAMES.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
            <label className="flex items-center gap-2 text-sm" data-testid="myrmidon-castes-add-swarm">
              <input
                type="checkbox"
                checked={form.swarmEligible}
                onChange={(e) => setForm({ ...form, swarmEligible: e.target.checked })}
              />
              {t("castes.add.swarmEligible")}
            </label>
            <div className="space-y-1">
              <Label htmlFor="caste-max-tasks">{t("castes.add.maxActiveTasks")}</Label>
              <Input
                id="caste-max-tasks"
                type="number"
                min={1}
                value={form.maxActiveTasks ?? ""}
                placeholder={t("castes.add.maxActiveTasksHint")}
                onChange={(e) =>
                  setForm({
                    ...form,
                    maxActiveTasks: e.target.value.trim() === "" ? null : Math.max(1, Number(e.target.value) || 1),
                  })
                }
                data-testid="myrmidon-castes-add-max-tasks"
              />
            </div>
            <div className="flex items-end gap-2">
              <Button
                size="sm"
                onClick={submitAdd}
                disabled={adding || !keyValid || !namesValid}
                data-testid="myrmidon-castes-add-submit"
              >
                {adding ? t("castes.add.saving") : t("castes.add.save")}
              </Button>
            </div>
            {addError ? (
              <p className="text-xs text-destructive md:col-span-2" data-testid="myrmidon-castes-add-error">
                {addError}
              </p>
            ) : null}
          </div>
        ) : null}
      </section>

      {/* 2. Caste table */}
      <section className="space-y-3" data-testid="myrmidon-castes-list">
        <h2 className="text-sm font-semibold">{t("castes.list.title")}</h2>
        {castes.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="myrmidon-castes-empty">
            {t("castes.list.empty")}
          </p>
        ) : (
          <table className="w-full text-sm" data-testid="myrmidon-castes-table">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="py-1 pr-2">{t("castes.list.key")}</th>
                <th className="py-1 pr-2">{t("castes.list.names")}</th>
                <th className="py-1 pr-2">{t("castes.list.color")}</th>
                <th className="py-1 pr-2">{t("castes.list.icon")}</th>
                <th className="py-1 pr-2">{t("castes.list.defaultModel")}</th>
                <th className="py-1 pr-2">{t("castes.list.swarm")}</th>
                <th className="py-1 pr-2">{t("castes.list.maxActiveTasks")}</th>
                <th className="py-1">{t("castes.list.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {castes.map((caste) => {
                const Icon = getAgentIcon(caste.icon);
                const editing = editKey === caste.key;
                return (
                  <tr
                    key={caste.key}
                    className="border-b border-border align-top"
                    data-testid={`myrmidon-castes-row-${caste.key}`}
                  >
                    <td className="py-2 pr-2">
                      <span className="font-mono text-xs" data-testid={`myrmidon-castes-key-${caste.key}`}>
                        {caste.key}
                      </span>
                      {caste.builtIn ? (
                        <span
                          className="ml-2 rounded-md border border-border px-1.5 py-0.5 text-xs"
                          data-testid={`myrmidon-castes-builtin-${caste.key}`}
                        >
                          {t("castes.list.builtIn")}
                        </span>
                      ) : null}
                    </td>
                    <td className="py-2 pr-2">
                      <span data-testid={`myrmidon-castes-name-ru-${caste.key}`}>
                        {caste.nameRu}
                      </span>
                      <span className="ml-2 text-xs text-muted-foreground" data-testid={`myrmidon-castes-name-en-${caste.key}`}>
                        {caste.nameEn}
                      </span>
                    </td>
                    <td className="py-2 pr-2">
                      <span
                        className="inline-block h-4 w-4 rounded-md"
                        style={{ backgroundColor: caste.color }}
                        data-testid={`myrmidon-castes-color-${caste.key}`}
                      />
                    </td>
                    <td className="py-2 pr-2">
                      <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                    </td>
                    <td className="py-2 pr-2 font-mono text-xs" data-testid={`myrmidon-castes-model-${caste.key}`}>
                      {caste.defaultModel ?? "—"}
                    </td>
                    <td className="py-2 pr-2 text-xs" data-testid={`myrmidon-castes-swarm-${caste.key}`}>
                      {caste.swarmEligible ? t("castes.list.swarmYes") : t("castes.list.swarmNo")}
                    </td>
                    <td className="py-2 pr-2 text-xs" data-testid={`myrmidon-castes-limit-${caste.key}`}>
                      {caste.maxActiveTasks === null ? t("castes.list.globalLimit") : caste.maxActiveTasks}
                    </td>
                    <td className="py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        {editing ? (
                          <>
                            <Button
                              size="sm"
                              disabled={updating || !editNamesValid}
                              onClick={() => submitEdit(caste.key)}
                              data-testid={`myrmidon-castes-edit-save-${caste.key}`}
                            >
                              {updating ? t("castes.edit.saving") : t("castes.edit.save")}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setEditKey(null)}
                              data-testid={`myrmidon-castes-edit-cancel-${caste.key}`}
                            >
                              {t("castes.edit.cancel")}
                            </Button>
                          </>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => startEdit(caste)}
                            data-testid={`myrmidon-castes-edit-open-${caste.key}`}
                          >
                            {t("castes.edit.open")}
                          </Button>
                        )}
                        {confirmRemoveKey === caste.key ? (
                          <div className="flex items-center gap-2" data-testid={`myrmidon-castes-confirm-${caste.key}`}>
                            <Button
                              size="sm"
                              variant="destructive"
                              disabled={removing}
                              onClick={() => {
                                onRemove(caste.key);
                                setConfirmRemoveKey(null);
                              }}
                            >
                              {removing ? t("castes.remove.removing") : t("castes.remove.confirm")}
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => setConfirmRemoveKey(null)}>
                              {t("castes.remove.cancel")}
                            </Button>
                          </div>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setConfirmRemoveKey(caste.key);
                              setEditKey(null);
                            }}
                            data-testid={`myrmidon-castes-remove-open-${caste.key}`}
                          >
                            <Trash2 className="h-3 w-3" aria-hidden="true" />
                            {t("castes.remove.open")}
                          </Button>
                        )}
                      </div>
                      {editing ? (
                        <div className="mt-2 grid gap-2 md:grid-cols-2" data-testid={`myrmidon-castes-edit-form-${caste.key}`}>
                          <div className="space-y-1">
                            <Label htmlFor={`caste-edit-name-en-${caste.key}`} className="text-xs">
                              {t("castes.add.nameEn")}
                            </Label>
                            <Input
                              id={`caste-edit-name-en-${caste.key}`}
                              value={editDraft.nameEn ?? ""}
                              onChange={(e) => setEditDraft({ ...editDraft, nameEn: e.target.value })}
                              data-testid={`myrmidon-castes-edit-name-en-${caste.key}`}
                            />
                          </div>
                          <div className="space-y-1">
                            <Label htmlFor={`caste-edit-name-ru-${caste.key}`} className="text-xs">
                              {t("castes.add.nameRu")}
                            </Label>
                            <Input
                              id={`caste-edit-name-ru-${caste.key}`}
                              value={editDraft.nameRu ?? ""}
                              onChange={(e) => setEditDraft({ ...editDraft, nameRu: e.target.value })}
                              data-testid={`myrmidon-castes-edit-name-ru-${caste.key}`}
                            />
                          </div>
                          <div className="space-y-1 md:col-span-2">
                            <Label htmlFor={`caste-edit-description-${caste.key}`} className="text-xs">
                              {t("castes.add.description")}
                            </Label>
                            <Input
                              id={`caste-edit-description-${caste.key}`}
                              value={editDraft.description ?? ""}
                              onChange={(e) => setEditDraft({ ...editDraft, description: e.target.value })}
                              data-testid={`myrmidon-castes-edit-description-${caste.key}`}
                            />
                          </div>
                          <div className="space-y-1">
                            <Label htmlFor={`caste-edit-model-${caste.key}`} className="text-xs">
                              {t("castes.add.defaultModel")}
                            </Label>
                            <Input
                              id={`caste-edit-model-${caste.key}`}
                              value={editDraft.defaultModel ?? ""}
                              onChange={(e) => setEditDraft({ ...editDraft, defaultModel: e.target.value })}
                              data-testid={`myrmidon-castes-edit-model-${caste.key}`}
                            />
                          </div>
                          <div className="space-y-1">
                            <Label htmlFor={`caste-edit-icon-${caste.key}`} className="text-xs">
                              {t("castes.add.icon")}
                            </Label>
                            <select
                              id={`caste-edit-icon-${caste.key}`}
                              className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                              value={editDraft.icon ?? "bot"}
                              onChange={(e) => setEditDraft({ ...editDraft, icon: e.target.value })}
                              data-testid={`myrmidon-castes-edit-icon-${caste.key}`}
                            >
                              {AGENT_ICON_NAMES.map((name) => (
                                <option key={name} value={name}>
                                  {name}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div className="flex flex-wrap gap-1.5" data-testid={`myrmidon-castes-edit-color-${caste.key}`}>
                            {CASTE_COLOR_VARS.map((color) => (
                              <button
                                key={color}
                                type="button"
                                className={`h-6 w-6 rounded-md ${
                                  (editDraft.color ?? "") === color
                                    ? "ring-2 ring-foreground ring-offset-1 ring-offset-background"
                                    : ""
                                }`}
                                style={{ backgroundColor: color }}
                                aria-label={`Select color ${color}`}
                                onClick={() => setEditDraft({ ...editDraft, color })}
                              />
                            ))}
                          </div>
                          <label className="flex items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              checked={editDraft.swarmEligible ?? true}
                              onChange={(e) => setEditDraft({ ...editDraft, swarmEligible: e.target.checked })}
                              data-testid={`myrmidon-castes-edit-swarm-${caste.key}`}
                            />
                            {t("castes.add.swarmEligible")}
                          </label>
                          <div className="space-y-1">
                            <Label htmlFor={`caste-edit-max-tasks-${caste.key}`} className="text-xs">
                              {t("castes.add.maxActiveTasks")}
                            </Label>
                            <Input
                              id={`caste-edit-max-tasks-${caste.key}`}
                              type="number"
                              min={1}
                              value={editDraft.maxActiveTasks ?? ""}
                              placeholder={t("castes.add.maxActiveTasksHint")}
                              onChange={(e) =>
                                setEditDraft({
                                  ...editDraft,
                                  maxActiveTasks:
                                    e.target.value.trim() === "" ? null : Math.max(1, Number(e.target.value) || 1),
                                })
                              }
                              data-testid={`myrmidon-castes-edit-max-tasks-${caste.key}`}
                            />
                          </div>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
