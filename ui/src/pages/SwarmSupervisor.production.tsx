// myrmidon(1.6-SWARM-CLAIM-B): the production entry of the "Swarm supervisor"
// page — the same component as the dev tree's SwarmSupervisor.tsx; kept as a
// separate file so the prebuilt-assets pipeline picks it up exactly like
// Quality.production. Server side (part A): GET/POST under
// /api/myrmidon/companies/:id/swarm-claim/supervisor.
//
// Tokens only (DESIGN.md): Tailwind palette names, no raw values.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Clock,
  ListChecks,
  RotateCw,
  ShieldCheck,
  TriangleAlert,
  Users,
} from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { PriorityIcon } from "@/components/PriorityIcon";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
// myrmidon(UI-RU): page strings through the fork i18n catalog.
import { useTranslation } from "@/i18n";
import { useCompany } from "@/context/CompanyContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCents, formatDateTime, formatNumber } from "@/lib/utils";
import type {
  BaselineMetricRow,
  BaselineMetricsReport,
  BaselineSource,
} from "@/api/baseline";
import {
  isSwarmPilotNotEnabled,
  swarmSupervisorApi,
  swarmSupervisorOverviewKey,
  swarmSupervisorPilotReportKey,
  type SwarmPilotComparison,
  type SwarmSupervisorClaim,
  type SwarmSupervisorIdleAgent,
  type SwarmSupervisorOverview,
  type SwarmSupervisorQueueItem,
  type SwarmSupervisorRole,
} from "@/api/swarmSupervisor";

const NO_COMPANY = "__none__";

/** Roles tab vs the pilot-vs-baseline section. */
type SwarmSection = "roles" | "pilot";

type PilotPreset = "7d" | "14d" | "30d";

const PILOT_PRESET_ORDER: PilotPreset[] = ["7d", "14d", "30d"];

const PILOT_PRESET_LABEL_KEYS: Record<PilotPreset, string> = {
  "7d": "swarm.presets.7d",
  "14d": "swarm.presets.14d",
  "30d": "swarm.presets.30d",
};

/** Sliding day presets like the Quality page's; the upper bound is floored to
 *  the current minute so the query key stays stable across re-renders. */
function computePresetRange(preset: PilotPreset): { from: string; to: string } {
  const now = new Date();
  const floored = new Date(now);
  floored.setSeconds(0, 0);
  const to = floored.toISOString();
  const from = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - (preset === "7d" ? 7 : preset === "30d" ? 30 : 14),
    0,
    0,
    0,
    0,
  ).toISOString();
  return { from, to };
}

/** Remaining lease time as a compact countdown; a non-positive value is expired. */
export function formatCountdown(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "expired";
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  if (hours > 0) return `${hours} h ${minutes} m`;
  if (minutes > 0) return `${minutes} m ${secs} s`;
  return `${secs} s`;
}

/** A lease holder's identity, tolerating a missing identifier/name. */
export function claimHolderLabel(claim: SwarmSupervisorClaim): string {
  return claim.agentName || claim.agentId;
}

/** A queue row's task handle: identifier when present, else the raw id. */
export function queueItemLabel(item: SwarmSupervisorQueueItem): string {
  return item.identifier ?? item.issueId;
}

/** Signed delta for the comparison table; null renders as a dash. */
export function formatDeltaPercent(delta: number | null): string {
  if (delta === null || !Number.isFinite(delta)) return "—";
  const sign = delta > 0 ? "+" : "";
  return `${sign}${delta.toFixed(1)}%`;
}

const COSTS_SOURCE_LABEL_KEYS: Record<BaselineSource["costs"], string> = {
  litellm_cost_events: "swarm.costsSource.litellm",
  cost_events: "swarm.costsSource.costEvents",
  none: "swarm.costsSource.none",
};

const COMPARISON_ROWS: Array<{ key: keyof SwarmPilotComparison; labelKey: string; format: (value: number) => string }> = [
  { key: "cycleTimeHoursMean", labelKey: "swarm.columns.cycleTimeMean", format: (value) => `${value.toFixed(2)} h` },
  { key: "returnRate", labelKey: "swarm.columns.returnRate", format: (value) => `${(value * 100).toFixed(0)}%` },
  { key: "timeInReviewHoursMean", labelKey: "swarm.columns.reviewTimeMean", format: (value) => `${value.toFixed(2)} h` },
  { key: "costPerTaskMeanCents", labelKey: "swarm.columns.costPerTaskMean", format: (value) => formatCents(value) },
];

