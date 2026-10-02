// ui/src/ui2/screens/agent-overview/Ui2AgentOverview.tsx
//
// myrmidon(UI2): the new "Overview" tab content for the agent card, behind
// `enableMyrmidonUi2`. Per the screen map note, AgentDetail (4.6k lines) is
// NOT rewritten; this component is mounted by the existing page at its
// overview slot (single marked line) and renders from the SAME data the
// vendor overview tab already loads: heartbeatsApi.list (runs),
// costsApi.byAgent (spend), budgetsApi.overview (agent policy). Actions
// (pause/resume, retire) stay on the vendor action bar — parity first.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Agent, HeartbeatRun } from "@paperclipai/shared";
import { costsApi } from "@/api/costs";
import { budgetsApi } from "@/api/budgets";
import { heartbeatsApi } from "@/api/heartbeats";
import { queryKeys } from "@/lib/queryKeys";
import { formatCents, formatTokens } from "@/lib/utils";
import { useUi2I18n } from "../../i18n/Ui2I18n";
import {
  Ui2EmptyStateView,
  Ui2ErrorState,
  Ui2SkeletonRows,
} from "../../components/ui2StateViews";
import {
  Ui2Section,
  Ui2StatusDot,
  Ui2Tile,
  Ui2Tiles,
} from "../../components/ui2Primitives";

function runCostUsd(run: HeartbeatRun): number | null {
  const usage = run.usageJson as Record<string, unknown> | null;
  const result = run.resultJson as Record<string, unknown> | null;
  for (const source of [usage, result]) {
    if (!source) continue;
    for (const key of ["costUsd", "cost_usd", "total_cost_usd"]) {
      const value = source[key];
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
  }
  return null;
}

function runTokens(run: HeartbeatRun): { input: number; output: number } {
  const usage = (run.usageJson ?? null) as Record<string, unknown> | null;
  const read = (keys: string[]): number => {
    for (const key of keys) {
      const value = usage?.[key];
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
    return 0;
  };
  return {
    input: read(["inputTokens", "input_tokens"]),
    output: read(["outputTokens", "output_tokens"]),
  };
}

export function Ui2AgentOverview({
  agent,
  agentId,
  companyId,
  runs,
}: {
  agent: Agent;
  agentId: string;
  companyId: string;
  runs: HeartbeatRun[];
}) {
  const { t } = useUi2I18n();

  const spendQuery = useQuery({
    queryKey: [...queryKeys.costs(companyId), "by-agent", agentId],
    queryFn: () => costsApi.byAgent(companyId),
    enabled: !!companyId,
    staleTime: 30_000,
  });

  const budgetsQuery = useQuery({
    queryKey: queryKeys.budgets.overview(companyId),
    queryFn: () => budgetsApi.overview(companyId),
    enabled: !!companyId,
    staleTime: 30_000,
  });

  const sortedRuns = useMemo(
    () =>
      [...runs].sort(
        (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
      ),
    [runs],
  );

  const runs24h = useMemo(() => {
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    return sortedRuns.filter((run) => new Date(run.createdAt).getTime() >= dayAgo);
  }, [sortedRuns]);

  const agentSpend = useMemo(
    () => (spendQuery.data ?? []).find((row) => row.agentId === agentId) ?? null,
    [spendQuery.data, agentId],
  );

  const agentPolicy = useMemo(
    () => (budgetsQuery.data?.policies ?? []).find((policy) => policy.scopeType === "agent" && policy.scopeId === agentId) ?? null,
    [budgetsQuery.data, agentId],
  );

  const statusTone = agent.status === "error" ? "danger" : agent.status === "paused" ? "warning" : agent.status === "active" || agent.status === "running" ? "ok" : "default";

  return (
    <div className="ui2-agent-overview flex flex-col gap-6">
      <Ui2Tiles>
        <Ui2Tile
          label={t("ui2.agent.overview.status")}
          value={agent.status}
          tone={statusTone}
        />
        <Ui2Tile
          label={t("ui2.agent.overview.runs.title")}
          value={String(runs24h.length)}
          hint={t("ui2.agent.overview.lastRun") + ": " + (sortedRuns[0] ? new Date(sortedRuns[0].createdAt).toLocaleString() : t("ui2.agent.overview.noRuns"))}
        />
        <Ui2Tile
          label={t("ui2.agent.overview.spend.month")}
          value={agentSpend ? formatCents(agentSpend.costCents) : t("ui2.common.unknown")}
          hint={agentSpend ? `${formatTokens(agentSpend.inputTokens)} → ${formatTokens(agentSpend.outputTokens)}` : undefined}
        />
        <Ui2Tile
          label={t("ui2.agent.overview.budget.title")}
          value={
            agentPolicy
              ? t("ui2.agent.overview.budget.utilization", {
                  percent: Math.round(agentPolicy.utilizationPercent),
                  amount: formatCents(agentPolicy.amount),
                })
              : t("ui2.agent.overview.budget.none")
          }
          tone={agentPolicy ? (agentPolicy.status === "hard_stop" ? "danger" : agentPolicy.status === "warning" ? "warning" : "ok") : "default"}
        />
      </Ui2Tiles>

      <Ui2Section title={t("ui2.agent.overview.runs.title")}>
        {runs24h.length === 0 ? (
          <Ui2EmptyStateView variant="done" title={t("ui2.agent.overview.runs.empty")} />
        ) : (
          <table className="ui2-agent-runs w-full text-sm">
            <thead>
              <tr className="ui2-agent-runs-head text-left text-xs text-muted-foreground">
                <th className="ui2-agent-runs-status py-1 font-medium">{t("ui2.agent.overview.status")}</th>
                <th className="ui2-agent-runs-result py-1 font-medium">{t("ui2.agent.overview.runResult")}</th>
                <th className="ui2-agent-runs-cost py-1 text-right font-medium">{t("ui2.agent.overview.runCost")}</th>
                <th className="ui2-agent-runs-tokens py-1 text-right font-medium">{t("ui2.agent.overview.runTokens")}</th>
              </tr>
            </thead>
            <tbody>
              {runs24h.slice(0, 10).map((run) => {
                const tokens = runTokens(run);
                const cost = runCostUsd(run);
                const tone = run.status === "failed" ? "danger" : run.status === "running" || run.status === "queued" ? "ok" : "muted";
                return (
                  <tr key={run.id} className="ui2-agent-runs-row border-t border-border">
                    <td className="ui2-agent-run-status py-1.5">
                      <span className="inline-flex items-center gap-2">
                        <Ui2StatusDot tone={tone} />
                        {run.status}
                      </span>
                    </td>
                    <td className="ui2-agent-run-created py-1.5 font-mono text-xs text-muted-foreground">
                      {new Date(run.createdAt).toLocaleString()}
                    </td>
                    <td className="ui2-agent-run-cost py-1.5 text-right font-mono tabular-nums">
                      {cost == null ? t("ui2.common.unknown") : `$${cost.toFixed(4)}`}
                    </td>
                    <td className="ui2-agent-run-tokens py-1.5 text-right font-mono tabular-nums">
                      {formatTokens(tokens.input)} / {formatTokens(tokens.output)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Ui2Section>

      {spendQuery.isError ? <Ui2ErrorState message={t("ui2.common.error")} withCache /> : null}
      {spendQuery.isLoading || budgetsQuery.isLoading ? <Ui2SkeletonRows rows={2} dense /> : null}
    </div>
  );
}
