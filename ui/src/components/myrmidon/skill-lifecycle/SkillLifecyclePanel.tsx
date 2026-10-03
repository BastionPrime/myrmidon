// myrmidon(1.6-SKILL-LIFE): the company skill lifecycle panel.
//
// Lists every company skill with its state, the verified revision, who approved
// it and when; a selected skill shows its history. Board members can register a
// candidate, ask for a promotion (which opens an approval card in the existing
// approvals pipeline), deprecate and roll back to the previous verified
// revision. Tokens only (DESIGN.md): Tailwind palette names, no raw values.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useCompany } from "@/context/CompanyContext";
import {
  approverLabel,
  historyLine,
  revisionLabel,
  skillLifecycleApi,
  skillLifecycleHistoryQueryKey,
  skillLifecycleQueryKey,
  stateBadge,
  type SkillLifecycleEvent,
  type SkillLifecycleView,
} from "./lifecycleApi";

export interface SkillLifecyclePanelViewProps {
  skills: SkillLifecycleView[];
  loading: boolean;
  error: string | null;
  selectedSkillId: string | null;
  history: SkillLifecycleEvent[];
  historyLoading: boolean;
  busy: boolean;
  onSelect: (skillId: string) => void;
  onRequestPromotion: (skill: SkillLifecycleView) => void;
  onDeprecate: (skill: SkillLifecycleView) => void;
  onRollback: (skill: SkillLifecycleView) => void;
  onSetCandidate: (skill: SkillLifecycleView) => void;
}

