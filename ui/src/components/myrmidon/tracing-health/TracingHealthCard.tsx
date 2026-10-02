// myrmidon(TRACING-HEALTH part D): the "LLM tracing" status card.
//
// One card in the company settings: a dot + state (ok / ok (idle) / red /
// unknown / not enabled), the reason line from part C's report, one muted
// line per evidence probe, and the window span. Read-only — the operator
// fixes the pipeline (Langfuse v4 ClickHouse `events_core`, the gateway
// callbacks); the board only reports. The non-ok states also raise an
// operator attention card server-side (attention.ts); this surface is the
// glanceable summary.
//
// Tokens only (DESIGN.md): Tailwind palette names, no raw values.

import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import {
  evidenceLines,
  formatWindowLabel,
  stateView,
  tracingHealthApi,
  tracingHealthKey,
  type TracingHealthReport,
} from "./tracingHealthApi";

export interface TracingHealthCardViewProps {
  report: TracingHealthReport | null;
  loading: boolean;
  error: string | null;
}

export function TracingHealthCardView({ report, loading, error }: TracingHealthCardViewProps) {
  const view = report ? stateView(report.state, report.enabled) : null;
  const dotClass =
    view?.dot === "green" ? "bg-emerald-500" : view?.dot === "red" ? "bg-destructive" : "bg-muted-foreground/40";
  return (
    <div className="rounded-lg border border-border bg-background" data-testid="myrmidon-tracing-health-card">
      <div className="flex items-center justify-between gap-3 px-5 pt-5 pb-2">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          <span className="text-base font-medium">LLM tracing</span>
        </div>
        <div className="flex items-center gap-2" data-testid="myrmidon-tracing-health-status">
          <span aria-hidden="true" className={`h-2 w-2 rounded-full ${dotClass}`} />
          <span className="text-xs font-medium text-muted-foreground">{view?.label ?? "…"}</span>
        </div>
      </div>
      <div className="px-5 pb-5 pt-1 space-y-1.5">
        {loading ? (
          <p className="text-sm text-muted-foreground" data-testid="myrmidon-tracing-health-loading">
            Loading tracing health...
          </p>
        ) : error ? (
          <p className="text-sm text-destructive" data-testid="myrmidon-tracing-health-error">
            {error}
          </p>
        ) : report ? (
          <>
            <p
              className={
                report.enabled && (report.state === "degraded" || report.state === "unknown")
                  ? "text-sm text-destructive"
                  : "text-sm text-foreground"
              }
              data-testid="myrmidon-tracing-health-reason"
            >
              {report.reason ?? "no reason given"}
            </p>
            {report.enabled && (
              <ul className="text-xs text-muted-foreground space-y-0.5" data-testid="myrmidon-tracing-health-evidence">
                {evidenceLines(report.evidence).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
            <p className="text-xs text-muted-foreground/70">
              window {formatWindowLabel(report)} · checked{" "}
              {new Date(report.checkedAt).toLocaleTimeString()}
            </p>
          </>
        ) : null}
      </div>
    </div>
  );
}

export function TracingHealthCard() {
  const { data, isLoading, error } = useQuery({
    queryKey: tracingHealthKey,
    queryFn: () => tracingHealthApi.get(),
    refetchInterval: 60_000,
    retry: false,
  });
  return (
    <TracingHealthCardView
      report={data ?? null}
      loading={isLoading}
      error={error instanceof Error ? error.message : null}
    />
  );
}
