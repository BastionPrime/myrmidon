// WIP-LIMIT 1.6.1 part B (UI): API client for the per-agent work-in-progress
// limit. Server side (part A): GET/PUT
// /api/myrmidon/companies/:companyId/wip-limit/settings and GET
// /api/myrmidon/companies/:companyId/wip-limit/status. The JSON contract is
// fixed by the task; until part A merges, the UI tests mock this client's
// return shape.
import { api } from "@/api/client";

/** GET/PUT settings body: the default limit plus per-agent overrides. */
export interface WipLimitSettings {
  defaultLimit: number | null;
  perAgent: Record<string, number | null>;
}

/** One row of GET .../wip-limit/status for a single agent. */
export interface WipLimitStatusRow {
  agentId: string;
  inProgress: number;
  inReview: number;
  wip: number;
  limit: number | null;
  overLimit: boolean;
}

const base = (companyId: string) =>
  `/myrmidon/companies/${encodeURIComponent(companyId)}/wip-limit`;

export const wipLimitSettingsQueryKey = (companyId: string) =>
  ["myrmidon", "wip-limit", "settings", companyId] as const;

export const wipLimitStatusQueryKey = (companyId: string) =>
  ["myrmidon", "wip-limit", "status", companyId] as const;

export const wipLimitApi = {
  settings: (companyId: string) =>
    api.get<WipLimitSettings>(`${base(companyId)}/settings`),
  saveSettings: (companyId: string, settings: WipLimitSettings) =>
    api.put<WipLimitSettings>(`${base(companyId)}/settings`, settings),
  status: (companyId: string) =>
    api.get<WipLimitStatusRow[]>(`${base(companyId)}/status`),
};

/**
 * Effective limit for one agent: the per-agent override wins over the default,
 * and both may be off (`null`). Exported for the agent-card badge.
 */
export function effectiveWipLimit(
  settings: Pick<WipLimitSettings, "defaultLimit" | "perAgent"> | null | undefined,
  agentId: string,
): number | null {
  if (!settings) return null;
  if (agentId in settings.perAgent) return settings.perAgent[agentId] ?? null;
  return settings.defaultLimit ?? null;
}
