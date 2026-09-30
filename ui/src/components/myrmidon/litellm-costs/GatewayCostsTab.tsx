// myrmidon(M2-A): the "Gateway" tab of the Costs page — spend collected from
// the LLM gateway (LiteLLM) per agent/run/issue, and the model catalog with
// the prices the gateway itself charges.
//
// Two lists, one card each. The costs card reads litellm_cost_events through
// /api/myrmidon/companies/:id/litellm/costs and groups by agent with a
// per-run breakdown; the models card reads /api/myrmidian/companies/:id/
// litellm/models. When the instance switch is off the API answers 503 and
// both cards say so (the page is still useful for the adapter ledger).

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Boxes } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/EmptyState";
import { formatCents, formatTokens } from "@/lib/utils";
import { agentsApi } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";
import {
  formatPerMillion,
  isNotEnabledError,
  litellmCostsKey,
  litellmModelsKey,
  litellmCostsApi,
  type LitellmCostRow,
  type LitellmModelView,
} from "./litellmCostsApi";

/** One agent row: totals plus the runs it spent them in. */
export interface GatewayAgentGroup {
  agentId: string;
  agentName: string | null;
  costCents: number;
  inputTokens: number;
  outputTokens: number;
  runs: Array<{
    runId: string | null;
    issueId: string | null;
    costCents: number;
    inputTokens: number;
    outputTokens: number;
    model: string;
    occurredAt: string;
  }>;
}

export function groupByAgent(rows: LitellmCostRow[], agentNames: Map<string, string>): GatewayAgentGroup[] {
  const map = new Map<string, GatewayAgentGroup>();
  for (const row of rows) {
    let group = map.get(row.agentId);
    if (!group) {
      group = {
        agentId: row.agentId,
        agentName: agentNames.get(row.agentId) ?? null,
        costCents: 0,
        inputTokens: 0,
        outputTokens: 0,
        runs: [],
      };
      map.set(row.agentId, group);
    }
    group.costCents += row.costCents;
    group.inputTokens += row.inputTokens;
    group.outputTokens += row.outputTokens;
    group.runs.push({
      runId: row.heartbeatRunId,
      issueId: row.issueId,
      costCents: row.costCents,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      model: row.model,
      occurredAt: row.occurredAt,
    });
  }
  const groups = [...map.values()];
  for (const group of groups) {
    group.runs.sort((a, b) => b.costCents - a.costCents || a.occurredAt.localeCompare(b.occurredAt));
  }
  return groups.sort((a, b) => b.costCents - a.costCents);
}

function GatewayAgentsCard({ companyId, from, to }: { companyId: string; from?: string; to?: string }) {
  const { data: agentsData } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    staleTime: 60_000,
  });
  const agentNames = useMemo(
    () => new Map((agentsData ?? []).map((agent) => [agent.id, agent.name])),
    [agentsData],
  );
  const { data, isLoading, error } = useQuery({
    queryKey: litellmCostsKey(companyId, from, to),
    queryFn: () => litellmCostsApi.costs(companyId, from, to),
    staleTime: 30_000,
  });

  const groups = useMemo(() => groupByAgent(data ?? [], agentNames), [data, agentNames]);
  const totalCents = useMemo(() => groups.reduce((sum, group) => sum + group.costCents, 0), [groups]);

  return (
    <Card>
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle className="text-base">By agent (gateway)</CardTitle>
        <CardDescription>
          Spend the LLM gateway attributed to each bot key, per run and issue. Collected by the periodic sweep.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 px-5 pb-5 pt-2">
        {error ? (
          <p className="text-sm text-destructive">
            {isNotEnabledError(error) ? "LLM gateway cost collection is not enabled on this instance." : (error as Error).message}
          </p>
        ) : isLoading ? (
          <p className="text-sm text-muted-foreground">Loading gateway spend…</p>
        ) : groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">No gateway-collected spend in this period yet.</p>
        ) : (
          <>
            <div className="text-sm text-muted-foreground">Total {formatCents(totalCents)}</div>
            {groups.map((group) => (
              <GatewayAgentRow key={group.agentId} group={group} />
            ))}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function GatewayAgentRow({ group }: { group: GatewayAgentGroup }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-border px-4 py-3">
      <button
        className="flex w-full items-center gap-3 text-left"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="text-sm font-medium">{group.agentName ?? group.agentId.slice(0, 8)}</span>
        <span className="ml-auto text-sm tabular-nums">{formatCents(group.costCents)}</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {formatTokens(group.inputTokens)} in / {formatTokens(group.outputTokens)} out
        </span>
      </button>
      {open ? (
        <div className="mt-2 space-y-1 border-t border-border pt-2">
          {group.runs.slice(0, 10).map((run, index) => (
            <div key={`${run.runId ?? "no-run"}-${index}`} className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="font-mono">{run.runId ? run.runId.slice(0, 8) : "—"}</span>
              <span className="truncate">{run.model}</span>
              <span className="ml-auto tabular-nums">{formatCents(run.costCents)}</span>
            </div>
          ))}
          {group.runs.length > 10 ? (
            <div className="text-xs text-muted-foreground">+{group.runs.length - 10} more rows</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function GatewayModelsCard({ companyId }: { companyId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: litellmModelsKey(companyId),
    queryFn: () => litellmCostsApi.models(companyId),
    staleTime: 60_000,
  });

  return (
    <Card>
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle className="text-base">Models (gateway)</CardTitle>
        <CardDescription>
          The model list with the prices the gateway itself charges — the gateway is the source of truth, this is its last answer.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-5 pb-5 pt-2">
        {error ? (
          <p className="text-sm text-destructive">
            {isNotEnabledError(error) ? "LLM gateway cost collection is not enabled on this instance." : (error as Error).message}
          </p>
        ) : isLoading ? (
          <p className="text-sm text-muted-foreground">Loading models…</p>
        ) : (data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">No models collected yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">Model</th>
                  <th className="py-2 pr-4 font-medium">Provider</th>
                  <th className="py-2 pr-4 text-right font-medium">In / 1M tok</th>
                  <th className="py-2 pr-4 text-right font-medium">Out / 1M tok</th>
                  <th className="py-2 text-right font-medium">Max in</th>
                </tr>
              </thead>
              <tbody>
                {(data ?? []).map((model) => (
                  <GatewayModelRow key={model.modelName} model={model} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function GatewayModelRow({ model }: { model: LitellmModelView }) {
  return (
    <tr className="border-b border-border last:border-b-0">
      <td className="py-2 pr-4 font-mono text-xs">{model.modelName}</td>
      <td className="py-2 pr-4">{model.provider ?? "—"}</td>
      <td className="py-2 pr-4 text-right tabular-nums">{formatPerMillion(model.inputCostPerToken)}</td>
      <td className="py-2 pr-4 text-right tabular-nums">{formatPerMillion(model.outputCostPerToken)}</td>
      <td className="py-2 text-right tabular-nums">
        {model.maxInputTokens ? formatTokens(model.maxInputTokens) : "—"}
      </td>
    </tr>
  );
}

/** The whole "Gateway" tab. */
export function GatewayCostsTab({ companyId, from, to }: { companyId: string; from?: string; to?: string }) {
  return (
    <div className="grid gap-4 xl:grid-cols-(--gtc-31)">
      <GatewayAgentsCard companyId={companyId} from={from} to={to} />
      <GatewayModelsCard companyId={companyId} />
    </div>
  );
}

/** Standalone empty state for a page opened with no company selected. */
export function GatewayCostsNoCompany() {
  return <EmptyState icon={Boxes} message="Select an organization to view gateway costs." />;
}
