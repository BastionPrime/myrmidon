// WIP-LIMIT 1.6.1 part B (UI): the "WIP Limit" settings screen under
// Company settings. The owner/lead reads and edits the default limit plus
// per-agent overrides through the fixed part-A contract
// (GET/PUT /api/myrmidon/companies/:companyId/wip-limit/settings, see
// ui/src/api/wipLimit.ts). Current load comes from the same endpoint family
// (GET .../wip-limit/status) so the table shows live wip per agent, not just
// the stored settings.
//
// Tokens only (DESIGN.md): Tailwind palette names and the shared primitives,
// no raw values.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Gauge, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { agentsApi } from "@/api/agents";
import type { Agent } from "@paperclipai/shared";
import {
  wipLimitApi,
  wipLimitSettingsQueryKey,
  wipLimitStatusQueryKey,
  type WipLimitSettings,
  type WipLimitStatusRow,
} from "@/api/wipLimit";

const ACTIVE_AGENT_STATUSES = new Set(["active", "paused", "error"]);

/** Status rows only cover agents with a limit or load; the settings table
 *  lists every active agent so an override can be added for any of them. */
function activeAgents(agents: Agent[] | undefined): Agent[] {
  return (agents ?? []).filter((agent) => ACTIVE_AGENT_STATUSES.has(agent.status));
}

/** An empty field means "no limit" for that agent; anything else must be a
 *  positive integer. `null` keeps the default as the effective limit. */
export type WipLimitDraft = {
  defaultLimit: string;
  perAgent: Record<string, string>;
};

export type WipLimitDraftParse = {
  settings: WipLimitSettings | null;
  errors: { defaultLimit: string | null; perAgent: Partial<Record<string, string>> };
};

export function parseWipLimitDraft(draft: WipLimitDraft): WipLimitDraftParse {
  const errors: WipLimitDraftParse["errors"] = { defaultLimit: null, perAgent: {} };
  const raw = draft.defaultLimit.trim();
  let defaultLimit: number | null = null;
  if (raw) {
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
      errors.defaultLimit = "Enter a whole number greater than zero, or leave it empty";
    } else {
      defaultLimit = value;
    }
  }
  const perAgent: Record<string, number | null> = {};
  for (const [agentId, field] of Object.entries(draft.perAgent)) {
    const trimmed = field.trim();
    // An empty or "default" field removes the override: the agent falls back
    // to the default. The literal "off" is the serialized form of an explicit
    // per-agent null — the limit is off for that agent only.
    if (trimmed === "" || trimmed === "default") {
      continue;
    }
    if (trimmed === "off") {
      perAgent[agentId] = null;
      continue;
    }
    const value = Number(trimmed);
    if (!Number.isInteger(value) || value <= 0) {
      errors.perAgent[agentId] = "Enter a whole number greater than zero, or leave it empty";
      continue;
    }
    perAgent[agentId] = value;
  }
  if (errors.defaultLimit || Object.keys(errors.perAgent).length > 0) {
    return { settings: null, errors };
  }
  return { settings: { defaultLimit, perAgent }, errors };
}

export function toWipLimitDraft(settings: WipLimitSettings | null | undefined): WipLimitDraft {
  return {
    defaultLimit: settings?.defaultLimit == null ? "" : String(settings.defaultLimit),
    perAgent: Object.fromEntries(
      Object.entries(settings?.perAgent ?? {}).map(([agentId, value]) => [
        agentId,
        value == null ? "off" : String(value),
      ]),
    ),
  };
}

