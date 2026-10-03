// ui/src/ui2/screens/settings/system/Ui2TelegramNotifySettings.tsx
//
// myrmidon(OPE-3789): Settings → System → "Telegram notifications" in the
// new shell — the UI part (F) of TG-NOTIFY-SETTINGS. All five sections of
// the core contract are visible and editable (digest, errors, inbound,
// escalations, proactivity), plus the change log the core records for every
// changed field. Defaults are all OFF: with the defaults the owner keeps
// receiving only replies to their own messages and the U2 decision cards.
//
// The screen edits a local draft and sends one PATCH with only the fields
// that differ from the stored values (the core merges a partial body and
// records every changed field in the changelog). Editing is board-only on
// the server; a 403 on GET shows the denied state like the other System
// sections. The contract types come from @paperclipai/shared so the UI
// cannot drift from the core.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  TelegramDigestSection,
  TelegramErrorSeverity,
  TelegramEscalationChannel,
  TelegramNotifySettings,
  TelegramProactivityMode,
} from "@paperclipai/shared";
import { telegramNotifyApi, telegramNotifyQueryKey } from "@/api/myrmidonTelegramNotify";
import { useCompany } from "@/context/CompanyContext";
import { formatDateTime } from "@/lib/utils";
import { useUi2I18n } from "../../../i18n/Ui2I18n";
import {
  Ui2DeniedState,
  Ui2EmptyStateView,
  Ui2ErrorState,
  Ui2SkeletonRows,
} from "../../../components/ui2StateViews";
import { Ui2Page, Ui2Section, Ui2StatusDot } from "../../../components/ui2Primitives";

const DIGEST_SECTIONS: TelegramDigestSection[] = ["done", "blocked", "needs_decision", "spend"];
const ERROR_SEVERITIES: TelegramErrorSeverity[] = ["warn", "error", "fatal"];
const ESCALATION_CHANNELS: TelegramEscalationChannel[] = ["dm", "topic", "none"];
const PROACTIVITY_MODES: TelegramProactivityMode[] = ["only_on_owner_request", "rarely", "normal"];

/** The per-field draft: only keys present here are sent in the PATCH. */
type Draft = {
  digest: Partial<TelegramNotifySettings["digest"]>;
  errors: Partial<TelegramNotifySettings["errors"]>;
  inbound: Partial<TelegramNotifySettings["inbound"]>;
  escalations: Partial<TelegramNotifySettings["escalations"]>;
  proactivity: Partial<TelegramNotifySettings["proactivity"]>;
};

const EMPTY_DRAFT: Draft = {
  digest: {},
  errors: {},
  inbound: {},
  escalations: {},
  proactivity: {},
};

/** Machine values look machine-made: chat/topic ids and field paths stay monospace. */
function formatLogValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "on" : "off";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

