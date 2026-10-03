// myrmidon(1.6.1 WIP-LIMIT B): the "WIP limit" settings screen — the view
// tier. Layout and local interaction state only; the react-query wiring
// lives in WipLimitScreenContainer.tsx so tests can drive both tiers
// separately (the same split the Autonomy screen uses).
//
// The screen edits part A's frozen contract: `defaultLimit` (company-wide,
// null = off) and per-agent overrides. An override equal to nothing is
// removed, so the row stays minimal. The status list (live wip per agent)
// comes from the status endpoint and is read-only here.
import { useState } from "react";
import { Gauge } from "lucide-react";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  limitToText,
  parseWipLimitValue,
  type WipLimitParse,
} from "./wipLimitConfig";
import type { WipLimitSettings, WipLimitStatusEntry } from "./wipLimitApi";

/** A row description for the per-agent table. */
export interface WipLimitAgentRow {
  agentId: string;
  name: string;
}

export function WipLimitScreenView({
  settings,
  status,
  agents,
  onSave,
  pending,
  error,
}: {
  settings: WipLimitSettings | null | undefined;
  status: WipLimitStatusEntry[] | null | undefined;
  agents: WipLimitAgentRow[];
  onSave: (settings: WipLimitSettings) => void;
  pending: boolean;
  error: string | null;
}) {
  const { t } = useTranslation();
  const [defaultDraft, setDefaultDraft] = useState<string | null>(null);
  const [perAgentDraft, setPerAgentDraft] = useState<Record<string, string> | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const defaultText = defaultDraft ?? limitToText(settings?.defaultLimit);
  const defaultParsed = parseWipLimitValue(defaultText);
  const currentPerAgent = perAgentDraft ?? {};
  const statusByAgent = new Map((status ?? []).map((entry) => [entry.agentId, entry]));

  const perAgentParsed: Record<string, WipLimitParse> = {};
  let perAgentValid = true;
  for (const agent of agents) {
    const raw = Object.prototype.hasOwnProperty.call(currentPerAgent, agent.agentId)
      ? currentPerAgent[agent.agentId]
      : limitToText(settings?.perAgent?.[agent.agentId] ?? null);
    const parsed = parseWipLimitValue(raw);
    perAgentParsed[agent.agentId] = parsed;
    if (!parsed.ok) perAgentValid = false;
  }

  const dirty =
    defaultDraft !== null ||
    perAgentDraft !== null ||
    (settings !== undefined && agents.some((a) => Object.prototype.hasOwnProperty.call(settings?.perAgent ?? {}, a.agentId)));

  const save = () => {
    if (!settings || !defaultParsed.ok || !perAgentValid) return;
    const perAgent: Record<string, number | null> = { ...settings.perAgent };
    for (const agent of agents) {
      const parsed = perAgentParsed[agent.agentId];
      if (!parsed || !parsed.ok) continue;
      if (parsed.value === null) {
        delete perAgent[agent.agentId];
      } else {
        perAgent[agent.agentId] = parsed.value;
      }
    }
    const next: WipLimitSettings = { defaultLimit: defaultParsed.value, perAgent };
    setSaveError(null);
    onSave(next);
  };

  const shownError = saveError ?? error;

  return (
    <section className="space-y-4" data-testid="myrmidon-wip-limit">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Gauge className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{t("wipLimit.title")}</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">{t("wipLimit.intro")}</p>
      </div>

      {shownError ? (
        <div
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          data-testid="myrmidon-wip-limit-error"
          role="alert"
        >
          {shownError}
        </div>
      ) : null}

      {settings ? (
        <>
          <div className="space-y-1">
            <Label htmlFor="wip-limit-default">{t("wipLimit.defaultLabel")}</Label>
            <Input
              id="wip-limit-default"
              inputMode="numeric"
              placeholder={t("wipLimit.noLimit")}
              className="max-w-xs"
              aria-invalid={defaultParsed.ok ? undefined : true}
              value={defaultText}
              onChange={(event) =>
                setDefaultDraft(event.target.value)
              }
            />
            <p className="text-xs text-muted-foreground">{t("wipLimit.defaultHint")}</p>
            {!defaultParsed.ok ? (
              <p className="text-xs text-destructive" data-testid="wip-limit-default-error">
                {defaultParsed.message}
              </p>
            ) : null}
          </div>

          {agents.length > 0 ? (
            <div className="space-y-2">
              <h3 className="text-sm font-medium">{t("wipLimit.agentsTitle")}</h3>
              <table className="w-full text-sm" data-testid="wip-limit-agent-table">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground">
                    <th className="py-1 pr-4 font-medium">{t("wipLimit.colAgent")}</th>
                    <th className="py-1 pr-4 font-medium">{t("wipLimit.colWip")}</th>
                    <th className="py-1 pr-4 font-medium">{t("wipLimit.colLimit")}</th>
                  </tr>
                </thead>
                <tbody>
                  {agents.map((agent) => {
                    const parsed = perAgentParsed[agent.agentId];
                    const entry = statusByAgent.get(agent.agentId);
                    const rowText = Object.prototype.hasOwnProperty.call(currentPerAgent, agent.agentId)
                      ? currentPerAgent[agent.agentId]
                      : limitToText(settings?.perAgent?.[agent.agentId] ?? null);
                    return (
                      <tr key={agent.agentId} className="border-t border-border">
                        <td className="py-1.5 pr-4">{agent.name}</td>
                        <td className="py-1.5 pr-4">
                          <span
                            data-testid={`wip-limit-status-${agent.agentId}`}
                            className={entry?.overLimit ? "font-medium text-destructive" : "text-muted-foreground"}
                          >
                            {entry
                              ? entry.limit === null
                                ? `${entry.wip}`
                                : `${entry.inProgress}+${entry.inReview} = ${entry.wip}/${entry.limit}`
                              : "—"}
                          </span>
                          {entry?.overLimit ? (
                            <span className="ml-2 text-xs font-medium text-destructive" data-testid={`wip-limit-over-${agent.agentId}`}>
                              {t("wipLimit.overLimit")}
                            </span>
                          ) : null}
                        </td>
                        <td className="py-1.5 pr-4">
                          <Input
                            inputMode="numeric"
                            placeholder={t("wipLimit.usesDefault")}
                            className="w-28"
                            aria-label={`${t("wipLimit.colLimit")} — ${agent.name}`}
                            aria-invalid={parsed && !parsed.ok ? true : undefined}
                            value={rowText}
                            onChange={(event) =>
                              setPerAgentDraft({ ...currentPerAgent, [agent.agentId]: event.target.value })
                            }
                          />
                          {parsed && !parsed.ok ? (
                            <p className="text-xs text-destructive" role="alert">
                              {parsed.message}
                            </p>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground" data-testid="wip-limit-no-agents">
              {t("wipLimit.noAgents")}
            </p>
          )}

          <div>
            <Button type="button" size="sm" disabled={pending || !defaultParsed.ok || !perAgentValid} onClick={save}>
              {pending ? t("wipLimit.saving") : t("wipLimit.save")}
            </Button>
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="myrmidon-wip-limit-loading">
          {t("wipLimit.loading")}
        </p>
      )}
    </section>
  );
}
