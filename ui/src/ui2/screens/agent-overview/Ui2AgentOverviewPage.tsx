// ui/src/ui2/screens/agent-overview/Ui2AgentOverviewPage.tsx — UI-2.0
//
// myrmidon(UI2): the routed page for the agent card's ui2 Overview tab.
// The shell's route table owns `agents/:agentId/overview`; this page loads
// the agent and its recent runs through the EXISTING agent-card APIs
// (agentsApi.get, heartbeatsApi.list) and renders the Ui2AgentOverview
// surface. The vendor AgentCard page is NOT edited — the tab is a separate
// ui2 route the card can link to under the flag.

import { useQuery } from "@tanstack/react-query";
import type { HeartbeatRun } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { heartbeatsApi } from "@/api/heartbeats";
import { queryKeys } from "@/lib/queryKeys";
import { useCompany } from "@/context/CompanyContext";
import { useParams } from "@/lib/router";
import { Ui2AgentOverview } from "./Ui2AgentOverview";
import { useUi2I18n } from "../../i18n/Ui2I18n";
import {
  Ui2DeniedState,
  Ui2ErrorState,
  Ui2SkeletonRows,
} from "../../components/ui2StateViews";
import { Ui2Page } from "../../components/ui2Primitives";

export function Ui2AgentOverviewPage() {
  const { t } = useUi2I18n();
  const { agentId } = useParams<{ agentId: string }>();
  const { selectedCompanyId } = useCompany();
  const companyId = selectedCompanyId ?? "";

  const agentQuery = useQuery({
    queryKey: queryKeys.agents.detail(agentId ?? ""),
    queryFn: () => agentsApi.get(agentId ?? "", companyId || undefined),
    enabled: !!agentId && !!companyId,
  });

  const runsQuery = useQuery({
    queryKey: queryKeys.heartbeats(companyId, agentId ?? ""),
    queryFn: () => heartbeatsApi.list(companyId, agentId),
    enabled: !!agentId && !!companyId,
  });

  if (agentQuery.isLoading) {
    return (
      <Ui2Page title={t("ui2.agent.overview.title")}>
        <Ui2SkeletonRows rows={4} />
      </Ui2Page>
    );
  }

  if (agentQuery.isError) {
    const status = (agentQuery.error as { status?: number } | null)?.status;
    if (status === 403) {
      return (
        <Ui2Page title={t("ui2.agent.overview.title")}>
          <Ui2DeniedState message={t("ui2.settings.system.denied")} hint={t("ui2.settings.system.deniedHint")} />
        </Ui2Page>
      );
    }
    return (
      <Ui2Page title={t("ui2.agent.overview.title")}>
        <Ui2ErrorState
          message={t("ui2.common.error")}
          detail={agentQuery.error instanceof Error ? agentQuery.error.message : null}
          retryLabel={t("ui2.common.retry")}
          onRetry={() => void agentQuery.refetch()}
        />
      </Ui2Page>
    );
  }

  const agent = agentQuery.data;
  if (!agent) {
    return (
      <Ui2Page title={t("ui2.agent.overview.title")}>
        <Ui2DeniedState message={t("ui2.agent.overview.missing")} />
      </Ui2Page>
    );
  }

  return (
    <Ui2Page title={t("ui2.agent.overview.title")}>
      <Ui2AgentOverview
        agent={agent}
        agentId={agentId ?? agent.id}
        companyId={companyId}
        runs={(runsQuery.data ?? []) as HeartbeatRun[]}
      />
    </Ui2Page>
  );
}
