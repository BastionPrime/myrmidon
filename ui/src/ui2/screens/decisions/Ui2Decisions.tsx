// ui/src/ui2/screens/decisions/Ui2Decisions.tsx
//
// myrmidon(UI2): the Decisions screen in the new shell, behind
// `enableMyrmidonUi2`. Existing APIs only (decisionsApi.list / decide /
// dismiss, agentsApi.list for names); the parity criteria from the ticket:
// the same actions as the old screen (decide with option + inputs +
// idempotency key, dismiss with reason), the same permissions (the board
// routes already gate by session; no new surface), snapshots at 1440/390,
// no English literals in RU mode (everything through the ui2 catalog).
// Mock-only blocks (fact-check rows, recommendation, "swarm decided"
// counters) are hidden until the API carries the fields.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Agent, DecisionOption } from "@paperclipai/shared";
import type { Decision } from "@/api/decisions";
import { decisionsApi } from "@/api/decisions";
import { agentsApi } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";
import { useCompany } from "@/context/CompanyContext";
import { useUi2I18n } from "../../i18n/Ui2I18n";
import {
  Ui2ErrorState,
  Ui2EmptyStateView,
  Ui2SkeletonRows,
} from "../../components/ui2StateViews";
import { Ui2Page, Ui2StatusDot } from "../../components/ui2Primitives";
import {
  ui2DecisionAge,
  ui2DecisionGroup,
  ui2GroupCounts,
  ui2OptionEffectSummary,
  ui2SortOptions,
  type Ui2DecisionGroup,
} from "./ui2DecisionsModel";

type Filter = "all" | Ui2DecisionGroup;

const FILTERS: Filter[] = ["all", "policies", "money", "external"];

