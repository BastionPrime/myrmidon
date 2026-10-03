// myrmidon(1.6.1 WIP-LIMIT B): wire tier of the "WIP limit" screen. Owns the
// react-query state — the settings GET, the status GET and the settings PUT —
// plus the error surfaces and the agent list for the per-agent table. The
// layout lives in WipLimitScreen.tsx.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "@/i18n";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { agentsApi } from "@/api/agents";
import { ApiError } from "@/api/client";
import { WipLimitScreenView, type WipLimitAgentRow } from "./WipLimitScreen";
import { wipLimitApi, wipLimitSettingsQueryKey, wipLimitStatusQueryKey } from "./wipLimitApi";

function readable(error: unknown): string {
  if (error instanceof ApiError) return error.message || `Request failed: ${error.status}`;
  if (error instanceof Error) return error.message;
  return "Unexpected error";
}

export function WipLimitScreen() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const companyId = selectedCompanyId ?? "";
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: t("wipLimit.breadcrumb") }]);
  }, [setBreadcrumbs, t]);

  const settingsQuery = useQuery({
    queryKey: wipLimitSettingsQueryKey(companyId),
    queryFn: () => wipLimitApi.getSettings(companyId),
    enabled: companyId.length > 0,
    retry: false,
  });

  const statusQuery = useQuery({
    queryKey: wipLimitStatusQueryKey(companyId),
    queryFn: () => wipLimitApi.getStatus(companyId),
    enabled: companyId.length > 0,
    retry: false,
  });

  const agentsQuery = useQuery({
    queryKey: ["agents", companyId],
    queryFn: () => agentsApi.list(companyId),
    enabled: companyId.length > 0,
    select: (agents): WipLimitAgentRow[] =>
      agents
        .map((agent) => ({ agentId: agent.id, name: agent.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
  });

  const save = useMutation({
    mutationFn: (settings: Parameters<typeof wipLimitApi.putSettings>[1]) =>
      wipLimitApi.putSettings(companyId, settings),
    onMutate: () => setError(null),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: wipLimitSettingsQueryKey(companyId) });
      await queryClient.invalidateQueries({ queryKey: wipLimitStatusQueryKey(companyId) });
    },
    onError: (err) => setError(readable(err)),
  });

  if (companyId.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="myrmidon-wip-limit-no-company">
        {t("wipLimit.noCompany")}
      </p>
    );
  }

  if (settingsQuery.isError) {
    return (
      <p className="text-sm text-destructive" data-testid="myrmidon-wip-limit-error">
        {readable(settingsQuery.error)}
      </p>
    );
  }

  return (
    <WipLimitScreenView
      settings={settingsQuery.data}
      status={statusQuery.data}
      agents={agentsQuery.data ?? []}
      onSave={(next) => save.mutate(next)}
      pending={save.isPending}
      error={error}
    />
  );
}