/** Pure view: no data fetching, so the states are testable in isolation. */
export function SkillLifecyclePanelView(props: SkillLifecyclePanelViewProps) {
  const selected = props.skills.find((skill) => skill.skillId === props.selectedSkillId) ?? null;
  return (
    <div className="space-y-4" data-testid="myrmidon-skill-lifecycle">
      <div className="rounded-lg border border-border bg-background">
        <div className="px-5 pt-5 pb-2">
          <span className="text-base font-medium">Skill lifecycle</span>
          <p className="text-xs text-muted-foreground">
            Candidates reach only the pilot agents; verified skills reach everyone; deprecated reach nobody.
          </p>
        </div>
        <div className="px-5 pb-5">
          {props.loading ? (
            <p className="text-sm text-muted-foreground" data-testid="myrmidon-skill-lifecycle-loading">
              Loading skills...
            </p>
          ) : props.error ? (
            <p className="text-sm text-destructive" data-testid="myrmidon-skill-lifecycle-error">
              {props.error}
            </p>
          ) : props.skills.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="myrmidon-skill-lifecycle-empty">
              This company has no skills yet.
            </p>
          ) : (
            <ul className="divide-y divide-border" data-testid="myrmidon-skill-lifecycle-list">
              {props.skills.map((skill) => {
                const badge = stateBadge(skill.state, skill.implicit);
                return (
                  <li key={skill.skillId} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <button
                      type="button"
                      className="flex min-w-0 flex-col items-start text-left"
                      onClick={() => props.onSelect(skill.skillId)}
                      data-testid={`myrmidon-skill-row-${skill.key}`}
                    >
                      <span className="truncate text-sm font-medium">{skill.name}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {skill.key} · {revisionLabel(skill.verifiedRevisionNumber)} · {approverLabel(skill)}
                      </span>
                    </button>
                    <div className="flex items-center gap-2">
                      <span
                        className={`rounded-full border px-2 py-0.5 text-xs font-medium ${badge.className}`}
                        data-testid={`myrmidon-skill-state-${skill.key}`}
                      >
                        {badge.label}
                      </span>
                      {skill.state !== "verified" || skill.implicit ? (
                        <Button size="sm" variant="outline" disabled={props.busy} onClick={() => props.onSetCandidate(skill)}>
                          Mark candidate
                        </Button>
                      ) : null}
                      <Button size="sm" disabled={props.busy} onClick={() => props.onRequestPromotion(skill)}>
                        Request promotion
                      </Button>
                      {skill.previousVerifiedVersionId && skill.state === "verified" ? (
                        <Button size="sm" variant="outline" disabled={props.busy} onClick={() => props.onRollback(skill)}>
                          Roll back
                        </Button>
                      ) : null}
                      <Button size="sm" variant="outline" disabled={props.busy} onClick={() => props.onDeprecate(skill)}>
                        Deprecate
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {selected ? (
        <div className="rounded-lg border border-border bg-background" data-testid="myrmidon-skill-lifecycle-history">
          <div className="px-5 pt-5 pb-2 text-sm font-medium">History · {selected.key}</div>
          <div className="px-5 pb-5">
            {props.historyLoading ? (
              <p className="text-sm text-muted-foreground">Loading history...</p>
            ) : props.history.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="myrmidon-skill-lifecycle-history-empty">
                No lifecycle events yet.
              </p>
            ) : (
              <ul className="space-y-1">
                {props.history.map((event) => (
                  <li key={event.id} className="text-xs text-muted-foreground">
                    {historyLine(event)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function SkillLifecyclePanel() {
  const { selectedCompanyId } = useCompany();
  const companyId = selectedCompanyId ?? "";
  const queryClient = useQueryClient();
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const listQuery = useQuery({
    queryKey: skillLifecycleQueryKey(companyId),
    queryFn: () => skillLifecycleApi.list(companyId),
    enabled: companyId.length > 0,
    retry: false,
  });

  const historyQuery = useQuery({
    queryKey: skillLifecycleHistoryQueryKey(companyId, selectedSkillId ?? ""),
    queryFn: () => skillLifecycleApi.history(companyId, selectedSkillId as string),
    enabled: companyId.length > 0 && !!selectedSkillId,
    retry: false,
  });

  const onError = (err: unknown) => setError(err instanceof Error ? err.message : "The lifecycle request failed.");
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: skillLifecycleQueryKey(companyId) });
    if (selectedSkillId) {
      void queryClient.invalidateQueries({ queryKey: skillLifecycleHistoryQueryKey(companyId, selectedSkillId) });
    }
  };

  const candidateMutation = useMutation({
    mutationFn: (skill: SkillLifecycleView) => skillLifecycleApi.setCandidate(companyId, skill.skillId),
    onMutate: () => setError(null),
    onSuccess: refresh,
    onError,
  });
  const promotionMutation = useMutation({
    mutationFn: (skill: SkillLifecycleView) =>
      skillLifecycleApi.requestPromotion(companyId, skill.skillId, "requested from the skill lifecycle panel"),
    onMutate: () => setError(null),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError,
  });
  const deprecateMutation = useMutation({
    mutationFn: (skill: SkillLifecycleView) => skillLifecycleApi.deprecate(companyId, skill.skillId, null),
    onMutate: () => setError(null),
    onSuccess: refresh,
    onError,
  });
  const rollbackMutation = useMutation({
    mutationFn: (skill: SkillLifecycleView) => skillLifecycleApi.rollback(companyId, skill.skillId),
    onMutate: () => setError(null),
    onSuccess: refresh,
    onError,
  });

  const busy =
    candidateMutation.isPending ||
    promotionMutation.isPending ||
    deprecateMutation.isPending ||
    rollbackMutation.isPending;

  return (
    <SkillLifecyclePanelView
      skills={listQuery.data?.skills ?? []}
      loading={listQuery.isLoading}
      error={error ?? (listQuery.error instanceof Error ? listQuery.error.message : null)}
      selectedSkillId={selectedSkillId}
      history={historyQuery.data?.events ?? []}
      historyLoading={historyQuery.isLoading}
      busy={busy}
      onSelect={setSelectedSkillId}
      onRequestPromotion={(skill) => promotionMutation.mutate(skill)}
      onDeprecate={(skill) => deprecateMutation.mutate(skill)}
      onRollback={(skill) => rollbackMutation.mutate(skill)}
      onSetCandidate={(skill) => candidateMutation.mutate(skill)}
    />
  );
}