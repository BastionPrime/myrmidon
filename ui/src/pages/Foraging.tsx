// myrmidon(1.6-FORAGE): the "Foraging" page — the source registry of the company,
// the findings the comparison passes produced and where each finding stands in
// the skill lifecycle, plus the per-pass budget. Reads
// GET /api/myrmidon/companies/:id/foraging/* (foraging/routes.ts).
//
// The page works while the sweep is off: the registry stays editable and the
// findings list stays visible, with a note that passes are not running.
//
// Tokens only (DESIGN.md): Tailwind palette names, no raw values.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Leaf, Plus, RefreshCw, Trash2 } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCents } from "@/lib/utils";
import {
  diffLine,
  findingStatusLabel,
  foragingApi,
  foragingBudgetKey,
  foragingFindingsKey,
  foragingSourcesKey,
  type ForagingSourceKind,
} from "@/api/foraging";

const NO_COMPANY = "__none__";

const KIND_ORDER: ForagingSourceKind[] = ["url", "feed", "repo", "docs"];
const KIND_LABELS: Record<ForagingSourceKind, string> = {
  url: "Page",
  feed: "Feed",
  repo: "Repository",
  docs: "Docs",
};

function formatWhen(value: string | null): string {
  if (!value) return "never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export interface ForagingProps {
  /** Render inside another surface without a second page-level title or breadcrumb. */
  embedded?: boolean;
}

