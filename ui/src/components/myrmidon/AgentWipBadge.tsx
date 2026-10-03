// WIP-LIMIT 1.6.1 part B (UI): the per-agent WIP badge for the agents list.
// Reads GET /api/myrmidon/companies/:companyId/wip-limit/status (part A; see
// ui/src/api/wipLimit.ts) once for the whole list and renders one badge per
// agent row: "wip/limit" plus an "over limit" state when the agent is past its
// limit. Tokens only (DESIGN.md).
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "@/context/CompanyContext";
import { wipLimitApi, wipLimitStatusQueryKey, type WipLimitStatusRow } from "@/api/wipLimit";

export function AgentWipBadgeView({ row }: { row: WipLimitStatusRow }) {
  if (row.limit == null) {
    // No limit configured: show the raw load without the denominator, so the
    // column stays informative instead of going blank.
    return (
      <span
        className="whitespace-nowrap text-xs text-muted-foreground"
        data-testid="agent-wip-badge"
        title="Work in progress (no limit set)"
      >
        {row.wip} wip
      </span>
    );
  }
  const over = row.overLimit || row.wip > row.limit;
  return (
    <span
      className={
        over
          ? "inline-flex items-center gap-1 rounded-full border border-amber-600 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400 whitespace-nowrap"
          : "inline-flex items-center rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground whitespace-nowrap"
      }
      data-testid="agent-wip-badge"
      data-over-limit={over ? "true" : "false"}
      title={
        over
          ? `Over the WIP limit (${row.inProgress} in progress, ${row.inReview} in review)`
          : `In progress ${row.inProgress}, in review ${row.inReview}`
      }
    >
      {row.wip}/{row.limit}
      {over ? " over" : ""}
    </span>
  );
}

/**
 * One shared status query for the whole agents list. Returns a map the rows
 * index by agent id; agents without a row render no badge.
 */
export function useAgentWipStatus(): Map<string, WipLimitStatusRow> {
  const { selectedCompanyId } = useCompany();
  const query = useQuery({
    queryKey: selectedCompanyId
      ? wipLimitStatusQueryKey(selectedCompanyId)
      : (["myrmidon", "wip-limit", "status", "__disabled__"] as const),
    queryFn: () => wipLimitApi.status(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    retry: false,
    refetchInterval: 30_000,
  });
  return useMemo(
    () => new Map((query.data ?? []).map((row) => [row.agentId, row])),
    [query.data],
  );
}

export function AgentWipBadge({ agentId }: { agentId: string }) {
  const rows = useAgentWipStatus();
  const row = rows.get(agentId);
  if (!row) return null;
  return <AgentWipBadgeView row={row} />;
}
