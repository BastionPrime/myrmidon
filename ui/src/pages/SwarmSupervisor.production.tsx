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

const PILOT_PRESET_LABELS: Record<PilotPreset, string> = {
  "7d": "Last 7 Days",
  "14d": "Last 14 Days",
  "30d": "Last 30 Days",
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

const COSTS_SOURCE_LABELS: Record<BaselineSource["costs"], string> = {
  litellm_cost_events: "LLM gateway cost events",
  cost_events: "adapter cost events",
  none: "no cost source",
};

interface ComparisonRow {
  key: keyof SwarmPilotComparison;
  label: string;
  format: (value: number) => string;
}

const COMPARISON_ROWS: ComparisonRow[] = [
  { key: "cycleTimeHoursMean", label: "Cycle time (mean)", format: (value) => `${value.toFixed(2)} h` },
  { key: "returnRate", label: "Return rate", format: (value) => `${(value * 100).toFixed(0)}%` },
  { key: "timeInReviewHoursMean", label: "Time in review (mean)", format: (value) => `${value.toFixed(2)} h` },
  { key: "costPerTaskMeanCents", label: "Cost per task (mean)", format: (value) => formatCents(value) },
];

function formatMetric(value: number | null, format: (value: number) => string): string {
  return value === null || value === undefined ? "—" : format(value);
}

/** Totals strip: one compact cell per overview total. */
function TotalsStrip({ overview }: { overview: SwarmSupervisorOverview }) {
  const cells: Array<{ label: string; value: number }> = [
    { label: "Queued tasks", value: overview.totals.queued },
    { label: "Active leases", value: overview.totals.activeClaims },
    { label: "Expired leases", value: overview.totals.expiredClaims },
    { label: "Agents with leases", value: overview.totals.agentsWithClaims },
    { label: "Idle agents with queue", value: overview.totals.idleAgentsWithQueue },
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
  return (
    <TableShell
      title="Queue"
      description="Assigned tasks waiting for a claim in this role, oldest first."
      emptyMessage="No queued tasks for this role."
      rowCount={role.queue.length}
      testId={`swarm-queue-table-${role.role}`}
    >
      <thead>
        <tr className="border-b border-border bg-accent/20">
          <th scope="col" className={HEAD_CELL}>Task</th>
          <th scope="col" className={HEAD_CELL}>Priority</th>
          <th scope="col" className={HEAD_CELL}>Project</th>
          <th scope="col" className={HEAD_CELL}>Queued at</th>
          <th scope="col" className={HEAD_CELL}>Blocked since</th>
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
  return (
    <TableShell
      title="Active leases"
      description="Live claims held by agents in this role; expired rows are awaiting release."
      emptyMessage="No active leases for this role."
      rowCount={role.claims.length}
      testId={`swarm-claims-table-${role.role}`}
    >
      <thead>
        <tr className="border-b border-border bg-accent/20">
          <th scope="col" className={HEAD_CELL}>Task</th>
          <th scope="col" className={HEAD_CELL}>Priority</th>
          <th scope="col" className={HEAD_CELL}>Holder</th>
          <th scope="col" className={HEAD_CELL}>Claimed at</th>
          <th scope="col" className={HEAD_CELL}>Heartbeat</th>
          <th scope="col" className={HEAD_CELL}>Expires</th>
          <th scope="col" className={HEAD_CELL}>Remaining</th>
          <th scope="col" className={HEAD_CELL}>Action</th>
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
                  expired
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
                Release lease
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
  const cap = maxActiveTasksPerAgent;
  return (
    <TableShell
      title="Idle agents"
      description="Agents in this role with spare capacity, including their current load against the cap."
      emptyMessage="No idle agents for this role."
      rowCount={role.idleAgents.length}
      testId={`swarm-idle-table-${role.role}`}
    >
      <thead>
        <tr className="border-b border-border bg-accent/20">
          <th scope="col" className={HEAD_CELL}>Agent</th>
          <th scope="col" className={HEAD_CELL}>Agent ID</th>
          <th scope="col" className={HEAD_CELL}>Active leases</th>
          <th scope="col" className={HEAD_CELL}>Load vs cap</th>
          <th scope="col" className={HEAD_CELL}>Limit</th>
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
              {agent.atLimit ? <span className="text-destructive">At limit</span> : <span className="text-muted-foreground">—</span>}
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
  return (
    <Card data-testid={`swarm-role-${role.role}`}>
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle className="text-base">{role.role}</CardTitle>
        <CardDescription>
          {formatNumber(role.queue.length)} queued · {formatNumber(role.claims.length)} leases ·{" "}
          {formatNumber(role.idleAgents.length)} idle agents
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
            Generated {formatDateTime(report.generatedAt)} · cost source:{" "}
            {COSTS_SOURCE_LABELS[report.source.costs]}
          </p>
        ) : null}
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{emptyMessage}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-accent/20">
                  <th scope="col" className={HEAD_CELL}>Project</th>
                  <th scope="col" className={HEAD_CELL}>Tasks done</th>
                  <th scope="col" className={HEAD_CELL}>Cycle time (mean)</th>
                  <th scope="col" className={HEAD_CELL}>Review time (mean)</th>
                  <th scope="col" className={HEAD_CELL}>Return rate</th>
                  <th scope="col" className={HEAD_CELL}>Cost per task (mean)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key ?? "__none__"} className="border-b border-border last:border-b-0">
                    <td className="px-3 py-2 font-mono">{row.key ?? "No project"}</td>
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
            {PILOT_PRESET_LABELS[key]}
          </Button>
        ))}
      </div>

      {isLoading ? (
        <PageSkeleton variant="costs" />
      ) : error ? (
        isSwarmPilotNotEnabled(error) ? (
          <EmptyState
            icon={Activity}
            title="Swarm pilot is disabled"
            message="The server answered that the swarm pilot is not enabled on this instance."
            description="The pilot flag is off by default; ask the operator to enable the swarm pilot before comparing against BASELINE."
          />
        ) : (
          <p className="text-sm text-destructive" data-testid="swarm-pilot-error">
            {(error as Error).message}
          </p>
        )
      ) : !data ? (
        <EmptyState
          icon={Activity}
          title="No pilot report yet"
          message="The supervisor has not produced a pilot report for this window."
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
                : "No window"}
            </span>
            <span>Generated {formatDateTime(data.generatedAt)}</span>
          </div>

          <Card data-testid="swarm-pilot-comparison">
            <CardHeader className="px-5 pt-5 pb-2">
              <CardTitle className="text-base">Pilot vs BASELINE</CardTitle>
              <CardDescription>
                Mean values over the window: the swarm pilot beside the frozen BASELINE snapshot.
              </CardDescription>
            </CardHeader>
            <CardContent className="px-5 pb-5 pt-2">
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border bg-accent/20">
                      <th scope="col" className={HEAD_CELL}>Metric</th>
                      <th scope="col" className={HEAD_CELL}>Pilot</th>
                      <th scope="col" className={HEAD_CELL}>BASELINE</th>
                      <th scope="col" className={HEAD_CELL}>Delta</th>
                    </tr>
                  </thead>
                  <tbody>
                    {COMPARISON_ROWS.map((row) => {
                      const metric = data.comparison[row.key];
                      return (
                        <tr key={row.key} className="border-b border-border last:border-b-0">
                          <td className="px-3 py-2">{row.label}</td>
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
              title="Pilot window"
              description="Delivery metrics for the pilot window, by project."
              report={data.pilot}
              emptyMessage="No pilot data in this window."
              testId="swarm-pilot-snapshot"
            />
            <SnapshotTable
              title="BASELINE snapshot"
              description="The frozen BASELINE reference the pilot is measured against, by project."
              report={data.baseline}
              emptyMessage="No BASELINE snapshot yet."
              testId="swarm-baseline-snapshot"
            />
          </div>
        </>
      )}
    </div>
  );
}

export function SwarmSupervisor() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const companyId = selectedCompanyId ?? NO_COMPANY;

  const [section, setSection] = useState<SwarmSection>("roles");

  useEffect(() => {
    setBreadcrumbs([{ label: "Swarm supervisor" }]);
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
    return <EmptyState icon={Users} message="Select an organization to view swarm role queues." />;
  }

  const releasingClaimId = releaseMutation.isPending
    ? (releaseMutation.variables ?? null)
    : null;

  return (
    <div className="space-y-6">
      <div className="space-y-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Swarm supervisor</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              Role queues, live role leases and rebalance actions, plus the pilot report compared
              against the frozen BASELINE snapshot.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2" data-testid="swarm-section-switch">
            <Button
              variant={section === "roles" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setSection("roles")}
              aria-pressed={section === "roles"}
            >
              Role queues
            </Button>
            <Button
              variant={section === "pilot" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setSection("pilot")}
              aria-pressed={section === "pilot"}
            >
              Pilot vs BASELINE
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
              Generated {formatDateTime(data.generatedAt)}
            </span>
            <span className="flex items-center gap-1.5">
              <RotateCw className="h-4 w-4" />
              Lease TTL: {data.leaseTtlSec === null ? "—" : `${formatNumber(data.leaseTtlSec)} s`}
            </span>
            <span className="flex items-center gap-1.5">
              <ShieldCheck className="h-4 w-4" />
              Max active tasks per agent:{" "}
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
            title="Swarm supervisor is not available"
            message="The server answered that the swarm-claim supervisor is not enabled on this instance."
            description="Ask the operator to enable the swarm pilot before inspecting role queues and leases."
          />
        ) : (
          <p className="text-sm text-destructive" data-testid="swarm-error">
            {(error as Error).message}
          </p>
        )
      ) : !data ? (
        <EmptyState
          icon={Users}
          title="No supervisor overview yet"
          message="The supervisor has not produced an overview for this organization."
        />
      ) : !data.enabled ? (
        <EmptyState
          icon={ShieldCheck}
          title="Swarm supervisor is disabled"
          message="This organization has the supervisor report disabled."
          description="The pilot flag is off; ask the operator to enable it before inspecting role queues."
        />
      ) : (
        <>
          <TotalsStrip overview={data} />

          {releaseMutation.isError ? (
            <p className="text-sm text-destructive" data-testid="swarm-release-error">
              {isSwarmPilotNotEnabled(releaseMutation.error)
                ? "The swarm-claim supervisor is not enabled on this instance."
                : `Release failed: ${(releaseMutation.error as Error).message}`}
            </p>
          ) : null}

          {section === "roles" ? (
            <div className="space-y-4">
              {data.roles.length === 0 ? (
                <EmptyState
                  icon={ListChecks}
                  title="No roles to supervise"
                  message="No role currently has queued tasks, live leases or idle agents."
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
                      Top queue
                    </CardTitle>
                    <CardDescription>The oldest queued tasks across every role.</CardDescription>
                  </CardHeader>
                  <CardContent className="px-5 pb-5 pt-2">
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b border-border bg-accent/20">
                            <th scope="col" className={HEAD_CELL}>Task</th>
                            <th scope="col" className={HEAD_CELL}>Role</th>
                            <th scope="col" className={HEAD_CELL}>Priority</th>
                            <th scope="col" className={HEAD_CELL}>Project</th>
                            <th scope="col" className={HEAD_CELL}>Queued at</th>
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