export function Foraging({ embedded = false }: ForagingProps = {}) {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const companyId = selectedCompanyId ?? NO_COMPANY;

  const [role, setRole] = useState("");
  const [url, setUrl] = useState("");
  const [kind, setKind] = useState<ForagingSourceKind>("url");

  useEffect(() => {
    if (!embedded) setBreadcrumbs([{ label: "Foraging" }]);
  }, [embedded, setBreadcrumbs]);

  const sourcesQuery = useQuery({
    queryKey: foragingSourcesKey(companyId),
    queryFn: () => foragingApi.sources(companyId),
    enabled: !!selectedCompanyId,
    staleTime: 30_000,
  });

  const findingsQuery = useQuery({
    queryKey: foragingFindingsKey(companyId),
    queryFn: () => foragingApi.findings(companyId),
    enabled: !!selectedCompanyId,
    staleTime: 30_000,
  });

  const budgetQuery = useQuery({
    queryKey: foragingBudgetKey(companyId),
    queryFn: () => foragingApi.budget(companyId),
    enabled: !!selectedCompanyId,
    staleTime: 30_000,
  });

  const saveSource = useMutation({
    mutationFn: () => foragingApi.saveSource(companyId, { role: role.trim(), url: url.trim(), kind }),
    onSuccess: () => {
      setRole("");
      setUrl("");
      void queryClient.invalidateQueries({ queryKey: foragingSourcesKey(companyId) });
    },
  });

  const removeSource = useMutation({
    mutationFn: (sourceId: string) => foragingApi.removeSource(companyId, sourceId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: foragingSourcesKey(companyId) });
    },
  });

  const runSweep = useMutation({
    mutationFn: () => foragingApi.sweep(companyId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: foragingFindingsKey(companyId) });
      void queryClient.invalidateQueries({ queryKey: foragingSourcesKey(companyId) });
      void queryClient.invalidateQueries({ queryKey: foragingBudgetKey(companyId) });
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Leaf} message="Select an organization to view its foraging sources." />;
  }

  const enabled = sourcesQuery.data?.enabled ?? false;
  const sources = sourcesQuery.data?.sources ?? [];
  const findings = findingsQuery.data?.findings ?? [];
  const budget = budgetQuery.data;

  return (
    <div className="space-y-6">
      <div className="space-y-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            {embedded ? (
              <h2 className="text-lg font-semibold text-foreground">Foraging</h2>
            ) : (
              <h1 className="text-3xl font-semibold tracking-tight">Foraging</h1>
            )}
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              Approved sources per role. Each pass compares a source with its previous snapshot; a
              difference becomes a finding, and a finding becomes a skill candidate through the skill
              lifecycle.
            </p>
          </div>

          <Button
            variant="secondary"
            size="sm"
            onClick={() => runSweep.mutate()}
            disabled={!enabled || runSweep.isPending}
            data-testid="foraging-run-sweep"
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Run a pass now
          </Button>
        </div>

        {!enabled ? (
          <p className="text-sm text-muted-foreground" data-testid="foraging-disabled-note">
            Periodic foraging is off on this instance, so no pass runs on its own. The registry below is
            still editable; ask the operator to switch the sweep on.
          </p>
        ) : null}

        {budget ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground" data-testid="foraging-budget">
            <span>
              Pass budget: {budget.budget.enabled ? formatCents(budget.budget.maxCostCents) : "no limit"}
            </span>
            <span>Spent this month: {formatCents(budget.spentCents)}</span>
            <span>Pass interval: {Math.round(budget.intervalMs / 60_000)} min</span>
            <span>Same-host pause: {Math.round(budget.minHostIntervalMs / 1000)} s</span>
          </div>
        ) : null}
      </div>

      <Card>
        <CardHeader className="px-5 pt-5 pb-2">
          <CardTitle className="text-base">Sources</CardTitle>
          <CardDescription>One row per approved source; a role may have several.</CardDescription>
        </CardHeader>
        <CardContent className="px-5 pb-5 pt-2 space-y-4">
          <div className="flex flex-wrap items-end gap-2" data-testid="foraging-source-form">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Role
              <input
                value={role}
                onChange={(event) => setRole(event.target.value)}
                placeholder="engineer"
                className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground"
                data-testid="foraging-source-role"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              URL
              <input
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://example.com/changelog"
                className="h-9 w-80 rounded-md border border-input bg-background px-3 text-sm text-foreground"
                data-testid="foraging-source-url"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Kind
              <select
                value={kind}
                onChange={(event) => setKind(event.target.value as ForagingSourceKind)}
                className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground"
                data-testid="foraging-source-kind"
              >
                {KIND_ORDER.map((value) => (
                  <option key={value} value={value}>
                    {KIND_LABELS[value]}
                  </option>
                ))}
              </select>
            </label>
            <Button
              size="sm"
              onClick={() => saveSource.mutate()}
              disabled={!role.trim() || !url.trim() || saveSource.isPending}
              data-testid="foraging-source-save"
            >
              <Plus className="mr-2 h-4 w-4" />
              Add source
            </Button>
          </div>

          {saveSource.error ? (
            <p className="text-sm text-destructive" data-testid="foraging-source-error">
              {(saveSource.error as Error).message}
            </p>
          ) : null}

          {sourcesQuery.isLoading ? (
            <PageSkeleton variant="costs" />
          ) : sources.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="foraging-sources-empty">
              No sources yet. Add the first one above.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs" data-testid="foraging-sources-table">
                <thead>
                  <tr className="border-b border-border bg-accent/20">
                    <th scope="col" className="px-3 py-2 text-left font-medium text-muted-foreground">Role</th>
                    <th scope="col" className="px-3 py-2 text-left font-medium text-muted-foreground">Source</th>
                    <th scope="col" className="px-3 py-2 text-left font-medium text-muted-foreground">Kind</th>
                    <th scope="col" className="px-3 py-2 text-left font-medium text-muted-foreground">Last snapshot</th>
                    <th scope="col" className="px-3 py-2 text-left font-medium text-muted-foreground">Last check</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium text-muted-foreground" />
                  </tr>
                </thead>
                <tbody>
                  {sources.map((source) => (
                    <tr key={source.id} className="border-b border-border last:border-b-0" data-testid="foraging-source-row">
                      <td className="px-3 py-2 font-mono">{source.role}</td>
                      <td className="px-3 py-2">
                        <span className="font-mono">{source.url}</span>
                        {source.lastError ? (
                          <span className="ml-2 text-destructive" data-testid="foraging-source-row-error">
                            {source.lastError}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2">{KIND_LABELS[source.kind] ?? source.kind}</td>
                      <td className="px-3 py-2 tabular-nums">
                        {source.lastSnapshotAt ? formatWhen(source.lastSnapshotAt) : "no snapshot yet"}
                      </td>
                      <td className="px-3 py-2">{formatWhen(source.lastCheckedAt)}</td>
                      <td className="px-3 py-2 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Remove ${source.url}`}
                          onClick={() => removeSource.mutate(source.id)}
                          disabled={removeSource.isPending}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="px-5 pt-5 pb-2">
          <CardTitle className="text-base">Latest findings</CardTitle>
          <CardDescription>
            A difference between a source and its previous snapshot. Unverified findings wait for the
            skill lifecycle; accepted ones carry the candidate reference.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-5 pb-5 pt-2">
          {findingsQuery.isLoading ? (
            <PageSkeleton variant="costs" />
          ) : findings.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="foraging-findings-empty">
              No findings yet. A finding appears when a source differs from its last snapshot.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs" data-testid="foraging-findings-table">
                <thead>
                  <tr className="border-b border-border bg-accent/20">
                    <th scope="col" className="px-3 py-2 text-left font-medium text-muted-foreground">Detected</th>
                    <th scope="col" className="px-3 py-2 text-left font-medium text-muted-foreground">Role</th>
                    <th scope="col" className="px-3 py-2 text-left font-medium text-muted-foreground">Skill key</th>
                    <th scope="col" className="px-3 py-2 text-left font-medium text-muted-foreground">Change</th>
                    <th scope="col" className="px-3 py-2 text-left font-medium text-muted-foreground">State</th>
                    <th scope="col" className="px-3 py-2 text-left font-medium text-muted-foreground">Candidate</th>
                  </tr>
                </thead>
                <tbody>
                  {findings.map((finding) => (
                    <tr key={finding.id} className="border-b border-border last:border-b-0" data-testid="foraging-finding-row">
                      <td className="px-3 py-2">{formatWhen(finding.detectedAt)}</td>
                      <td className="px-3 py-2 font-mono">{finding.role}</td>
                      <td className="px-3 py-2 font-mono">{finding.skillKey}</td>
                      <td className="px-3 py-2">
                        <span className="font-mono">{diffLine(finding.diff)}</span>
                        <span className="ml-2 text-muted-foreground">{finding.summary}</span>
                      </td>
                      <td className="px-3 py-2">{findingStatusLabel(finding.status)}</td>
                      <td className="px-3 py-2 font-mono">
                        {finding.candidateRef ?? (finding.reason ? finding.reason : "—")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}