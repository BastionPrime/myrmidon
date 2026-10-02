// ui/src/ui2/screens/costs/Ui2Costs.tsx
//
// myrmidon(UI2): the Costs screen in the new shell, behind
// `enableMyrmidonUi2`. Existing APIs only: costsApi.summary (window),
// budgetsApi.overview (policies + incidents + paused counts),
// budgetsApi.resolveIncident, costsApi.byAgent. Mock-only hierarchy
// (nest → caste → line, forecast, ticket limit) stays hidden until the
// backend grows those fields (screen map §2.7).

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { costsApi } from "@/api/costs";
import { budgetsApi } from "@/api/budgets";
import { queryKeys } from "@/lib/queryKeys";
import { useCompany } from "@/context/CompanyContext";
import { formatCents } from "@/lib/utils";
import { useUi2I18n } from "../../i18n/Ui2I18n";
import {
  Ui2EmptyStateView,
  Ui2ErrorState,
  Ui2SkeletonRows,
} from "../../components/ui2StateViews";
import {
  Ui2Page,
  Ui2Section,
  Ui2StatusDot,
  Ui2Tile,
  Ui2Tiles,
} from "../../components/ui2Primitives";

function windowLabel(windowKind: string, t: (key: never) => string): string {
  return windowKind === "lifetime" ? t("ui2.costs.policies.window.lifetime" as never) : t("ui2.costs.policies.window.calendar_month_utc" as never);
}

function scopeTypeLabel(scopeType: string, t: (key: never) => string): string {
  switch (scopeType) {
    case "agent":
      return t("ui2.costs.policies.scopeType.agent" as never);
    case "project":
      return t("ui2.costs.policies.scopeType.project" as never);
    default:
      return t("ui2.costs.policies.scopeType.company" as never);
  }
}

