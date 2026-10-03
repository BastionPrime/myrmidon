// myrmidon(1.6-SWARM-CLAIM-B): API client for the "Swarm supervisor" page —
// per-role task queues, active/expired role leases and rebalance actions, plus
// the pilot report compared against the frozen BASELINE snapshot.
// Server side (part A, the JSON contract is frozen in the design note):
//   GET  .../swarm-claim/supervisor/overview
//   POST .../swarm-claim/supervisor/release-lease
//   GET  .../swarm-claim/supervisor/pilot-report?from=<ISO>&to=<ISO>
// Until part A merges, the tests mock this client's return shape.

import { api, ApiError } from "@/api/client";
import type { BaselineMetricsReport } from "@/api/baseline";

export interface SwarmSupervisorQueueItem {
  issueId: string;
  identifier: string | null;
  title: string;
  priority: string;
  projectId: string | null;
  createdAt: string;
  blockedTransitionAt: string | null;
}

export interface SwarmSupervisorTopQueueItem {
  issueId: string;
  identifier: string | null;
  title: string;
  priority: string;
  role: string;
  projectId: string | null;
  createdAt: string;
}

export interface SwarmSupervisorClaim {
  claimId: string;
  issueId: string;
  identifier: string | null;
  title: string;
  priority: string;
  agentId: string;
  agentName: string;
  claimedAt: string;
  expiresAt: string;
  heartbeatAt: string | null;
  expired: boolean;
  secondsToExpiry: number;
}

export interface SwarmSupervisorIdleAgent {
  agentId: string;
  name: string;
  activeClaims: number;
  atLimit: boolean;
}

export interface SwarmSupervisorRole {
  role: string;
  queue: SwarmSupervisorQueueItem[];
  claims: SwarmSupervisorClaim[];
  idleAgents: SwarmSupervisorIdleAgent[];
}

export interface SwarmSupervisorTotals {
  queued: number;
  activeClaims: number;
  expiredClaims: number;
  agentsWithClaims: number;
  idleAgentsWithQueue: number;
}

export interface SwarmSupervisorOverview {
  enabled: boolean;
  generatedAt: string;
  leaseTtlSec: number | null;
  maxActiveTasksPerAgent: number | null;
  /**
   * myrmidon(1.6.1 SWARM-SETTINGS-UI): where each effective pilot setting
   * came from — "settings" (the UI), "env" (the forced override) or "default".
   */
  settingSources: Record<string, string>;
  totals: SwarmSupervisorTotals;
  roles: SwarmSupervisorRole[];
  topQueue: SwarmSupervisorTopQueueItem[];
}

export interface SwarmReleaseLeaseInput {
  claimId: string;
  reason?: string;
}

export interface SwarmReleaseLeaseResult {
  released: boolean;
  claimId: string;
  issueId: string | null;
  wokenAgentId: string | null;
  reason: string;
}

/** One row of the pilot-vs-baseline comparison: a metric on each side. */
export interface SwarmComparisonMetric {
  pilot: number | null;
  baseline: number | null;
  deltaPercent: number | null;
}

export interface SwarmPilotComparison {
  cycleTimeHoursMean: SwarmComparisonMetric;
  returnRate: SwarmComparisonMetric;
  timeInReviewHoursMean: SwarmComparisonMetric;
  costPerTaskMeanCents: SwarmComparisonMetric;
}

export interface SwarmPilotReport {
  window: { from: string; to: string } | null;
  enabled: boolean;
  generatedAt: string;
  pilot: BaselineMetricsReport | null;
  baseline: BaselineMetricsReport | null;
  comparison: SwarmPilotComparison;
  notes: string[];
}

const supervisorBase = (companyId: string) =>
  `/myrmidon/companies/${encodeURIComponent(companyId)}/swarm-claim/supervisor`;

export const swarmSupervisorApi = {
  overview: (companyId: string) =>
    api.get<SwarmSupervisorOverview>(`${supervisorBase(companyId)}/overview`),

  releaseLease: (companyId: string, input: SwarmReleaseLeaseInput) =>
    api.post<SwarmReleaseLeaseResult>(`${supervisorBase(companyId)}/release-lease`, {
      claimId: input.claimId,
      ...(input.reason ? { reason: input.reason } : {}),
    }),

  pilotReport: (companyId: string, window?: { from?: string; to?: string }) => {
    const params = new URLSearchParams();
    if (window?.from) params.set("from", window.from);
    if (window?.to) params.set("to", window.to);
    const qs = params.toString();
    return api.get<SwarmPilotReport>(`${supervisorBase(companyId)}/pilot-report${qs ? `?${qs}` : ""}`);
  },
};

export const swarmSupervisorOverviewKey = (companyId: string) =>
  ["myrmidon", "swarm-claim", "supervisor", "overview", companyId] as const;

export const swarmSupervisorPilotReportKey = (companyId: string, from?: string, to?: string) =>
  ["myrmidon", "swarm-claim", "supervisor", "pilot-report", companyId, from ?? null, to ?? null] as const;

/** 503 body while the pilot flag is off: { error, enabled: false }. */
export function isSwarmPilotNotEnabled(err: unknown): boolean {
  if (err instanceof ApiError) {
    const body = err.body as { enabled?: boolean } | null;
    if (body && body.enabled === false) return true;
    return err.status === 503 && /not enabled/i.test(err.message);
  }
  return err instanceof Error && /not enabled/i.test(err.message);
}