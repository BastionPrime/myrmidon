// ui/src/ui2/screens/settings/runs-queue/Ui2RunsSettings.tsx
//
// myrmidon(UI2): Settings → "Runs & queue" in the new shell. This is the
// closest-to-port screen of the set: the vendor already ships
// RuntimeLimitsSettingsPanel (the four admission ceilings, GET/PATCH
// /api/myrmidon/runtime-limits, applied without restart). The ui2 variant
// restyles the same contract; per the map "the ceilings panel moves over
// almost ready". P0–P3 priority-class slots, TTL/timeouts/retries per
// class, pool-growth threshold and hibernation rules are NOT in the API —
// hidden until the backend grows them (map §2.13).

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RunLimitKey, RunLimits, RunLimitsPatch, RunLimitsSource } from "@paperclipai/shared";
import { runtimeLimitsApi, runtimeLimitsQueryKey, type RuntimeLimitsView } from "@/components/myrmidon/runtimeLimitsApi";
import { useUi2I18n } from "../../../i18n/Ui2I18n";
import { Ui2ErrorState, Ui2SkeletonRows } from "../../../components/ui2StateViews";
import { Ui2Page, Ui2Section } from "../../../components/ui2Primitives";

const LIMIT_FIELDS: Array<{ key: RunLimitKey; labelKey: "ui2.settings.runs.maxConcurrentRuns" | "ui2.settings.runs.maxStartsPerMinute" | "ui2.settings.runs.minFreeMemoryMb" | "ui2.settings.runs.runMemoryEstimateMb"; canOff: boolean }> = [
  { key: "maxConcurrentRuns", labelKey: "ui2.settings.runs.maxConcurrentRuns", canOff: true },
  { key: "maxStartsPerMinute", labelKey: "ui2.settings.runs.maxStartsPerMinute", canOff: true },
  { key: "minFreeMemoryMb", labelKey: "ui2.settings.runs.minFreeMemoryMb", canOff: true },
  { key: "runMemoryEstimateMb", labelKey: "ui2.settings.runs.runMemoryEstimateMb", canOff: false },
];

function sourceLabel(source: RunLimitsSource, t: (key: never) => string): string {
  switch (source) {
    case "settings":
      return t("ui2.settings.runs.source.settings" as never);
    case "env":
      return t("ui2.settings.runs.source.env" as never);
    default:
      return t("ui2.settings.runs.source.default" as never);
  }
}

export function Ui2RunsSettings() {
  const { t } = useUi2I18n();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Partial<RunLimits> | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const limitsQuery = useQuery({
    queryKey: runtimeLimitsQueryKey,
    queryFn: () => runtimeLimitsApi.get(),
  });

  const view = limitsQuery.data;
  const effective: RunLimits | null = draft
    ? ({ ...(view?.limits ?? null), ...draft } as RunLimits | null)
    : (view?.limits ?? null);

  useEffect(() => {
    setDraft(null);
    setSaveError(null);
  }, [view]);

  const saveMutation = useMutation({
    mutationFn: (patch: RunLimitsPatch) => runtimeLimitsApi.update(patch),
    onSuccess: (next) => {
      setSaveError(null);
      setDraft(null);
      queryClient.setQueryData(runtimeLimitsQueryKey, next);
    },
    onError: (error) => {
      setSaveError(error instanceof Error ? error.message : String(error));
    },
  });

  if (limitsQuery.isLoading) {
    return (
      <Ui2Page title={t("ui2.settings.runs.title")} subtitle={t("ui2.settings.runs.subtitle")}>
        <Ui2SkeletonRows rows={4} />
      </Ui2Page>
    );
  }

  if (limitsQuery.isError || !view || !effective) {
    return (
      <Ui2Page title={t("ui2.settings.runs.title")} subtitle={t("ui2.settings.runs.subtitle")}>
        <Ui2ErrorState
          message={t("ui2.common.error")}
          detail={limitsQuery.error instanceof Error ? limitsQuery.error.message : null}
          retryLabel={t("ui2.common.retry")}
          onRetry={() => void limitsQuery.refetch()}
        />
      </Ui2Page>
    );
  }

  const dirty =
    draft != null && LIMIT_FIELDS.some((field) => (draft[field.key] ?? null) !== null && draft[field.key] !== view.limits[field.key]);

  return (
    <Ui2Page title={t("ui2.settings.runs.title")} subtitle={t("ui2.settings.runs.subtitle")}>
      <Ui2Section title={t("ui2.settings.runs.title")}>
        <div className="ui2-run-limits flex flex-col gap-4">
          {LIMIT_FIELDS.map((field) => {
            const value = effective[field.key];
            const source = view.sources[field.key];
            const off = value == null;
            return (
              <div key={field.key} className="ui2-run-limit flex flex-wrap items-center justify-between gap-3">
                <div className="ui2-run-limit-label flex flex-col">
                  <label htmlFor={`ui2-run-limit-${field.key}`} className="ui2-run-limit-name text-sm font-medium">
                    {t(field.labelKey)}
                  </label>
                  <span className="ui2-run-limit-source text-xs text-muted-foreground">
                    {sourceLabel(source, t)}
                  </span>
                </div>
                <div className="ui2-run-limit-control flex items-center gap-2">
                  <input
                    id={`ui2-run-limit-${field.key}`}
                    type="number"
                    min={1}
                    className="ui2-run-limit-input w-32 rounded-md border border-input bg-background px-2 py-1 text-right font-mono text-sm tabular-nums"
                    value={off ? "" : String(value ?? "")}
                    placeholder={t("ui2.settings.runs.off")}
                    disabled={off}
                    onChange={(event) => {
                      const parsed = event.target.value === "" ? null : Number(event.target.value);
                      setDraft((prev) => ({
                        ...(prev ?? {}),
                        [field.key]: parsed != null && Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null,
                      }));
                    }}
                  />
                  {field.canOff ? (
                    <label className="ui2-run-limit-off flex items-center gap-1 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={off}
                        onChange={(event) => {
                          setDraft((prev) => ({
                            ...(prev ?? {}),
                            [field.key]: event.target.checked ? null : (view.limits[field.key] ?? 1),
                          }));
                        }}
                      />
                      {t("ui2.settings.runs.off")}
                    </label>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </Ui2Section>

      {saveError ? <Ui2ErrorState message={t("ui2.settings.runs.saveError", { reason: saveError })} withCache /> : null}

      <div className="ui2-run-limits-actions flex items-center gap-3">
        <button
          type="button"
          className="ui2-run-limits-save rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
          disabled={!dirty || saveMutation.isPending}
          onClick={() => {
            if (draft == null) return;
            const patch: RunLimitsPatch = {};
            for (const field of LIMIT_FIELDS) {
              if (draft[field.key] !== undefined && draft[field.key] !== view.limits[field.key]) {
                (patch as Record<string, unknown>)[field.key] = draft[field.key];
              }
            }
            saveMutation.mutate(patch);
          }}
        >
          {t("ui2.settings.runs.save")}
        </button>
        <button
          type="button"
          className="ui2-run-limits-reset rounded-md border border-border px-4 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
          disabled={!dirty || saveMutation.isPending}
          onClick={() => setDraft(null)}
        >
          {t("ui2.settings.runs.reset")}
        </button>
        {saveMutation.isPending ? <Ui2SkeletonRows rows={1} dense /> : null}
      </div>
    </Ui2Page>
  );
}
