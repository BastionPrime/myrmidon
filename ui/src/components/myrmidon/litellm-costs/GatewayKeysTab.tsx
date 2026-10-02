// myrmidon(M2-B): the "Gateway keys" tab — one gateway key per agent, held in
// the company secret store, plus the gateway's fallback topology with the loops
// the same walk the save path uses finds in it.
//
// Two cards. The keys card reads /api/myrmidon/companies/:id/litellm/keys and
// shows, per agent, whether a key of its own exists and under which secret name
// — never the value. The fallbacks card reads …/litellm/fallbacks and lists the
// loops; a loop is what a save would reject, so seeing it here is how an
// operator finds one before a write. When the instance switch is off both
// endpoints answer 503 and the cards say so.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { KeyRound, TriangleAlert } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/EmptyState";
import { agentsApi } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";
import {
  countKeyedAgents,
  isKeysNotEnabledError,
  litellmFallbacksKey,
  litellmKeysApi,
  litellmKeysKey,
  type AgentGatewayKeyView,
  type GatewayFallbackReport,
} from "./litellmKeysApi";

/** One line per agent: the display name, the secret, and whether it is set. */
export interface GatewayKeyRow {
  agentId: string;
  agentName: string | null;
  secretName: string;
  present: boolean;
}

/** Joins the key views with the agent names the page already knows. */
export function keyRows(keys: AgentGatewayKeyView[], agentNames: Map<string, string>): GatewayKeyRow[] {
  return keys
    .map((entry) => ({
      agentId: entry.agentId,
      agentName: agentNames.get(entry.agentId) ?? null,
      secretName: entry.secretName,
      present: entry.present,
    }))
    .sort((a, b) => (a.agentName ?? a.agentId).localeCompare(b.agentName ?? b.agentId));
}

/** The loops of a report, as display strings; an unreadable gateway yields none. */
export function cycleLines(report: GatewayFallbackReport | undefined): string[] {
  if (!report || report.error) return [];
  return report.cycles.map((cycle) => cycle.described);
}

function GatewayKeysCard({ companyId }: { companyId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: litellmKeysKey(companyId),
    queryFn: () => litellmKeysApi.keys(companyId),
    staleTime: 60_000,
  });
  const agents = useQuery({ queryKey: queryKeys.agents.list(companyId), queryFn: () => agentsApi.list(companyId) });
  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of agents.data ?? []) map.set(agent.id, agent.name);
    return map;
  }, [agents.data]);
  const rows = useMemo(() => keyRows(data ?? [], names), [data, names]);
  const counts = countKeyedAgents(data ?? []);

  return (
    <Card>
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle className="text-base">Keys per agent</CardTitle>
        <CardDescription>
          Each agent authenticates with its own gateway key, so the gateway attributes its spend to that key.
          Only the secret name and the key's fingerprint are shown — never the value.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 px-5 pb-5 pt-2">
        {error ? (
          <p className="text-sm text-destructive">
            {isKeysNotEnabledError(error) ? "Gateway key management is not enabled on this instance." : (error as Error).message}
          </p>
        ) : isLoading ? (
          <p className="text-sm text-muted-foreground">Loading gateway keys…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No agents yet.</p>
        ) : (
          <>
            <div className="text-sm text-muted-foreground">
              {counts.keyed} of {counts.total} agents have a key of their own.
            </div>
            {rows.map((row) => (
              <div key={row.agentId} className="flex items-center gap-3 border border-border px-4 py-3">
                <span className="text-sm font-medium">{row.agentName ?? row.agentId.slice(0, 8)}</span>
                <span className="truncate font-mono text-xs text-muted-foreground">{row.secretName}</span>
                <span className="ml-auto text-xs tabular-nums">
                  {row.present ? "key set" : "no key yet"}
                </span>
              </div>
            ))}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function GatewayFallbacksCard({ companyId }: { companyId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: litellmFallbacksKey(companyId),
    queryFn: () => litellmKeysApi.fallbacks(companyId),
    staleTime: 60_000,
  });
  const lines = cycleLines(data);

  return (
    <Card>
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle className="text-base">Fallback loops</CardTitle>
        <CardDescription>
          A fallback chain that returns to a model it already contains retries the request that just failed.
          Saving such a chain is refused; this is the same check reading the gateway's live topology.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 px-5 pb-5 pt-2">
        {error ? (
          <p className="text-sm text-destructive">
            {isKeysNotEnabledError(error) ? "Gateway key management is not enabled on this instance." : (error as Error).message}
          </p>
        ) : isLoading ? (
          <p className="text-sm text-muted-foreground">Reading the gateway topology…</p>
        ) : data?.error ? (
          <p className="text-sm text-muted-foreground">{data.error}</p>
        ) : lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">No loops in the gateway's fallback topology.</p>
        ) : (
          <>
            <div className="flex items-center gap-2 text-sm text-destructive">
              <TriangleAlert className="h-4 w-4" />
              {lines.length} loop{lines.length === 1 ? "" : "s"} found
            </div>
            {lines.map((line) => (
              <div key={line} className="border border-border px-4 py-2 font-mono text-xs">
                {line}
              </div>
            ))}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** The whole "Gateway keys" tab. */
export function GatewayKeysTab({ companyId }: { companyId: string }) {
  return (
    <div className="grid gap-4 xl:grid-cols-(--gtc-31)">
      <GatewayKeysCard companyId={companyId} />
      <GatewayFallbacksCard companyId={companyId} />
    </div>
  );
}

/** Standalone empty state for a page opened with no company selected. */
export function GatewayKeysNoCompany() {
  return <EmptyState icon={KeyRound} message="Select an organization to view gateway keys." />;
}