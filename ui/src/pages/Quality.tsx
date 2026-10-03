// myrmidon(1.6-BASELINE part B): the "Quality" page — delivery quality
// metrics over a window (default: the last 14 days), one table by project and
// one by agent role. The numbers come from GET /api/myrmidon/companies/:id/
// baseline/metrics (server part A); until part A is live the page shows its
// empty and error states. Cost numbers always carry their source
// (source.costs) and generatedAt in the header, per the frozen contract.
//
// Tokens only (DESIGN.md): Tailwind palette names, no raw values.

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarRange, Gauge, TrendingUp } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCents, formatNumber } from "@/lib/utils";
import {
  baselineApi,
  baselineMetricsKey,
  isNotEnabledError,
  type BaselineMetricRow,
  type BaselineSource,
} from "@/api/baseline";

const NO_COMPANY = "__none__";

type QualityPreset = "7d" | "14d" | "30d" | "custom";

const PRESET_ORDER: QualityPreset[] = ["7d", "14d", "30d", "custom"];

// myrmidon(UI-RU): preset labels through the fork i18n catalog.
const PRESET_LABEL_KEYS: Record<QualityPreset, string> = {
  "7d": "quality.presets.7d",
  "14d": "quality.presets.14d",
  "30d": "quality.presets.30d",
  custom: "quality.presets.custom",
};

/** Sliding day presets like the Costs page's, plus a default of 14 days.
 *  The upper bound is floored to the current minute so the query key is
 *  stable across re-renders (a ms-precise "now" would churn the cache). */
function computePresetRange(preset: Exclude<QualityPreset, "custom">): { from: string; to: string } {
  const now = new Date();
  const floored = new Date(now);
  floored.setSeconds(0, 0);
  const to = floored.toISOString();
  const from = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - (preset === "7d" ? 7 : preset === "30d" ? 30 : 14),
    0,
    0,
    0,
    0,
  ).toISOString();
  return { from, to };
}

function formatHours(value: number, unit: string = "h"): string {
  return `${value.toFixed(2)} ${unit}`;
}

