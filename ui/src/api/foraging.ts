// myrmidon(1.6-FORAGE): API client for the "Foraging" page — the source registry
// of a company, the findings the passes produced, the candidate state of those
// findings and the per-pass budget. Server side:
// GET/PUT/DELETE /api/myrmidon/companies/:id/foraging/* (foraging/routes.ts).
//
// The page reads the registry and the findings even while the sweep is switched
// off; `enabled` on every response says whether a pass is running at all.

import { api } from "@/api/client";

export type ForagingSourceKind = "url" | "feed" | "repo" | "docs";

export type ForagingFindingStatus = "unverified" | "candidate" | "rejected";

export interface ForagingSource {
  id: string;
  role: string;
  url: string;
  kind: ForagingSourceKind;
  enabled: boolean;
  lastSnapshotAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  snapshotLines: number | null;
}

export interface ForagingFinding {
  id: string;
  sourceId: string;
  role: string;
  status: ForagingFindingStatus;
  summary: string;
  diff: { added: string[]; removed: string[] };
  skillKey: string;
  candidateRef: string | null;
  reason: string | null;
  detectedAt: string;
}

export interface ForagingBudgetView {
  enabled: boolean;
  budget: { maxCostCents: number; enabled: boolean };
  spentCents: number;
  minHostIntervalMs: number;
  intervalMs: number;
}

export interface ForagingSourceInput {
  role: string;
  url: string;
  kind: ForagingSourceKind;
  enabled?: boolean;
}

const base = (companyId: string) =>
  `/myrmidon/companies/${encodeURIComponent(companyId)}/foraging`;

export const foragingApi = {
  sources: (companyId: string) =>
    api.get<{ sources: ForagingSource[]; enabled: boolean }>(`${base(companyId)}/sources`),
  saveSource: (companyId: string, input: ForagingSourceInput) =>
    api.put<ForagingSource>(`${base(companyId)}/sources`, input),
  removeSource: (companyId: string, sourceId: string) =>
    api.delete<{ removed: boolean }>(`${base(companyId)}/sources/${encodeURIComponent(sourceId)}`),
  findings: (companyId: string, limit = 50) =>
    api.get<{ findings: ForagingFinding[]; enabled: boolean }>(
      `${base(companyId)}/findings?limit=${limit}`,
    ),
  budget: (companyId: string) => api.get<ForagingBudgetView>(`${base(companyId)}/budget`),
  sweep: (companyId: string) => api.post<Record<string, unknown>>(`${base(companyId)}/sweep`, {}),
};

export const foragingSourcesKey = (companyId: string) => ["foraging", "sources", companyId] as const;
export const foragingFindingsKey = (companyId: string) => ["foraging", "findings", companyId] as const;
export const foragingBudgetKey = (companyId: string) => ["foraging", "budget", companyId] as const;

/** A short label for a finding's state, used by the table. */
export function findingStatusLabel(status: ForagingFindingStatus): string {
  switch (status) {
    case "candidate":
      return "Candidate";
    case "rejected":
      return "Rejected";
    default:
      return "Unverified";
  }
}

/** One line describing a diff, for the findings list. */
export function diffLine(diff: ForagingFinding["diff"]): string {
  const parts: string[] = [];
  if (diff.added.length > 0) parts.push(`+${diff.added.length}`);
  if (diff.removed.length > 0) parts.push(`-${diff.removed.length}`);
  return parts.length > 0 ? parts.join(" ") : "no change";
}