function formatMetric(value: number | null, format: (value: number) => string): string {
  return value === null || value === undefined ? "—" : format(value);
}

/** Totals strip: one compact cell per overview total. */
function TotalsStrip({ overview }: { overview: SwarmSupervisorOverview }) {
  const { t } = useTranslation();
  const cells: Array<{ label: string; value: number }> = [
    { label: t("swarm.totals.queuedTasks"), value: overview.totals.queued },
    { label: t("swarm.totals.activeLeases"), value: overview.totals.activeClaims },
    { label: t("swarm.totals.expiredLeases"), value: overview.totals.expiredClaims },
    { label: t("swarm.totals.agentsWithLeases"), value: overview.totals.agentsWithClaims },
    { label: t("swarm.totals.idleAgentsWithQueue"), value: overview.totals.idleAgentsWithQueue },
  ];
  return (
    <Card data-testid="swarm-totals">
      <CardContent className="grid grid-cols-2 gap-x-4 gap-y-3 px-5 py-4 sm:grid-cols-3 lg:grid-cols-5">
        {cells.map((cell) => (
          <div key={cell.label}>
            <p className="text-2xl font-semibold tracking-tight tabular-nums">{formatNumber(cell.value)}</p>
            <p className="mt-1 text-xs font-medium text-muted-foreground">{cell.label}</p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

interface TableShellProps {
  title: string;
  description: string;
  emptyMessage: string;
  rowCount: number;
  testId: string;
  children: React.ReactNode;
}

function TableShell({ title, description, emptyMessage, rowCount, testId, children }: TableShellProps) {
  return (
    <div className="space-y-2" data-testid={testId}>
      <div>
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      {rowCount === 0 ? (
        <p className="text-xs text-muted-foreground">{emptyMessage}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">{children}</table>
        </div>
      )}
    </div>
  );
}

const HEAD_CELL = "px-3 py-2 text-left font-medium text-muted-foreground";

function QueueTable({ role }: { role: SwarmSupervisorRole }) {
  const { t } = useTranslation();
  return (
    <TableShell
      title={t("swarm.queueTitle")}
      description={t("swarm.queueDescription")}
      emptyMessage={t("swarm.queueEmpty")}
      rowCount={role.queue.length}
      testId={`swarm-queue-table-${role.role}`}
    >
      <thead>
        <tr className="border-b border-border bg-accent/20">
          <th scope="col" className={HEAD_CELL}>{t("swarm.columns.task")}</th>
          <th scope="col" className={HEAD_CELL}>{t("swarm.columns.priority")}</th>
          <th scope="col" className={HEAD_CELL}>{t("swarm.columns.project")}</th>
          <th scope="col" className={HEAD_CELL}>{t("swarm.columns.queuedAt")}</th>
          <th scope="col" className={HEAD_CELL}>{t("swarm.columns.blockedSince")}</th>
        </tr>
      </thead>
      <tbody>
        {role.queue.map((item) => (
          <tr key={item.issueId} className="border-b border-border last:border-b-0">
            <td className="px-3 py-2">
              <span className="font-mono text-muted-foreground">{queueItemLabel(item)}</span>{" "}
              <span>{item.title}</span>
            </td>
            <td className="px-3 py-2">
              <PriorityIcon priority={item.priority} showLabel />
            </td>
            <td className="px-3 py-2 font-mono text-muted-foreground">{item.projectId ?? "—"}</td>
            <td className="px-3 py-2 tabular-nums">{formatDateTime(item.createdAt)}</td>
            <td className="px-3 py-2 tabular-nums">
              {item.blockedTransitionAt ? formatDateTime(item.blockedTransitionAt) : "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </TableShell>
  );
}

interface ClaimsTableProps {
  role: SwarmSupervisorRole;
  onRelease: (claimId: string) => void;
  releasingClaimId: string | null;
}

function ClaimsTable({ role, onRelease, releasingClaimId }: ClaimsTableProps) {
  const { t } = useTranslation();
  return (
    <TableShell
      title={t("swarm.claimsTitle")}
      description={t("swarm.claimsDescription")}
      emptyMessage={t("swarm.claimsEmpty")}
      rowCount={role.claims.length}
      testId={`swarm-claims-table-${role.role}`}
    >
      <thead>
        <tr className="border-b border-border bg-accent/20">
          <th scope="col" className={HEAD_CELL}>{t("swarm.columns.task")}</th>
          <th scope="col" className={HEAD_CELL}>{t("swarm.columns.priority")}</th>
          <th scope="col" className={HEAD_CELL}>{t("swarm.columns.holder")}</th>
          <th scope="col" className={HEAD_CELL}>{t("swarm.columns.claimedAt")}</th>
          <th scope="col" className={HEAD_CELL}>{t("swarm.columns.heartbeat")}</th>
          <th scope="col" className={HEAD_CELL}>{t("swarm.columns.expires")}</th>
          <th scope="col" className={HEAD_CELL}>{t("swarm.columns.remaining")}</th>
          <th scope="col" className={HEAD_CELL}>{t("swarm.columns.action")}</th>
        </tr>
      </thead>
      <tbody>
        {role.claims.map((claim) => (
          <tr key={claim.claimId} className="border-b border-border last:border-b-0">
            <td className="px-3 py-2">
              <span className="font-mono text-muted-foreground">{claim.identifier ?? claim.issueId}</span>{" "}
              <span>{claim.title}</span>
            </td>
            <td className="px-3 py-2">
              <PriorityIcon priority={claim.priority} showLabel />
            </td>
            <td className="px-3 py-2">
              <span className="font-mono" data-testid={`swarm-claim-holder-${claim.claimId}`}>
                {claimHolderLabel(claim)}
              </span>
            </td>
            <td className="px-3 py-2 tabular-nums">{formatDateTime(claim.claimedAt)}</td>
            <td className="px-3 py-2 tabular-nums">
              {claim.heartbeatAt ? formatDateTime(claim.heartbeatAt) : "—"}
            </td>
            <td className="px-3 py-2 tabular-nums">{formatDateTime(claim.expiresAt)}</td>
            <td className="px-3 py-2 tabular-nums">
              {claim.expired ? (
                <span className="text-destructive" data-testid={`swarm-claim-expired-${claim.claimId}`}>
                  {t("swarm.expired")}
                </span>
              ) : (
                <span data-testid={`swarm-claim-countdown-${claim.claimId}`}>
                  {formatCountdown(claim.secondsToExpiry)}
                </span>
              )}
            </td>
            <td className="px-3 py-2">
              <Button
                variant="outline"
                size="xs"
                data-testid={`swarm-release-${claim.claimId}`}
                disabled={releasingClaimId === claim.claimId}
                onClick={() => onRelease(claim.claimId)}
              >
                {t("swarm.releaseLease")}
              </Button>
            </td>
          </tr>
        ))}
      </tbody>
    </TableShell>
  );
}

interface IdleAgentsTableProps {
  role: SwarmSupervisorRole;
  maxActiveTasksPerAgent: number | null;
}

function IdleAgentsTable({ role, maxActiveTasksPerAgent }: IdleAgentsTableProps) {
  const { t } = useTranslation();
  const cap = maxActiveTasksPerAgent;
  return (
    <TableShell
      title={t("swarm.idleTitle")}
      description={t("swarm.idleDescription")}
      emptyMessage={t("swarm.idleEmpty")}
      rowCount={role.idleAgents.length}
      testId={`swarm-idle-table-${role.role}`}
    >
      <thead>
        <tr className="border-b border-border bg-accent/20">
          <th scope="col" className={HEAD_CELL}>{t("swarm.columns.agent")}</th>
          <th scope="col" className={HEAD_CELL}>{t("swarm.columns.agentId")}</th>
          <th scope="col" className={HEAD_CELL}>{t("swarm.columns.activeLeases")}</th>
          <th scope="col" className={HEAD_CELL}>{t("swarm.columns.loadVsCap")}</th>
          <th scope="col" className={HEAD_CELL}>{t("swarm.columns.limit")}</th>
        </tr>
      </thead>
      <tbody>
        {role.idleAgents.map((agent: SwarmSupervisorIdleAgent) => (
          <tr key={agent.agentId} className="border-b border-border last:border-b-0">
            <td className="px-3 py-2">{agent.name}</td>
            <td className="px-3 py-2 font-mono text-muted-foreground">{agent.agentId}</td>
            <td className="px-3 py-2 tabular-nums">{formatNumber(agent.activeClaims)}</td>
            <td className="px-3 py-2 tabular-nums">
              {cap === null ? "—" : `${agent.activeClaims} / ${cap}`}
            </td>
            <td className="px-3 py-2">
              {agent.atLimit ? <span className="text-destructive">{t("swarm.atLimit")}</span> : <span className="text-muted-foreground">—</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </TableShell>
  );
}

function RoleSection({
  role,
  maxActiveTasksPerAgent,
  onRelease,
  releasingClaimId,
}: {
  role: SwarmSupervisorRole;
  maxActiveTasksPerAgent: number | null;
  onRelease: (claimId: string) => void;
  releasingClaimId: string | null;
}) {
  const { t } = useTranslation();
  return (
    <Card data-testid={`swarm-role-${role.role}`}>
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle className="text-base">{role.role}</CardTitle>
        <CardDescription>
          {t("swarm.roleSummary", {
            queued: formatNumber(role.queue.length),
            leases: formatNumber(role.claims.length),
            idle: formatNumber(role.idleAgents.length),
          })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5 px-5 pb-5 pt-2">
        <QueueTable role={role} />
        <ClaimsTable role={role} onRelease={onRelease} releasingClaimId={releasingClaimId} />
        <IdleAgentsTable role={role} maxActiveTasksPerAgent={maxActiveTasksPerAgent} />
      </CardContent>
    </Card>
  );
}

interface SnapshotTableProps {
  title: string;
  description: string;
  report: BaselineMetricsReport | null;
  emptyMessage: string;
  testId: string;
}

function SnapshotTable({ title, description, report, emptyMessage, testId }: SnapshotTableProps) {
  const { t } = useTranslation();
  const rows: BaselineMetricRow[] = report?.byProject ?? [];
  return (
    <Card data-testid={testId}>
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 px-5 pb-5 pt-2">
        {report ? (
          <p className="text-xs text-muted-foreground">
            {t("swarm.generated", { time: formatDateTime(report.generatedAt) })} ·{" "}
            {t("swarm.costSourceLine", { source: t(COSTS_SOURCE_LABEL_KEYS[report.source.costs]) })}
          </p>
        ) : null}
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{emptyMessage}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-accent/20">
                  <th scope="col" className={HEAD_CELL}>{t("swarm.columns.project")}</th>
                  <th scope="col" className={HEAD_CELL}>{t("swarm.columns.tasksDone")}</th>
                  <th scope="col" className={HEAD_CELL}>{t("swarm.columns.cycleTimeMean")}</th>
                  <th scope="col" className={HEAD_CELL}>{t("swarm.columns.reviewTimeMean")}</th>
                  <th scope="col" className={HEAD_CELL}>{t("swarm.columns.returnRate")}</th>
                  <th scope="col" className={HEAD_CELL}>{t("swarm.columns.costPerTaskMean")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key ?? "__none__"} className="border-b border-border last:border-b-0">
                    <td className="px-3 py-2 font-mono">{row.key ?? t("quality.noProject")}</td>
                    <td className="px-3 py-2 tabular-nums">{formatNumber(row.tasksCompleted)}</td>
                    <td className="px-3 py-2 tabular-nums">{row.cycleTimeHours.mean.toFixed(2)} h</td>
                    <td className="px-3 py-2 tabular-nums">{row.timeInReviewHours.mean.toFixed(2)} h</td>
                    <td className="px-3 py-2 tabular-nums">
                      {row.returnRate.enteredReview > 0 ? `${(row.returnRate.rate * 100).toFixed(0)}%` : "—"}
                    </td>
                    <td className="px-3 py-2 tabular-nums">{formatCents(row.costPerTask.meanCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface PilotSectionProps {
  companyId: string;
  section: SwarmSection;
}

function PilotSection({ companyId, section }: PilotSectionProps) {
  const { t } = useTranslation();
  const [preset, setPreset] = useState<PilotPreset>("14d");
  const { from, to } = computePresetRange(preset);

  const { data, isLoading, error } = useQuery({
    queryKey: swarmSupervisorPilotReportKey(companyId, from, to),
    queryFn: () => swarmSupervisorApi.pilotReport(companyId, { from, to }),
    enabled: section === "pilot",
    staleTime: 30_000,
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2" data-testid="swarm-pilot-presets">
        {PILOT_PRESET_ORDER.map((key) => (
          <Button
            key={key}
            variant={preset === key ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setPreset(key)}
            aria-pressed={preset === key}
          >
            {t(PILOT_PRESET_LABEL_KEYS[key])}
          </Button>
        ))}
      </div>

      {isLoading ? (
        <PageSkeleton variant="costs" />
      ) : error ? (
        isSwarmPilotNotEnabled(error) ? (
          <EmptyState
            icon={Activity}
            title={t("swarm.pilotDisabled")}
            message={t("swarm.pilotDisabledMessage")}
            description={t("swarm.pilotDisabledDescription")}
          />
        ) : (
          <p className="text-sm text-destructive" data-testid="swarm-pilot-error">
            {(error as Error).message}
          </p>
        )
      ) : !data ? (
        <EmptyState
          icon={Activity}
          title={t("swarm.noPilotReport")}
          message={t("swarm.noPilotReportMessage")}
        />
      ) : (
        <>
          <div
            className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground"
            data-testid="swarm-pilot-meta"
          >
            <span>
              {data.window
                ? `${formatDateTime(data.window.from)} – ${formatDateTime(data.window.to)}`
                : t("swarm.noWindow")}
            </span>
            <span>{t("swarm.generated", { time: formatDateTime(data.generatedAt) })}</span>
          </div>

          <Card data-testid="swarm-pilot-comparison">
            <CardHeader className="px-5 pt-5 pb-2">
              <CardTitle className="text-base">{t("swarm.pilotComparisonTitle")}</CardTitle>
              <CardDescription>
                {t("swarm.pilotComparisonDescription")}
              </CardDescription>
            </CardHeader>
            <CardContent className="px-5 pb-5 pt-2">
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border bg-accent/20">
                      <th scope="col" className={HEAD_CELL}>{t("swarm.columns.metric")}</th>
                      <th scope="col" className={HEAD_CELL}>{t("swarm.columns.pilot")}</th>
                      <th scope="col" className={HEAD_CELL}>{t("swarm.columns.baseline")}</th>
                      <th scope="col" className={HEAD_CELL}>{t("swarm.columns.delta")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {COMPARISON_ROWS.map((row) => {
                      const metric = data.comparison[row.key];
                      return (
                        <tr key={row.key} className="border-b border-border last:border-b-0">
                          <td className="px-3 py-2">{t(row.labelKey)}</td>
                          <td className="px-3 py-2 tabular-nums">{formatMetric(metric.pilot, row.format)}</td>
                          <td className="px-3 py-2 tabular-nums">{formatMetric(metric.baseline, row.format)}</td>
                          <td className="px-3 py-2 tabular-nums" data-testid={`swarm-delta-${row.key}`}>
                            {formatDeltaPercent(metric.deltaPercent)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          {data.notes.length > 0 ? (
            <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground" data-testid="swarm-pilot-notes">
              {data.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          ) : null}

          <div className="grid gap-4 xl:grid-cols-2">
            <SnapshotTable
              title={t("swarm.pilotWindow")}
              description={t("swarm.pilotWindowDescription")}
              report={data.pilot}
              emptyMessage={t("swarm.pilotWindowEmpty")}
              testId="swarm-pilot-snapshot"
            />
            <SnapshotTable
              title={t("swarm.baselineSnapshot")}
              description={t("swarm.baselineSnapshotDescription")}
              report={data.baseline}
              emptyMessage={t("swarm.baselineSnapshotEmpty")}
              testId="swarm-baseline-snapshot"
            />
          </div>
        </>
      )}
    </div>
  );
}

export function SwarmSupervisor() {
  const { t } = useTranslation();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const companyId = selectedCompanyId ?? NO_COMPANY;

  const [section, setSection] = useState<SwarmSection>("roles");

  useEffect(() => {
    setBreadcrumbs([{ label: t("swarm.title") }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: swarmSupervisorOverviewKey(companyId),
    queryFn: () => swarmSupervisorApi.overview(companyId),
    enabled: !!selectedCompanyId,
    staleTime: 15_000,
  });

  const releaseMutation = useMutation({
    mutationFn: (claimId: string) => swarmSupervisorApi.releaseLease(companyId, { claimId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: swarmSupervisorOverviewKey(companyId) });
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Users} message={t("swarm.selectOrganization")} />;
  }

  const releasingClaimId = releaseMutation.isPending
    ? (releaseMutation.variables ?? null)
    : null;

  return (
    <div className="space-y-6">
      <div className="space-y-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">{t("swarm.title")}</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              {t("swarm.intro")}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2" data-testid="swarm-section-switch">
            <Button
              variant={section === "roles" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setSection("roles")}
              aria-pressed={section === "roles"}
            >
              {t("swarm.sections.roles")}
            </Button>
            <Button
              variant={section === "pilot" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setSection("pilot")}
              aria-pressed={section === "pilot"}
            >
              {t("swarm.sections.pilot")}
            </Button>
          </div>
        </div>

        {data ? (
          <div
            className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground"
            data-testid="swarm-overview-meta"
          >
            <span className="flex items-center gap-1.5">
              <Clock className="h-4 w-4" />
              {t("swarm.generated", { time: formatDateTime(data.generatedAt) })}
            </span>
            <span className="flex items-center gap-1.5">
              <RotateCw className="h-4 w-4" />
              {data.leaseTtlSec === null ? "—" : t("swarm.leaseTtl", { seconds: `${formatNumber(data.leaseTtlSec)} s` })}
            </span>
            <span className="flex items-center gap-1.5">
              <ShieldCheck className="h-4 w-4" />
              {t("swarm.maxActive")}{" "}
              {data.maxActiveTasksPerAgent === null ? "—" : formatNumber(data.maxActiveTasksPerAgent)}
            </span>
          </div>
        ) : null}
      </div>

      {isLoading ? (
        <PageSkeleton variant="costs" />
      ) : error ? (
        isSwarmPilotNotEnabled(error) ? (
          <EmptyState
            icon={ShieldCheck}
            title={t("swarm.notAvailable")}
            message={t("swarm.notAvailableMessage")}
            description={t("swarm.notAvailableDescription")}
          />
        ) : (
          <p className="text-sm text-destructive" data-testid="swarm-error">
            {(error as Error).message}
          </p>
        )
      ) : !data ? (
        <EmptyState
          icon={Users}
          title={t("swarm.noOverview")}
          message={t("swarm.noOverviewMessage")}
        />
      ) : !data.enabled ? (
        <EmptyState
          icon={ShieldCheck}
          title={t("swarm.disabled")}
          message={t("swarm.disabledMessage")}
          description={t("swarm.disabledDescription")}
        />
      ) : (
        <>
          <TotalsStrip overview={data} />

          {releaseMutation.isError ? (
            <p className="text-sm text-destructive" data-testid="swarm-release-error">
              {isSwarmPilotNotEnabled(releaseMutation.error)
                ? t("swarm.releaseNotEnabled")
                : t("swarm.releaseFailed", { message: (releaseMutation.error as Error).message })}
            </p>
          ) : null}

          {section === "roles" ? (
            <div className="space-y-4">
              {data.roles.length === 0 ? (
                <EmptyState
                  icon={ListChecks}
                  title={t("swarm.noRoles")}
                  message={t("swarm.noRolesMessage")}
                />
              ) : (
                data.roles.map((role) => (
                  <RoleSection
                    key={role.role}
                    role={role}
                    maxActiveTasksPerAgent={data.maxActiveTasksPerAgent}
                    onRelease={(claimId) => releaseMutation.mutate(claimId)}
                    releasingClaimId={releasingClaimId}
                  />
                ))
              )}

              {data.topQueue.length > 0 ? (
                <Card data-testid="swarm-top-queue">
                  <CardHeader className="px-5 pt-5 pb-2">
                    <CardTitle className="text-base flex items-center gap-1.5">
                      <TriangleAlert className="h-4 w-4 text-muted-foreground" />
                      {t("swarm.topQueue")}
                    </CardTitle>
                    <CardDescription>{t("swarm.topQueueDescription")}</CardDescription>
                  </CardHeader>
                  <CardContent className="px-5 pb-5 pt-2">
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b border-border bg-accent/20">
                            <th scope="col" className={HEAD_CELL}>{t("swarm.columns.task")}</th>
                            <th scope="col" className={HEAD_CELL}>{t("swarm.columns.role")}</th>
                            <th scope="col" className={HEAD_CELL}>{t("swarm.columns.priority")}</th>
                            <th scope="col" className={HEAD_CELL}>{t("swarm.columns.project")}</th>
                            <th scope="col" className={HEAD_CELL}>{t("swarm.columns.queuedAt")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.topQueue.map((item) => (
                            <tr key={item.issueId} className="border-b border-border last:border-b-0">
                              <td className="px-3 py-2">
                                <span className="font-mono text-muted-foreground">
                                  {item.identifier ?? item.issueId}
                                </span>{" "}
                                <span>{item.title}</span>
                              </td>
                              <td className="px-3 py-2">{item.role}</td>
                              <td className="px-3 py-2">
                                <PriorityIcon priority={item.priority} showLabel />
                              </td>
                              <td className="px-3 py-2 font-mono text-muted-foreground">{item.projectId ?? "—"}</td>
                              <td className="px-3 py-2 tabular-nums">{formatDateTime(item.createdAt)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </CardContent>
                </Card>
              ) : null}
            </div>
          ) : (
            <PilotSection companyId={companyId} section={section} />
          )}
        </>
      )}
    </div>
  );
}