// myrmidon(UI-0a): status strip data for the UI-2.0 top bar — the aggregate
// "colony / fleet / forecast / decisions" chips. The dedicated
// GET /myrmidon/status-strip endpoint is planned (screen-map §4.6
// STATUS-STRIP); until it exists the shell composes the same numbers from
// the vendor aggregate endpoints already shipped (dashboard summary +
// sidebar badges) so no new server surface is required for UI-0a. When
// STATUS-STRIP lands, only this hook changes.
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { dashboardApi } from "@/api/dashboard";
import { sidebarBadgesApi } from "@/api/sidebarBadges";

export interface Ui2StatusStrip {
  /** Colony: agents working vs total (from dashboard summary). */
  colonyActive: number;
  colonyTotal: number;
  /** Fleet attention flag: error agents or failed runs need a look. */
  fleetAttention: boolean;
  /** Month spend cents + budget cents (forecast chip). */
  monthSpendCents: number;
  monthBudgetCents: number;
  /** Decisions waiting for the owner. */
  attentionCount: number;
}

export function useUi2StatusStrip(companyId: string | null | undefined): Ui2StatusStrip | null {
  const dashboard = useQuery({
    queryKey: queryKeys.dashboard(companyId ?? ""),
    queryFn: () => dashboardApi.summary(companyId!),
    enabled: companyId != null,
  });
  const badges = useQuery({
    queryKey: queryKeys.sidebarBadges(companyId ?? ""),
    queryFn: () => sidebarBadgesApi.get(companyId!),
    enabled: companyId != null,
  });

  if (companyId == null || !dashboard.data || !badges.data) return null;

  const agents = dashboard.data.agents;
  const colonyActive = agents.running;
  const colonyTotal = agents.active + agents.paused + agents.error;
  const costs = dashboard.data.costs;

  return {
    colonyActive,
    colonyTotal,
    fleetAttention: agents.error > 0 || badges.data.failedRuns > 0,
    monthSpendCents: costs.monthSpendCents,
    monthBudgetCents: costs.monthBudgetCents,
    attentionCount: badges.data.approvals,
  };
}

/** Just the decisions count, for the rail badge and phone tab badge. */
export function useUi2AttentionCount(): number | null {
  const { selectedCompanyId } = useCompany();
  const badges = useQuery({
    queryKey: queryKeys.sidebarBadges(selectedCompanyId ?? ""),
    queryFn: () => sidebarBadgesApi.get(selectedCompanyId!),
    enabled: selectedCompanyId != null,
  });
  return badges.data ? badges.data.approvals : null;
}