export function Ui2Decisions() {
  const { t } = useUi2I18n();
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<Filter>("all");
  const [inputValues, setInputValues] = useState<Record<string, Record<string, string>>>({});
  const [dismissReasons, setDismissReasons] = useState<Record<string, string>>({});
  const [errorByDecision, setErrorByDecision] = useState<Record<string, string>>({});

  const companyId = selectedCompanyId ?? "";

  const openQuery = useQuery({
    queryKey: queryKeys.decisions.list(companyId, "open"),
    queryFn: () => decisionsApi.list(companyId, { status: "open" }),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: !!selectedCompanyId,
    staleTime: 60_000,
  });

  const agentNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of agentsQuery.data ?? []) map.set(agent.id, agent.name);
    return map;
  }, [agentsQuery.data]);

  const decisions = useMemo(() => {
    const list = openQuery.data ?? [];
    if (filter === "all") return list;
    return list.filter((decision) => ui2DecisionGroup(decision) === filter);
  }, [openQuery.data, filter]);

  const counts = useMemo(() => ui2GroupCounts(openQuery.data ?? []), [openQuery.data]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.decisions.list(companyId, "open") });
    queryClient.invalidateQueries({ queryKey: queryKeys.attention(companyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(companyId) });
  };

  const decideMutation = useMutation({
    mutationFn: (input: { decisionId: string; optionId: string; values: Record<string, string> }) =>
      decisionsApi.decide(input.decisionId, {
        optionId: input.optionId,
        inputValues: input.values,
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: invalidate,
  });

  const dismissMutation = useMutation({
    mutationFn: (input: { decisionId: string; reason: string | undefined }) =>
      decisionsApi.dismiss(input.decisionId, input.reason),
    onSuccess: invalidate,
  });

  if (openQuery.isLoading) {
    return (
      <Ui2Page title={t("ui2.decisions.title")} subtitle={t("ui2.decisions.subtitle")}>
        <Ui2SkeletonRows rows={4} />
      </Ui2Page>
    );
  }

  if (openQuery.isError) {
    return (
      <Ui2Page title={t("ui2.decisions.title")} subtitle={t("ui2.decisions.subtitle")}>
        <Ui2ErrorState
          message={t("ui2.common.error")}
          detail={openQuery.error instanceof Error ? openQuery.error.message : null}
          retryLabel={t("ui2.common.retry")}
          onRetry={() => void openQuery.refetch()}
        />
      </Ui2Page>
    );
  }

  const totalOpen = (openQuery.data ?? []).length;

  return (
    <Ui2Page title={t("ui2.decisions.title")} subtitle={t("ui2.decisions.subtitle")}>
      <div className="ui2-decisions-filters flex flex-wrap items-center gap-2" role="tablist" aria-label={t("ui2.decisions.filter.all")}>
        {FILTERS.map((candidate) => {
          const label =
            candidate === "all"
              ? t("ui2.decisions.filter.all")
              : candidate === "policies"
                ? t("ui2.decisions.filter.policies")
                : candidate === "money"
                  ? t("ui2.decisions.filter.money")
                  : t("ui2.decisions.filter.external");
          const count =
            candidate === "all"
              ? totalOpen
              : candidate === "policies"
                ? counts.policies
                : candidate === "money"
                  ? counts.money
                  : counts.external;
          return (
            <button
              key={candidate}
              type="button"
              role="tab"
              aria-selected={filter === candidate}
              className={`ui2-filter-chip rounded-md border px-3 py-1 text-xs ${
                filter === candidate ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card hover:bg-accent"
              }`}
              onClick={() => setFilter(candidate)}
            >
              {label} · {count}
            </button>
          );
        })}
      </div>

      {decisions.length === 0 ? (
        filter === "all" ? (
          <Ui2EmptyStateView
            variant="done"
            title={t("ui2.decisions.empty.title")}
            body={t("ui2.decisions.empty.body")}
          />
        ) : (
          <Ui2EmptyStateView
            variant="filtered"
            title={t("ui2.decisions.empty.filtered.title")}
            body={t("ui2.decisions.empty.filtered.body")}
          />
        )
      ) : (
        <div className="ui2-decisions-list flex flex-col gap-4">
          {decisions.map((decision) => (
            <Ui2DecisionCard
              key={decision.id}
              decision={decision}
              agentName={agentNames.get(decision.originAgentId) ?? decision.originAgentId}
              decidePending={decideMutation.isPending && decideMutation.variables?.decisionId === decision.id}
              dismissPending={dismissMutation.isPending && dismissMutation.variables?.decisionId === decision.id}
              inputValues={inputValues[decision.id] ?? {}}
              onInputValue={(inputId, value) =>
                setInputValues((prev) => ({
                  ...prev,
                  [decision.id]: { ...(prev[decision.id] ?? {}), [inputId]: value },
                }))
              }
              dismissReason={dismissReasons[decision.id] ?? ""}
              onDismissReason={(reason) => setDismissReasons((prev) => ({ ...prev, [decision.id]: reason }))}
              onDecide={(option) => {
                setErrorByDecision((prev) => ({ ...prev, [decision.id]: "" }));
                decideMutation.mutate(
                  {
                    decisionId: decision.id,
                    optionId: option.id,
                    values: inputValues[decision.id] ?? {},
                  },
                  {
                    onError: (mutationError) => {
                      setErrorByDecision((prev) => ({
                        ...prev,
                        [decision.id]: mutationError instanceof Error ? mutationError.message : String(mutationError),
                      }));
                    },
                  },
                );
              }}
              onDismiss={() => {
                setErrorByDecision((prev) => ({ ...prev, [decision.id]: "" }));
                dismissMutation.mutate(
                  { decisionId: decision.id, reason: dismissReasons[decision.id] || undefined },
                  {
                    onError: (mutationError) => {
                      setErrorByDecision((prev) => ({
                        ...prev,
                        [decision.id]: mutationError instanceof Error ? mutationError.message : String(mutationError),
                      }));
                    },
                  },
                );
              }}
              errorMessage={errorByDecision[decision.id] || null}
            />
          ))}
        </div>
      )}
    </Ui2Page>
  );
}

function Ui2DecisionCard({
  decision,
  agentName,
  decidePending,
  dismissPending,
  inputValues,
  onInputValue,
  dismissReason,
  onDismissReason,
  onDecide,
  onDismiss,
  errorMessage,
}: {
  decision: Decision;
  agentName: string;
  decidePending: boolean;
  dismissPending: boolean;
  inputValues: Record<string, string>;
  onInputValue: (inputId: string, value: string) => void;
  dismissReason: string;
  onDismissReason: (reason: string) => void;
  onDecide: (option: DecisionOption) => void;
  onDismiss: () => void;
  errorMessage: string | null;
}) {
  const { t } = useUi2I18n();
  const options = useMemo(() => ui2SortOptions(decision.options), [decision.options]);
  const busy = decidePending || dismissPending;
  const expired = decision.status === "expired";

  return (
    <article
      className="ui2-decision-card flex flex-col gap-3 rounded-lg border border-border bg-card p-4"
      aria-labelledby={`ui2-decision-${decision.id}-title`}
    >
      <header className="ui2-decision-card-header flex flex-wrap items-baseline justify-between gap-2">
        <h3 id={`ui2-decision-${decision.id}-title`} className="ui2-decision-card-title text-base font-medium">
          {decision.title}
        </h3>
        <span className="ui2-decision-card-meta flex items-center gap-2 text-xs text-muted-foreground">
          {expired ? (
            <span className="ui2-decision-expired inline-flex items-center gap-1">
              <Ui2StatusDot tone="danger" />
              {t("ui2.decisions.card.expired")}
            </span>
          ) : (
            t("ui2.decisions.card.expires", { when: new Date(decision.expiresAt).toLocaleString() })
          )}
        </span>
      </header>

      <div className="ui2-decision-card-meta flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="ui2-decision-prepared-by">{t("ui2.decisions.card.preparedBy", { agent: agentName })}</span>
        <span className="ui2-decision-age">{t("ui2.decisions.card.age", { age: ui2DecisionAge(decision.createdAt) })}</span>
        {decision.ruleKey ? <span className="ui2-decision-rulekey font-mono">{decision.ruleKey}</span> : null}
      </div>

      <div className="ui2-decision-summary">
        <h4 className="ui2-decision-summary-title mb-1 text-xs font-medium text-muted-foreground">{t("ui2.decisions.card.summary")}</h4>
        <p className="ui2-decision-summary-body text-sm">{decision.body}</p>
      </div>

      {/* Fact-check rows and the recommendation are mock-only today; hidden
          until the decision DTO carries the fields (screen map §2.2). */}
      {decision.metadata?.["factCheckRows"] ? (
        <div className="ui2-decision-facts hidden" aria-hidden="true" />
      ) : null}

      <div className="ui2-decision-options flex flex-col gap-2">
        <h4 className="ui2-decision-options-title text-xs font-medium text-muted-foreground">{t("ui2.decisions.card.options")}</h4>
        {options.map((option) => {
          const needsInputs = (decision.inputs ?? []).some((input) => input.required);
          const missingRequired = (decision.inputs ?? []).some(
            (input) => input.required && !(inputValues[input.id] ?? "").trim(),
          );
          return (
            <div key={option.id} className="ui2-decision-option rounded-md border border-border p-3">
              <div className="ui2-decision-option-head flex flex-wrap items-center justify-between gap-2">
                <span className="ui2-decision-option-label text-sm font-medium">{option.label}</span>
                <span className="ui2-decision-option-effect text-xs text-muted-foreground">
                  {t("ui2.decisions.card.optionExecutes", { effects: ui2OptionEffectSummary(option) })}
                </span>
              </div>
              {option.description ? (
                <p className="ui2-decision-option-description mt-1 text-xs text-muted-foreground">{option.description}</p>
              ) : null}
              {(decision.inputs ?? []).length > 0 ? (
                <div className="ui2-decision-option-inputs mt-2 flex flex-col gap-2">
                  {(decision.inputs ?? []).map((input) => (
                    <label key={input.id} className="ui2-decision-input flex flex-col gap-1">
                      <span className="text-xs text-muted-foreground">
                        {input.label}
                        {input.required ? " *" : ""}
                      </span>
                      <input
                        className="ui2-decision-input-field rounded-md border border-input bg-background px-2 py-1 text-sm"
                        value={inputValues[input.id] ?? ""}
                        placeholder={input.placeholder ?? ""}
                        maxLength={input.maxLength ?? undefined}
                        onChange={(event) => onInputValue(input.id, event.target.value)}
                      />
                    </label>
                  ))}
                </div>
              ) : null}
              <div className="ui2-decision-option-actions mt-2 flex items-center gap-2">
                <button
                  type="button"
                  className="ui2-decision-decide rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
                  disabled={busy || (needsInputs && missingRequired)}
                  onClick={() => onDecide(option)}
                >
                  {t("ui2.decisions.card.decide")}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="ui2-decision-dismiss flex flex-wrap items-center gap-2">
        <input
          className="ui2-decision-dismiss-reason flex-1 rounded-md border border-input bg-background px-2 py-1 text-xs"
          value={dismissReason}
          placeholder={t("ui2.decisions.card.dismiss")}
          onChange={(event) => onDismissReason(event.target.value)}
          aria-label={t("ui2.decisions.card.dismiss")}
        />
        <button
          type="button"
          className="ui2-decision-dismiss-button rounded-md border border-border px-3 py-1 text-xs hover:bg-accent disabled:opacity-50"
          disabled={busy}
          onClick={onDismiss}
        >
          {t("ui2.decisions.card.dismiss")}
        </button>
      </div>

      {errorMessage ? (
        <Ui2ErrorState message={errorMessage} withCache />
      ) : null}

      {busy ? <Ui2SkeletonRows rows={1} dense /> : null}
    </article>
  );
}