function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(0)}%`;
}

function formatGeneratedAt(generatedAt: string, language: string = "en"): string {
  const date = new Date(generatedAt);
  if (Number.isNaN(date.getTime())) return generatedAt;
  return date.toLocaleString(language === "ru" ? "ru-RU" : "en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const COSTS_SOURCE_LABEL_KEYS: Record<BaselineSource["costs"], string> = {
  litellm_cost_events: "quality.costsSource.litellm",
  cost_events: "quality.costsSource.costEvents",
  none: "quality.costsSource.none",
};

/** The row label: a project id stays as-is (neutral), null means "no project". */
export function rowKeyLabel(key: string | null, t?: (key: string) => string): string {
  return key ?? (t ? t("quality.noProject") : "No project");
}

/** Top blocked causes as one compact line, most hours first. */
export function topCausesLine(row: BaselineMetricRow, unit: string = "h"): string {
  const causes = row.blockedHours.topCauses.slice(0, 3);
  if (causes.length === 0) return "—";
  return causes.map((cause) => `${cause.cause} ${formatHours(cause.hours, unit)}`).join(", ");
}

interface MetricTableProps {
  title: string;
  description: string;
  rows: BaselineMetricRow[];
  keyHeader: string;
  rowTestId: string;
  t: (key: string) => string;
}

function MetricsTable({ title, description, rows, keyHeader, rowTestId, t }: MetricTableProps) {
  return (
    <Card>
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="px-5 pb-5 pt-2">
        <div className="overflow-x-auto">
          <table className="w-full text-xs" data-testid={rowTestId}>
            <thead>
              <tr className="border-b border-border bg-accent/20">
                <th scope="col" className="px-3 py-2 text-left font-medium text-muted-foreground">{keyHeader}</th>
                <th scope="col" className="px-3 py-2 text-right font-medium text-muted-foreground">{t("quality.metrics.tasksDone")}</th>
                <th scope="col" className="px-3 py-2 text-right font-medium text-muted-foreground">{t("quality.metrics.cycleTime")}</th>
                <th scope="col" className="px-3 py-2 text-right font-medium text-muted-foreground">{t("quality.metrics.reviewTime")}</th>
                <th scope="col" className="px-3 py-2 text-right font-medium text-muted-foreground">{t("quality.metrics.returnRate")}</th>
                <th scope="col" className="px-3 py-2 text-right font-medium text-muted-foreground">{t("quality.metrics.blocked")}</th>
                <th scope="col" className="px-3 py-2 text-right font-medium text-muted-foreground">{t("quality.metrics.topCauses")}</th>
                <th scope="col" className="px-3 py-2 text-right font-medium text-muted-foreground">{t("quality.metrics.runsPerTask")}</th>
                <th scope="col" className="px-3 py-2 text-right font-medium text-muted-foreground">{t("quality.metrics.costPerTask")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key ?? "__none__"} className="border-b border-border last:border-b-0">
                  <td className="px-3 py-2 font-mono">{rowKeyLabel(row.key, t)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatNumber(row.tasksCompleted)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatHours(row.cycleTimeHours.mean, t("quality.hoursUnit"))} / {formatHours(row.cycleTimeHours.median, t("quality.hoursUnit"))} /{" "}
                    {formatHours(row.cycleTimeHours.p90, t("quality.hoursUnit"))}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatHours(row.timeInReviewHours.mean, t("quality.hoursUnit"))} / {formatHours(row.timeInReviewHours.median, t("quality.hoursUnit"))}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums" title={`${row.returnRate.returned}/${row.returnRate.enteredReview}`}>
                    {row.returnRate.enteredReview > 0
                      ? `${formatRate(row.returnRate.rate)} (${row.returnRate.returned}/${row.returnRate.enteredReview})`
                      : "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatHours(row.blockedHours.total, t("quality.hoursUnit"))} / {formatHours(row.blockedHours.mean, t("quality.hoursUnit"))}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{topCausesLine(row, t("quality.hoursUnit"))}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatNumber(row.runsPerTask.total)} ({row.runsPerTask.mean.toFixed(2)})
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatCents(row.costPerTask.totalCents)} / {formatCents(row.costPerTask.meanCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

export interface QualityProps {
  /** Render inside another surface without a second page-level title or breadcrumb. */
  embedded?: boolean;
}

export function Quality({ embedded = false }: QualityProps = {}) {
  const { t, i18n } = useTranslation();
  const language = i18n.language;
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const companyId = selectedCompanyId ?? NO_COMPANY;

  const [preset, setPreset] = useState<QualityPreset>("14d");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  useEffect(() => {
    if (!embedded) setBreadcrumbs([{ label: t("quality.title") }]);
  }, [embedded, setBreadcrumbs]);

  const customReady = preset !== "custom" || (!!customFrom && !!customTo);

  const { from, to } =
    preset === "custom"
      ? {
          from: customFrom ? new Date(`${customFrom}T00:00:00`).toISOString() : "",
          to: customTo ? new Date(`${customTo}T23:59:59.999`).toISOString() : "",
        }
      : computePresetRange(preset);

  const { data, isLoading, error } = useQuery({
    queryKey: baselineMetricsKey(companyId, from || undefined, to || undefined),
    queryFn: () => baselineApi.metrics(companyId, from || undefined, to || undefined),
    enabled: !!selectedCompanyId && customReady,
    staleTime: 30_000,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Gauge} message={t("quality.selectOrganization")} />;
  }

  const showCustomPrompt = preset === "custom" && !customReady;

  return (
    <div className="space-y-6">
      <div className="space-y-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            {embedded ? (
              <h2 className="text-lg font-semibold text-foreground">{t("quality.title")}</h2>
            ) : (
              <h1 className="text-3xl font-semibold tracking-tight">{t("quality.title")}</h1>
            )}
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              {t("quality.intro")}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2" data-testid="quality-window-presets">
            {PRESET_ORDER.map((key) => (
              <Button
                key={key}
                variant={preset === key ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setPreset(key)}
                aria-pressed={preset === key}
              >
                {t(PRESET_LABEL_KEYS[key])}
              </Button>
            ))}
          </div>
        </div>

        {preset === "custom" ? (
          <div className="flex flex-wrap items-center gap-2 border border-border p-3" data-testid="quality-custom-dates">
            <input
              type="date"
              value={customFrom}
              onChange={(event) => setCustomFrom(event.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground"
            />
            <span className="text-sm text-muted-foreground">{t("quality.rangeTo")}</span>
            <input
              type="date"
              value={customTo}
              onChange={(event) => setCustomTo(event.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground"
            />
          </div>
        ) : null}

        {data ? (
          <div
            className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground"
            data-testid="quality-report-meta"
          >
            <span className="flex items-center gap-1.5">
              <CalendarRange className="h-4 w-4" />
              {formatGeneratedAt(data.window.from)} – {formatGeneratedAt(data.window.to)}
            </span>
            <span>
              {t("quality.generated", { time: formatGeneratedAt(data.generatedAt, language) })}
            </span>
            <span className="flex items-center gap-1.5">
              <TrendingUp className="h-4 w-4" />
              {t("quality.costSourceLine", { source: t(COSTS_SOURCE_LABEL_KEYS[data.source.costs]) })}
            </span>
          </div>
        ) : null}
      </div>

      {showCustomPrompt ? (
        <p className="text-sm text-muted-foreground">{t("quality.windowPrompt")}</p>
      ) : isLoading ? (
        <PageSkeleton variant="costs" />
      ) : error ? (
        isNotEnabledError(error) ? (
          <EmptyState
            icon={Gauge}
            title={t("quality.notAvailable")}
            message={t("quality.notAvailableMessage")}
            description={t("quality.notAvailableDescription")}
          />
        ) : (
          <p className="text-sm text-destructive" data-testid="quality-error">
            {(error as Error).message}
          </p>
        )
      ) : !data || (data.byProject.length === 0 && data.byRole.length === 0) ? (
        <EmptyState
          icon={Gauge}
          title={t("quality.emptyWindow")}
          message={t("quality.emptyWindowMessage")}
          description={t("quality.emptyWindowHint")}
        />
      ) : (
        <div className="space-y-4">
          <MetricsTable
            title={t("quality.byProject")}
            description={t("quality.byProjectDescription")}
            rows={data.byProject}
            keyHeader={t("quality.columns.project")}
            rowTestId="quality-by-project-table"
            t={t}
          />
          <MetricsTable
            title={t("quality.byRole")}
            description={t("quality.byRoleDescription")}
            rows={data.byRole}
            keyHeader={t("quality.columns.role")}
            rowTestId="quality-by-role-table"
            t={t}
          />
        </div>
      )}
    </div>
  );
}