export function Ui2Costs() {
  const { t } = useUi2I18n();
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const [incidentError, setIncidentError] = useState<string | null>(null);
  const companyId = selectedCompanyId ?? "";

  const summaryQuery = useQuery({
    queryKey: queryKeys.costs(companyId),
    queryFn: () => costsApi.summary(companyId),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });

  const budgetsQuery = useQuery({
    queryKey: queryKeys.budgets.overview(companyId),
    queryFn: () => budgetsApi.overview(companyId),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });

  const byAgentQuery = useQuery({
    queryKey: [...queryKeys.costs(companyId), "by-agent"],
    queryFn: () => costsApi.byAgent(companyId),
    enabled: !!selectedCompanyId,
    staleTime: 30_000,
  });

  const incidentMutation = useMutation({
    mutationFn: (input: { incidentId: string; action: "keep_paused" | "raise_budget_and_resume" }) =>
      budgetsApi.resolveIncident(companyId, input.incidentId, { action: input.action }),
    onSuccess: () => {
      setIncidentError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.budgets.overview(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.costs(companyId) });
    },
    onError: (error) => {
      setIncidentError(error instanceof Error ? error.message : String(error));
    },
  });

  const topAgents = useMemo(
    () => [...(byAgentQuery.data ?? [])].sort((left, right) => right.costCents - left.costCents).slice(0, 12),
    [byAgentQuery.data],
  );

  if (summaryQuery.isLoading || budgetsQuery.isLoading) {
    return (
      <Ui2Page title={t("ui2.costs.title")}>
        <Ui2SkeletonRows rows={4} />
      </Ui2Page>
    );
  }

  if (summaryQuery.isError || budgetsQuery.isError) {
    // Errors with cache: keep the tiles rendered when the OTHER query still
    // has data; replace the page only when both sides are cold.
    const error = summaryQuery.error ?? budgetsQuery.error;
    return (
      <Ui2Page title={t("ui2.costs.title")}>
        <Ui2ErrorState
          message={t("ui2.common.error")}
          detail={error instanceof Error ? error.message : null}
          retryLabel={t("ui2.common.retry")}
          onRetry={() => {
            void summaryQuery.refetch();
            void budgetsQuery.refetch();
          }}
          withCache={summaryQuery.isSuccess || budgetsQuery.isSuccess}
        />
        {summaryQuery.isSuccess || budgetsQuery.isSuccess ? (
          <Ui2SkeletonRows rows={2} dense />
        ) : null}
      </Ui2Page>
    );
  }

  const summary = summaryQuery.data;
  const overview = budgetsQuery.data;
  const utilizationPercent = summary ? Math.round(summary.utilizationPercent) : 0;
  const utilizationTone = utilizationPercent >= 90 ? "danger" : utilizationPercent >= 70 ? "warning" : "ok";

  return (
    <Ui2Page title={t("ui2.costs.title")}>
      <Ui2Tiles>
        <Ui2Tile
          label={t("ui2.costs.tile.spent")}
          value={summary ? formatCents(summary.spendCents) : t("ui2.common.unknown")}
          tone={utilizationTone}
        />
        <Ui2Tile
          label={t("ui2.costs.tile.budget")}
          value={summary ? formatCents(summary.budgetCents) : t("ui2.common.unknown")}
        />
        <Ui2Tile label={t("ui2.costs.tile.utilization")} value={`${utilizationPercent}%`} tone={utilizationTone} />
        <Ui2Tile
          label={t("ui2.costs.tile.incidents")}
          value={String(overview?.activeIncidents.length ?? 0)}
          tone={(overview?.activeIncidents.length ?? 0) > 0 ? "danger" : "ok"}
          hint={
            (overview?.pausedAgentCount ?? 0) + (overview?.pausedProjectCount ?? 0) > 0
              ? t("ui2.costs.tile.pausedAgents") + ": " + String((overview?.pausedAgentCount ?? 0) + (overview?.pausedProjectCount ?? 0))
              : undefined
          }
        />
      </Ui2Tiles>

      {overview && overview.activeIncidents.length > 0 ? (
        <Ui2Section title={t("ui2.costs.incidents.title")}>
          {incidentError ? <Ui2ErrorState message={incidentError} withCache /> : null}
          {overview.activeIncidents.map((incident) => (
            <div
              key={incident.id}
              className="ui2-incident flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/40 p-3"
            >
              <div className="ui2-incident-info flex flex-col gap-1">
                <span className="ui2-incident-scope text-sm font-medium">
                  {t("ui2.costs.policies.scope", {
                    type: scopeTypeLabel(incident.scopeType, t),
                    name: incident.scopeName,
                  })}
                </span>
                <span className="ui2-incident-amount font-mono text-xs text-muted-foreground tabular-nums">
                  {t("ui2.costs.policies.observed", {
                    amount: formatCents(incident.amountObserved),
                    percent: Math.round((incident.amountObserved / Math.max(1, incident.amountLimit)) * 100),
                  })}
                </span>
              </div>
              <div className="ui2-incident-actions flex items-center gap-2">
                <button
                  type="button"
                  className="ui2-incident-keep rounded-md border border-border px-3 py-1 text-xs hover:bg-accent disabled:opacity-50"
                  disabled={incidentMutation.isPending}
                  onClick={() => incidentMutation.mutate({ incidentId: incident.id, action: "keep_paused" })}
                >
                  {t("ui2.costs.incidents.keepPaused")}
                </button>
                <button
                  type="button"
                  className="ui2-incident-raise rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
                  disabled={incidentMutation.isPending}
                  onClick={() => incidentMutation.mutate({ incidentId: incident.id, action: "raise_budget_and_resume" })}
                >
                  {t("ui2.costs.incidents.raiseAndResume")}
                </button>
              </div>
            </div>
          ))}
        </Ui2Section>
      ) : null}

      <Ui2Section title={t("ui2.costs.policies.title")}>
        {(overview?.policies ?? []).length === 0 ? (
          <Ui2EmptyStateView variant="done" title={t("ui2.costs.policies.empty")} />
        ) : (
          <div className="ui2-policies flex flex-col gap-2">
            {(overview?.policies ?? []).map((policy) => {
              const tone =
                policy.status === "hard_stop" ? "danger" : policy.status === "warning" ? "warning" : "ok";
              return (
                <div
                  key={policy.policyId}
                  className="ui2-policy flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3"
                >
                  <div className="ui2-policy-info flex flex-col gap-1">
                    <span className="ui2-policy-scope text-sm font-medium">
                      {t("ui2.costs.policies.scope", {
                        type: scopeTypeLabel(policy.scopeType, t),
                        name: policy.scopeName,
                      })}
                    </span>
                    <span className="ui2-policy-amount font-mono text-xs text-muted-foreground tabular-nums">
                      {t("ui2.costs.policies.amount", {
                        amount: formatCents(policy.amount),
                        window: windowLabel(policy.windowKind, t),
                      })}
                    </span>
                  </div>
                  <div className="ui2-policy-state flex items-center gap-2 text-xs">
                    <Ui2StatusDot tone={tone} />
                    <span className="ui2-policy-observed font-mono tabular-nums">
                      {t("ui2.costs.policies.observed", {
                        amount: formatCents(policy.observedAmount),
                        percent: Math.round(policy.utilizationPercent),
                      })}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Ui2Section>

      <Ui2Section title={t("ui2.costs.agents.title")}>
        {byAgentQuery.isLoading ? (
          <Ui2SkeletonRows rows={3} dense />
        ) : topAgents.length === 0 ? (
          <Ui2EmptyStateView variant="done" title={t("ui2.costs.agents.empty")} />
        ) : (
          <table className="ui2-costs-agents w-full text-sm">
            <thead>
              <tr className="ui2-costs-agents-head text-left text-xs text-muted-foreground">
                <th className="ui2-costs-agents-agent py-1 font-medium">{t("ui2.costs.agents.agent")}</th>
                <th className="ui2-costs-agents-cost py-1 text-right font-medium">{t("ui2.costs.agents.cost")}</th>
                <th className="ui2-costs-agents-tokens py-1 text-right font-medium">{t("ui2.costs.agents.tokens")}</th>
                <th className="ui2-costs-agents-runs py-1 text-right font-medium">{t("ui2.costs.agents.runs")}</th>
              </tr>
            </thead>
            <tbody>
              {topAgents.map((row) => (
                <tr key={row.agentId} className="ui2-costs-agents-row border-t border-border">
                  <td className="ui2-costs-agents-agent-name py-1.5">{row.agentName ?? t("ui2.costs.agents.unnamed")}</td>
                  <td className="ui2-costs-agents-agent-cost py-1.5 text-right font-mono tabular-nums">
                    {formatCents(row.costCents)}
                  </td>
                  <td className="ui2-costs-agents-agent-tokens py-1.5 text-right font-mono tabular-nums">
                    {row.inputTokens.toLocaleString()} / {row.outputTokens.toLocaleString()}
                  </td>
                  <td className="ui2-costs-agents-agent-runs py-1.5 text-right font-mono tabular-nums">
                    {row.apiRunCount + row.subscriptionRunCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Ui2Section>
    </Ui2Page>
  );
}
