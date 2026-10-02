// myrmidon(1.6-BASELINE part B): the production entry of the "Quality" page —
// the same component as the dev tree's Quality.tsx; kept as a separate file
// so the prebuilt-assets pipeline picks it up exactly like Costs.production.
//
// Tokens only (DESIGN.md): Tailwind palette names, no raw values.

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarRange, Gauge, TrendingUp } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
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

const PRESET_LABELS: Record<QualityPreset, string> = {
  "7d": "Last 7 Days",
  "14d": "Last 14 Days",
  "30d": "Last 30 Days",
  custom: "Custom",
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

function formatHours(value: number): string {
  return `${value.toFixed(2)} h`;
}

function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(0)}%`;
}

function formatGeneratedAt(generatedAt: string): string {
  const date = new Date(generatedAt);
  if (Number.isNaN(date.getTime())) return generatedAt;
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const COSTS_SOURCE_LABELS: Record<BaselineSource["costs"], string> = {
  litellm_cost_events: "LLM gateway cost events",
  cost_events: "adapter cost events",
  none: "no cost source",
};

/** The row label: a project id stays as-is (neutral), null means "no project". */
export function rowKeyLabel(key: string | null): string {
  return key ?? "No project";
}

/** Top blocked causes as one compact line, most hours first. */
export function topCausesLine(row: BaselineMetricRow): string {
  const causes = row.blockedHours.topCauses.slice(0, 3);
  if (causes.length === 0) return "—";
  return causes.map((cause) => `${cause.cause} ${formatHours(cause.hours)}`).join(", ");
}

interface MetricTableProps {
  title: string;
  description: string;
  rows: BaselineMetricRow[];
  keyHeader: string;
  rowTestId: string;
}

function MetricsTable({ title, description, rows, keyHeader, rowTestId }: MetricTableProps) {
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
                <th scope="col" className="px-3 py-2 text-right font-medium text-muted-foreground">Tasks done</th>
                <th scope="col" className="px-3 py-2 text-right font-medium text-muted-foreground">Cycle time (mean / med / p90)</th>
                <th scope="col" className="px-3 py-2 text-right font-medium text-muted-foreground">Review time (mean / med)</th>
                <th scope="col" className="px-3 py-2 text-right font-medium text-muted-foreground">Return rate</th>
                <th scope="col" className="px-3 py-2 text-right font-medium text-muted-foreground">Blocked (total / mean)</th>
                <th scope="col" className="px-3 py-2 text-right font-medium text-muted-foreground">Top blocked causes</th>
                <th scope="col" className="px-3 py-2 text-right font-medium text-muted-foreground">Runs per task</th>
                <th scope="col" className="px-3 py-2 text-right font-medium text-muted-foreground">Cost per task (total / mean)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key ?? "__none__"} className="border-b border-border last:border-b-0">
                  <td className="px-3 py-2 font-mono">{rowKeyLabel(row.key)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatNumber(row.tasksCompleted)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatHours(row.cycleTimeHours.mean)} / {formatHours(row.cycleTimeHours.median)} /{" "}
                    {formatHours(row.cycleTimeHours.p90)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatHours(row.timeInReviewHours.mean)} / {formatHours(row.timeInReviewHours.median)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums" title={`${row.returnRate.returned}/${row.returnRate.enteredReview}`}>
                    {row.returnRate.enteredReview > 0
                      ? `${formatRate(row.returnRate.rate)} (${row.returnRate.returned}/${row.returnRate.enteredReview})`
                      : "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatHours(row.blockedHours.total)} / {formatHours(row.blockedHours.mean)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{topCausesLine(row)}</td>
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

export function Quality() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const companyId = selectedCompanyId ?? NO_COMPANY;

  const [preset, setPreset] = useState<QualityPreset>("14d");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  useEffect(() => {
    setBreadcrumbs([{ label: "Quality" }]);
  }, [setBreadcrumbs]);

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
    return <EmptyState icon={Gauge} message="Select an organization to view quality metrics." />;
  }

  const showCustomPrompt = preset === "custom" && !customReady;

  return (
    <div className="space-y-6">
      <div className="space-y-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Quality</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              Delivery quality over the selected window: cycle time, review time, return rate,
              blocked time, runs and cost per task, by project and by role.
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
                {PRESET_LABELS[key]}
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
            <span className="text-sm text-muted-foreground">to</span>
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
              Generated {formatGeneratedAt(data.generatedAt)}
            </span>
            <span className="flex items-center gap-1.5">
              <TrendingUp className="h-4 w-4" />
              Cost source: {COSTS_SOURCE_LABELS[data.source.costs]}
            </span>
          </div>
        ) : null}
      </div>

      {showCustomPrompt ? (
        <p className="text-sm text-muted-foreground">Select a start and end date to load data.</p>
      ) : isLoading ? (
        <PageSkeleton variant="costs" />
      ) : error ? (
        isNotEnabledError(error) ? (
          <EmptyState
            icon={Gauge}
            title="Baseline metrics are not available"
            message="The server answered that baseline metrics are not enabled on this instance."
            description="The periodic metrics job is off by default; ask the operator to enable the baseline sweep."
          />
        ) : (
          <p className="text-sm text-destructive" data-testid="quality-error">
            {(error as Error).message}
          </p>
        )
      ) : !data || (data.byProject.length === 0 && data.byRole.length === 0) ? (
        <EmptyState
          icon={Gauge}
          title="No tasks completed in this window"
          message="The selected window has no completed tasks, review entries, runs or costs to aggregate."
          description="Try a wider window — metrics count tasks whose transition to done landed inside the window."
        />
      ) : (
        <div className="space-y-4">
          <MetricsTable
            title="By project"
            description="Tasks completed in the window, grouped by their project (rows without a project aggregate together)."
            rows={data.byProject}
            keyHeader="Project"
            rowTestId="quality-by-project-table"
          />
          <MetricsTable
            title="By role"
            description="The same metrics grouped by the role of the agent that completed the task."
            rows={data.byRole}
            keyHeader="Role"
            rowTestId="quality-by-role-table"
          />
        </div>
      )}
    </div>
  );
}