export function WipLimitSettingsView({
  agents,
  settings,
  statusRows,
  draft,
  onDraftChange,
  onSave,
  pending,
  error,
}: {
  agents: Agent[];
  settings: WipLimitSettings | null | undefined;
  statusRows: WipLimitStatusRow[] | null | undefined;
  draft: WipLimitDraft | null;
  onDraftChange: (next: WipLimitDraft) => void;
  onSave: (next: WipLimitSettings) => void;
  pending: boolean;
  error: string | null;
}) {
  const current = draft ?? toWipLimitDraft(settings);
  const { settings: parsed, errors } = parseWipLimitDraft(current);
  const statusByAgentId = useMemo(
    () => new Map((statusRows ?? []).map((row) => [row.agentId, row])),
    [statusRows],
  );
  const settingsPerAgent = settings?.perAgent ?? {};

  function setDefaultLimit(value: string) {
    onDraftChange({ ...current, defaultLimit: value });
  }

  function setAgentLimit(agentId: string, value: string) {
    onDraftChange({
      ...current,
      perAgent: { ...current.perAgent, [agentId]: value },
    });
  }

  return (
    <div className="max-w-6xl space-y-8">
      <div className="flex items-center gap-2">
        <Gauge className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">WIP Limit</h1>
      </div>
      <p className="max-w-2xl text-sm text-muted-foreground">
        How many tasks an agent keeps in progress at once. The default applies to
        every agent without its own value. Leave the field empty to switch the
        limit off.
      </p>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive" data-testid="wip-limit-error">
          {error}
        </div>
      ) : null}

      <div className="max-w-2xl space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Default
        </div>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="wip-limit-default">Default WIP limit</Label>
            <Input
              id="wip-limit-default"
              data-testid="wip-limit-default"
              inputMode="numeric"
              placeholder="No limit"
              value={current.defaultLimit}
              onChange={(event) => setDefaultLimit(event.target.value)}
            />
            {errors.defaultLimit ? (
              <div className="text-xs text-destructive" data-testid="wip-limit-default-error">
                {errors.defaultLimit}
              </div>
            ) : null}
            <p className="text-xs text-muted-foreground">
              Tasks in progress and in review count toward the limit. Over the
              limit, a new task stays queued until a slot frees.
            </p>
          </div>
        </div>
      </div>

      <div className="max-w-4xl space-y-4" data-testid="wip-limit-agents">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Per-agent limits
        </div>
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left">
                <th className="px-3 py-2 text-xs font-medium text-muted-foreground">Agent</th>
                <th className="px-3 py-2 text-xs font-medium text-muted-foreground">Current WIP</th>
                <th className="px-3 py-2 text-xs font-medium text-muted-foreground">Limit</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((agent) => {
                const row = statusByAgentId.get(agent.id);
                const hasOverride = agent.id in settingsPerAgent;
                const field =
                  current.perAgent[agent.id] ?? (hasOverride ? current.perAgent[agent.id] : "");
                const fieldError = errors.perAgent[agent.id];
                const limit = row?.limit ?? null;
                const over = row?.overLimit ?? false;
                return (
                  <tr key={agent.id} className="border-b border-border last:border-b-0">
                    <td className="px-3 py-2">
                      <span className="font-medium">{agent.name}</span>
                      <span className="ml-2 text-xs text-muted-foreground">{agent.title ?? agent.role}</span>
                    </td>
                    <td className="px-3 py-2">
                      {row ? (
                        <span className="flex items-center gap-2">
                          <span className="tabular-nums">
                            {row.wip}/{limit == null ? "—" : limit}
                          </span>
                          {over ? (
                            <span
                              className="inline-flex items-center gap-1 rounded-full border border-amber-600 px-2 py-0.5 text-xs text-amber-600 dark:text-amber-400"
                              data-testid={`wip-limit-over-${agent.id}`}
                            >
                              <AlertTriangle className="h-3 w-3" />
                              Over limit
                            </span>
                          ) : null}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div className="space-y-1">
                        <Input
                          id={`wip-limit-agent-${agent.id}`}
                          data-testid={`wip-limit-agent-${agent.id}`}
                          inputMode="numeric"
                          placeholder="Default"
                          value={field}
                          onChange={(event) => setAgentLimit(agent.id, event.target.value)}
                          className="w-28"
                        />
                        {fieldError ? (
                          <div className="text-xs text-destructive" data-testid={`wip-limit-agent-error-${agent.id}`}>
                            {fieldError}
                          </div>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {agents.length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-3 py-2 text-sm text-muted-foreground">
                    No agents yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground">
          Enter a number to override the default for one agent. Clear the field to
          remove the override; enter &quot;off&quot; to disable the limit for that agent.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          data-testid="wip-limit-save"
          disabled={pending || parsed === null}
          onClick={() => {
            if (parsed) onSave(parsed);
          }}
        >
          {pending ? "Saving..." : "Save WIP limits"}
        </Button>
        {pending ? (
          <span className="text-xs text-muted-foreground">Saving…</span>
        ) : null}
      </div>
    </div>
  );
}

export function WipLimitSettings() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<WipLimitDraft | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Settings", href: "/company/settings" }, { label: "WIP Limit" }]);
  }, [setBreadcrumbs]);

  const agentsQuery = useQuery({
    queryKey: ["agents", "wip-limit", selectedCompanyId ?? "__none__"] as const,
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const settingsQuery = useQuery({
    queryKey: selectedCompanyId
      ? wipLimitSettingsQueryKey(selectedCompanyId)
      : (["myrmidon", "wip-limit", "settings", "__disabled__"] as const),
    queryFn: () => wipLimitApi.settings(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    retry: false,
  });

  const statusQuery = useQuery({
    queryKey: selectedCompanyId
      ? wipLimitStatusQueryKey(selectedCompanyId)
      : (["myrmidon", "wip-limit", "status", "__disabled__"] as const),
    queryFn: () => wipLimitApi.status(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    retry: false,
    refetchInterval: 30_000,
  });

  // A fresh settings load resets an untouched draft; an explicit edit wins.
  useEffect(() => {
    if (settingsQuery.dataUpdatedAt > 0) setDraft(null);
  }, [settingsQuery.dataUpdatedAt]);

  const save = useMutation({
    mutationFn: (next: WipLimitSettings) =>
      wipLimitApi.saveSettings(selectedCompanyId!, next),
    onMutate: () => setError(null),
    onError: (err) =>
      setError(err instanceof Error ? err.message : "Saving the WIP limits failed."),
    onSuccess: async () => {
      setError(null);
      setDraft(null);
      await queryClient.invalidateQueries({
        queryKey: ["myrmidon", "wip-limit"],
      });
    },
  });

  const agents = useMemo(() => activeAgents(agentsQuery.data), [agentsQuery.data]);

  return (
    <WipLimitSettingsView
      agents={agents}
      settings={settingsQuery.data}
      statusRows={statusQuery.data}
      draft={draft}
      onDraftChange={setDraft}
      onSave={(next) => save.mutate(next)}
      pending={save.isPending}
      error={error ?? (settingsQuery.error instanceof Error ? settingsQuery.error.message : null)}
    />
  );
}
