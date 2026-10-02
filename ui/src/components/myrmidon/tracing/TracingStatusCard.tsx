// myrmidon(TRACING-HEALTH): the "LLM tracing" status card of the Costs page.
//
// Renders the health report from GET /api/myrmidon/tracing/health (part C):
// the state, the reason, and the evidence numbers (events in the window,
// delivery ratio, callback error rate, legacy rejections). Polls via
// react-query like the sibling myrmidon panels (30 s refresh, the same TTL
// the server caches its probes for). The card shows a graceful "not enabled"
// state when the instance never configured tracing, and a probe-failure
// "unknown" state rather than pretending health.
//
// The card is deliberately honest about the incident class it exists for:
// degraded tracing ran unnoticed for weeks because no board surface showed
// it — this surface is the fix. The operator attention signal (the
// attention-feed card) is generated server-side; this component is the
// inspect target.

import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  formatCount,
  formatRate,
  formatRatio,
  isNotEnabledError,
  tracingHealthApi,
  tracingHealthQueryKey,
  type TracingHealthReportView,
  type TracingHealthState,
} from "./tracingHealthApi";

const STATE_LABEL: Record<TracingHealthState, string> = {
  ok: "Tracing is flowing",
  idle: "No gateway traffic",
  degraded: "Tracing is degraded",
  unknown: "Tracing state unknown",
};

const STATE_TONE: Record<TracingHealthState, string> = {
  ok: "text-muted-foreground",
  idle: "text-muted-foreground",
  degraded: "text-destructive",
  unknown: "text-muted-foreground",
};

export function TracingStatusCardView({ report }: { report: TracingHealthReportView | null }) {
  const state = report?.state ?? "unknown";
  return (
    <Card data-testid="myrmidon-tracing-card">
      <CardHeader className="px-5 pt-5 pb-2">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-base">LLM tracing</CardTitle>
          {report ? (
            <span
              className={`text-sm font-medium ${STATE_TONE[state]}`}
              data-testid="myrmidon-tracing-state"
            >
              {STATE_LABEL[state]}
            </span>
          ) : null}
        </div>
        <CardDescription>
          Whether trace events keep flowing while the LLM gateway serves traffic.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 px-5 pb-5 pt-2">
        {!report || !report.enabled ? (
          <p className="text-sm text-muted-foreground" data-testid="myrmidon-tracing-not-enabled">
            LLM tracing health is not configured on this instance.
          </p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground" data-testid="myrmidon-tracing-reason">
              {report.reason ?? "checked"}
            </p>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-xs text-muted-foreground">Events in window</dt>
                <dd className="tabular-nums" data-testid="myrmidon-tracing-events">
                  {formatCount(report.evidence.eventsInWindow)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Gateway requests</dt>
                <dd className="tabular-nums" data-testid="myrmidon-tracing-requests">
                  {formatCount(report.evidence.gatewayRequestsInWindow)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Delivery ratio</dt>
                <dd className="tabular-nums" data-testid="myrmidon-tracing-ratio">
                  {formatRatio(report.evidence.deliveryRatio)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Legacy rejections</dt>
                <dd className="tabular-nums" data-testid="myrmidon-tracing-rejections">
                  {formatCount(report.evidence.legacyRejections)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Callback error rate</dt>
                <dd className="tabular-nums" data-testid="myrmidon-tracing-errors">
                  {formatRate(report.evidence.callbackErrorRate)}
                </dd>
              </div>
            </dl>
            <p className="text-xs text-muted-foreground" data-testid="myrmidon-tracing-checked-at">
              checked {report.checkedAt}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function TracingStatusCard() {
  const { data, error } = useQuery({
    queryKey: tracingHealthQueryKey,
    queryFn: () => tracingHealthApi.health(),
    refetchInterval: 30_000,
    retry: false,
  });
  if (error) {
    if (isNotEnabledError(error)) {
      return <TracingStatusCardView report={null} />;
    }
    return (
      <Card data-testid="myrmidon-tracing-card-error">
        <CardHeader className="px-5 pt-5 pb-2">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">LLM tracing</CardTitle>
          </div>
          <CardDescription>Whether trace events keep flowing while the LLM gateway serves traffic.</CardDescription>
        </CardHeader>
        <CardContent className="px-5 pb-5 pt-2">
          <p className="text-sm text-destructive" data-testid="myrmidon-tracing-error">
            {(error as Error).message}
          </p>
        </CardContent>
      </Card>
    );
  }
  return <TracingStatusCardView report={data ?? null} />;
}