export function Ui2TelegramNotifySettings() {
  const { t } = useUi2I18n();
  const { selectedCompanyId } = useCompany();
  const companyId = selectedCompanyId ?? "";
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [saveError, setSaveError] = useState<string | null>(null);

  const queryKey = telegramNotifyQueryKey(companyId);
  const notifyQuery = useQuery({
    queryKey,
    queryFn: () => telegramNotifyApi.get(companyId),
    enabled: !!selectedCompanyId,
    staleTime: 30_000,
  });

  const settings = notifyQuery.data?.settings ?? null;

  useEffect(() => {
    setDraft(EMPTY_DRAFT);
    setSaveError(null);
  }, [settings]);

  const saveMutation = useMutation({
    // Only sections with at least one edited field go on the wire: the PATCH
    // body is partial per section, and an empty section object is noise.
    mutationFn: (patch: Draft) => {
      const body = Object.fromEntries(
        Object.entries(patch).filter(([, fields]) => Object.keys(fields).length > 0),
      );
      return telegramNotifyApi.update(companyId, body);
    },
    onSuccess: (next) => {
      setSaveError(null);
      setDraft(EMPTY_DRAFT);
      queryClient.setQueryData(queryKey, next);
    },
    onError: (error) => {
      setSaveError(error instanceof Error ? error.message : String(error));
    },
  });

  function setField<K extends keyof Draft>(section: K, field: string, value: unknown): void {
    setDraft((current) => ({
      ...current,
      [section]: { ...current[section], [field]: value },
    }));
  }

  /** The effective value: the draft override over the stored settings. */
  function effective<K extends keyof TelegramNotifySettings, F extends keyof TelegramNotifySettings[K]>(
    section: K,
    field: F,
  ): TelegramNotifySettings[K][F] {
    const override = (draft[section] as Record<string, unknown>)[field as string];
    if (override !== undefined) return override as TelegramNotifySettings[K][F];
    return settings![section][field];
  }

  const dirty = useMemo(() => {
    if (!settings) return false;
    return (Object.keys(draft) as Array<keyof Draft>).some((section) => {
      const stored = settings[section] as unknown as Record<string, unknown>;
      return Object.entries(draft[section]).some(
        ([field, value]) => stored[field] !== value,
      );
    });
  }, [draft, settings]);

  if (notifyQuery.isLoading) {
    return (
      <Ui2Page title={t("ui2.settings.tgNotify.title")} subtitle={t("ui2.settings.tgNotify.subtitle")}>
        <Ui2SkeletonRows rows={4} />
      </Ui2Page>
    );
  }

  const denied =
    notifyQuery.isError && (notifyQuery.error as { status?: number } | null)?.status === 403;

  if (notifyQuery.isError || !settings) {
    return (
      <Ui2Page title={t("ui2.settings.tgNotify.title")} subtitle={t("ui2.settings.tgNotify.subtitle")}>
        {denied ? (
          <Ui2DeniedState
            message={t("ui2.settings.tgNotify.denied")}
            hint={t("ui2.settings.tgNotify.deniedHint")}
          />
        ) : (
          <Ui2ErrorState
            message={t("ui2.common.error")}
            detail={notifyQuery.error instanceof Error ? notifyQuery.error.message : null}
            retryLabel={t("ui2.common.retry")}
            onRetry={() => void notifyQuery.refetch()}
          />
        )}
      </Ui2Page>
    );
  }

  const changelog = notifyQuery.data?.changelog ?? [];

  const sectionState = (enabled: boolean) => (
    <span
      className="ui2-tn-section-state inline-flex items-center gap-2 text-sm"
      data-tn-state={enabled ? "on" : "off"}
    >
      <Ui2StatusDot tone={enabled ? "ok" : "muted"} />
      {enabled ? t("ui2.settings.tgNotify.on") : t("ui2.settings.tgNotify.off")}
    </span>
  );

  const sectionHead = (section: string, enabled: boolean, title: string) => (
    <div className="ui2-tn-section-head flex items-center justify-between gap-3" data-tn-section={section}>
      <span className="ui2-tn-section-title text-sm font-medium">{title}</span>
      {sectionState(enabled)}
    </div>
  );

  return (
    <Ui2Page title={t("ui2.settings.tgNotify.title")} subtitle={t("ui2.settings.tgNotify.subtitle")}>
      <Ui2Section title={t("ui2.settings.tgNotify.digest.title")} footer={t("ui2.settings.tgNotify.digest.hint")}>
        {sectionHead("digest", effective("digest", "enabled"), t("ui2.settings.tgNotify.digest.title"))}
        <div className="ui2-tn-fields flex flex-col gap-3">
          <label className="ui2-tn-field flex flex-wrap items-center justify-between gap-3">
            <span className="ui2-tn-field-name text-sm">{t("ui2.settings.tgNotify.digest.enabled")}</span>
            <input
              id="ui2-tn-digest-enabled"
              type="checkbox"
              className="ui2-tn-toggle-input h-4 w-4 accent-primary"
              checked={effective("digest", "enabled")}
              onChange={(event) => setField("digest", "enabled", event.target.checked)}
            />
          </label>
          <label className="ui2-tn-field flex flex-wrap items-center justify-between gap-3">
            <span className="ui2-tn-field-name text-sm">{t("ui2.settings.tgNotify.digest.time")}</span>
            <input
              type="time"
              className="ui2-tn-time-input rounded-md border border-input bg-background px-2 py-1 font-mono text-sm tabular-nums"
              value={effective("digest", "time")}
              onChange={(event) => setField("digest", "time", event.target.value)}
            />
          </label>
          <label className="ui2-tn-field flex flex-wrap items-center justify-between gap-3">
            <span className="ui2-tn-field-name text-sm">{t("ui2.settings.tgNotify.digest.chatId")}</span>
            <input
              type="text"
              className="ui2-tn-text-input w-48 rounded-md border border-input bg-background px-2 py-1 font-mono text-sm"
              value={effective("digest", "chatId") ?? ""}
              placeholder="—"
              onChange={(event) => setField("digest", "chatId", event.target.value === "" ? null : event.target.value)}
            />
          </label>
          <label className="ui2-tn-field flex flex-wrap items-center justify-between gap-3">
            <span className="ui2-tn-field-name text-sm">{t("ui2.settings.tgNotify.digest.topicId")}</span>
            <input
              type="text"
              className="ui2-tn-text-input w-48 rounded-md border border-input bg-background px-2 py-1 font-mono text-sm"
              value={effective("digest", "topicId") ?? ""}
              placeholder="—"
              onChange={(event) => setField("digest", "topicId", event.target.value === "" ? null : event.target.value)}
            />
          </label>
          <fieldset className="ui2-tn-field flex flex-col gap-2">
            <legend className="ui2-tn-field-name text-sm">{t("ui2.settings.tgNotify.digest.sections")}</legend>
            <div className="ui2-tn-sections flex flex-wrap gap-3">
              {DIGEST_SECTIONS.map((sectionKey) => {
                const checked = effective("digest", "sections").includes(sectionKey);
                return (
                  <label key={sectionKey} className="ui2-tn-section-check flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="ui2-tn-toggle-input h-4 w-4 accent-primary"
                      checked={checked}
                      onChange={(event) => {
                        const next = event.target.checked
                          ? [...effective("digest", "sections"), sectionKey]
                          : effective("digest", "sections").filter((entry) => entry !== sectionKey);
                        setField("digest", "sections", next);
                      }}
                    />
                    {t(`ui2.settings.tgNotify.digest.section.${sectionKey}`)}
                  </label>
                );
              })}
            </div>
          </fieldset>
        </div>
      </Ui2Section>

      <Ui2Section title={t("ui2.settings.tgNotify.errors.title")} footer={t("ui2.settings.tgNotify.errors.hint")}>
        {sectionHead("errors", effective("errors", "enabled"), t("ui2.settings.tgNotify.errors.title"))}
        <div className="ui2-tn-fields flex flex-col gap-3">
          <label className="ui2-tn-field flex flex-wrap items-center justify-between gap-3">
            <span className="ui2-tn-field-name text-sm">{t("ui2.settings.tgNotify.errors.enabled")}</span>
            <input
              type="checkbox"
              className="ui2-tn-toggle-input h-4 w-4 accent-primary"
              checked={effective("errors", "enabled")}
              onChange={(event) => setField("errors", "enabled", event.target.checked)}
            />
          </label>
          <label className="ui2-tn-field flex flex-wrap items-center justify-between gap-3">
            <span className="ui2-tn-field-name text-sm">{t("ui2.settings.tgNotify.errors.chatId")}</span>
            <input
              type="text"
              className="ui2-tn-text-input w-48 rounded-md border border-input bg-background px-2 py-1 font-mono text-sm"
              value={effective("errors", "chatId") ?? ""}
              placeholder="—"
              onChange={(event) => setField("errors", "chatId", event.target.value === "" ? null : event.target.value)}
            />
          </label>
          <label className="ui2-tn-field flex flex-wrap items-center justify-between gap-3">
            <span className="ui2-tn-field-name text-sm">{t("ui2.settings.tgNotify.errors.topicId")}</span>
            <input
              type="text"
              className="ui2-tn-text-input w-48 rounded-md border border-input bg-background px-2 py-1 font-mono text-sm"
              value={effective("errors", "topicId") ?? ""}
              placeholder="—"
              onChange={(event) => setField("errors", "topicId", event.target.value === "" ? null : event.target.value)}
            />
          </label>
          <label className="ui2-tn-field flex flex-wrap items-center justify-between gap-3">
            <span className="ui2-tn-field-name text-sm">{t("ui2.settings.tgNotify.errors.minSeverity")}</span>
            <select
              className="ui2-tn-select rounded-md border border-input bg-background px-2 py-1 text-sm"
              value={effective("errors", "minSeverity")}
              onChange={(event) => setField("errors", "minSeverity", event.target.value as TelegramErrorSeverity)}
            >
              {ERROR_SEVERITIES.map((severity) => (
                <option key={severity} value={severity}>
                  {t(`ui2.settings.tgNotify.errors.severity.${severity}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="ui2-tn-field flex flex-wrap items-center justify-between gap-3">
            <span className="ui2-tn-field-name text-sm">{t("ui2.settings.tgNotify.errors.maxPerHour")}</span>
            <input
              type="number"
              min={0}
              max={1000}
              className="ui2-tn-number-input w-32 rounded-md border border-input bg-background px-2 py-1 text-right font-mono text-sm tabular-nums"
              value={effective("errors", "maxPerHour")}
              onChange={(event) => setField("errors", "maxPerHour", Number(event.target.value))}
            />
          </label>
        </div>
      </Ui2Section>

      <Ui2Section title={t("ui2.settings.tgNotify.inbound.title")} footer={t("ui2.settings.tgNotify.inbound.hint")}>
        {sectionHead("inbound", effective("inbound", "enabled"), t("ui2.settings.tgNotify.inbound.title"))}
        <div className="ui2-tn-fields flex flex-col gap-3">
          <label className="ui2-tn-field flex flex-wrap items-center justify-between gap-3">
            <span className="ui2-tn-field-name text-sm">{t("ui2.settings.tgNotify.inbound.enabled")}</span>
            <input
              type="checkbox"
              className="ui2-tn-toggle-input h-4 w-4 accent-primary"
              checked={effective("inbound", "enabled")}
              onChange={(event) => setField("inbound", "enabled", event.target.checked)}
            />
          </label>
          <label className="ui2-tn-field flex flex-wrap items-center justify-between gap-3">
            <span className="ui2-tn-field-name text-sm">{t("ui2.settings.tgNotify.inbound.requireMention")}</span>
            <input
              type="checkbox"
              className="ui2-tn-toggle-input h-4 w-4 accent-primary"
              checked={effective("inbound", "requireMention")}
              onChange={(event) => setField("inbound", "requireMention", event.target.checked)}
            />
          </label>
        </div>
      </Ui2Section>

      <Ui2Section title={t("ui2.settings.tgNotify.escalations.title")} footer={t("ui2.settings.tgNotify.escalations.hint")}>
        {sectionHead("escalations", effective("escalations", "enabled"), t("ui2.settings.tgNotify.escalations.title"))}
        <div className="ui2-tn-fields flex flex-col gap-3">
          <label className="ui2-tn-field flex flex-wrap items-center justify-between gap-3">
            <span className="ui2-tn-field-name text-sm">{t("ui2.settings.tgNotify.escalations.enabled")}</span>
            <input
              type="checkbox"
              className="ui2-tn-toggle-input h-4 w-4 accent-primary"
              checked={effective("escalations", "enabled")}
              onChange={(event) => setField("escalations", "enabled", event.target.checked)}
            />
          </label>
          <label className="ui2-tn-field flex flex-wrap items-center justify-between gap-3">
            <span className="ui2-tn-field-name text-sm">{t("ui2.settings.tgNotify.escalations.hours")}</span>
            <input
              type="number"
              min={1}
              max={720}
              className="ui2-tn-number-input w-32 rounded-md border border-input bg-background px-2 py-1 text-right font-mono text-sm tabular-nums"
              value={effective("escalations", "hours")}
              onChange={(event) => setField("escalations", "hours", Number(event.target.value))}
            />
          </label>
          <label className="ui2-tn-field flex flex-wrap items-center justify-between gap-3">
            <span className="ui2-tn-field-name text-sm">{t("ui2.settings.tgNotify.escalations.channel")}</span>
            <select
              className="ui2-tn-select rounded-md border border-input bg-background px-2 py-1 text-sm"
              value={effective("escalations", "channel")}
              onChange={(event) =>
                setField("escalations", "channel", event.target.value as TelegramEscalationChannel)
              }
            >
              {ESCALATION_CHANNELS.map((channel) => (
                <option key={channel} value={channel}>
                  {t(`ui2.settings.tgNotify.escalations.channel.${channel}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="ui2-tn-field flex flex-wrap items-center justify-between gap-3">
            <span className="ui2-tn-field-name text-sm">{t("ui2.settings.tgNotify.escalations.chatId")}</span>
            <input
              type="text"
              className="ui2-tn-text-input w-48 rounded-md border border-input bg-background px-2 py-1 font-mono text-sm"
              value={effective("escalations", "chatId") ?? ""}
              placeholder="—"
              onChange={(event) =>
                setField("escalations", "chatId", event.target.value === "" ? null : event.target.value)
              }
            />
          </label>
          <label className="ui2-tn-field flex flex-wrap items-center justify-between gap-3">
            <span className="ui2-tn-field-name text-sm">{t("ui2.settings.tgNotify.escalations.topicId")}</span>
            <input
              type="text"
              className="ui2-tn-text-input w-48 rounded-md border border-input bg-background px-2 py-1 font-mono text-sm"
              value={effective("escalations", "topicId") ?? ""}
              placeholder="—"
              onChange={(event) =>
                setField("escalations", "topicId", event.target.value === "" ? null : event.target.value)
              }
            />
          </label>
        </div>
      </Ui2Section>

      <Ui2Section title={t("ui2.settings.tgNotify.proactivity.title")} footer={t("ui2.settings.tgNotify.proactivity.hint")}>
        {sectionHead(
          "proactivity",
          effective("proactivity", "mode") !== "only_on_owner_request",
          t("ui2.settings.tgNotify.proactivity.title"),
        )}
        <div className="ui2-tn-fields flex flex-col gap-3">
          <label className="ui2-tn-field flex flex-wrap items-center justify-between gap-3">
            <span className="ui2-tn-field-name text-sm">{t("ui2.settings.tgNotify.proactivity.mode")}</span>
            <select
              className="ui2-tn-select rounded-md border border-input bg-background px-2 py-1 text-sm"
              value={effective("proactivity", "mode")}
              onChange={(event) =>
                setField("proactivity", "mode", event.target.value as TelegramProactivityMode)
              }
            >
              {PROACTIVITY_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {t(`ui2.settings.tgNotify.proactivity.mode.${mode}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="ui2-tn-field flex flex-wrap items-center justify-between gap-3">
            <span className="ui2-tn-field-name text-sm">{t("ui2.settings.tgNotify.proactivity.rarelyMaxPerDay")}</span>
            <input
              type="number"
              min={0}
              max={1000}
              className="ui2-tn-number-input w-32 rounded-md border border-input bg-background px-2 py-1 text-right font-mono text-sm tabular-nums"
              value={effective("proactivity", "rarelyMaxPerDay")}
              disabled={effective("proactivity", "mode") !== "rarely"}
              onChange={(event) => setField("proactivity", "rarelyMaxPerDay", Number(event.target.value))}
            />
          </label>
        </div>
      </Ui2Section>

      <Ui2Section title={t("ui2.settings.tgNotify.changelog.title")}>
        {saveError ? (
          <p role="alert" className="ui2-tn-save-error text-sm text-destructive">
            {t("ui2.settings.tgNotify.saveFailed")}: {saveError}
          </p>
        ) : null}
        <div className="ui2-tn-actions flex items-center gap-3">
          <button
            type="button"
            className="ui2-tn-save rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            disabled={!dirty || saveMutation.isPending}
            onClick={() => saveMutation.mutate(draft)}
          >
            {saveMutation.isPending ? t("ui2.settings.tgNotify.saving") : t("ui2.common.save")}
          </button>
          {dirty ? <span className="ui2-tn-dirty text-xs text-muted-foreground">{t("ui2.settings.tgNotify.unsaved")}</span> : null}
        </div>
        {changelog.length === 0 ? (
          <Ui2EmptyStateView variant="done" title={t("ui2.settings.tgNotify.changelog.empty")} />
        ) : (
          <ol className="ui2-tn-changelog flex flex-col gap-2">
            {changelog.map((entry, index) => (
              <li
                key={`${entry.at}-${entry.field}-${index}`}
                className="ui2-tn-changelog-entry flex flex-col gap-0.5 border-b border-border pb-2 last:border-b-0 last:pb-0"
              >
                <span className="ui2-tn-changelog-field font-mono text-xs">{entry.field}</span>
                <span className="ui2-tn-changelog-change font-mono text-xs">
                  {formatLogValue(entry.from)} → {formatLogValue(entry.to)}
                </span>
                <span className="ui2-tn-changelog-meta text-xs text-muted-foreground">
                  {entry.at ? formatDateTime(entry.at) : ""}
                  {entry.actor ? ` · ${t("ui2.settings.tgNotify.changelog.actor", { actor: entry.actor })}` : ""}
                </span>
              </li>
            ))}
          </ol>
        )}
      </Ui2Section>
    </Ui2Page>
  );
}
