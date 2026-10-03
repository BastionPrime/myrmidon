// myrmidon(1.6.1 WIP-LIMIT B): API client for the "WIP limit" settings and
// the agent WIP status. Part A (OPE-3870-A) owns the server routes; this
// client speaks the frozen contract:
//
//   GET /api/myrmidon/companies/:companyId/wip-limit/settings
//        -> { defaultLimit: number | null, perAgent: Record<agentId, number | null> }
//   PUT  /api/myrmidon/companies/:companyId/wip-limit/settings (same body)
//   GET /api/myrmidon/companies/:companyId/wip-limit/status
//        -> [{ agentId, inProgress, inReview, wip, limit, overLimit }]
//
// Types live here (not in @paperclipai/shared) while part A is unmerged, so
// the UI does not touch server or shared files; once A lands, the types move
// to the shared contract and this module keeps only the calls.
import { api } from "@/api/client";

/** The stored settings row: the company default and per-agent overrides. */
export interface WipLimitSettings {
  /** Company-wide default of simultaneously active tasks per agent. `null` — no limit. */
  defaultLimit: number | null;
  /** Per-agent overrides. `null` — the agent uses `defaultLimit`. Absent — same as null. */
  perAgent: Record<string, number | null>;
}

/** One agent's live WIP from the status endpoint. */
export interface WipLimitStatusEntry {
  agentId: string;
  inProgress: number;
  inReview: number;
  /** inProgress + inReview — what the limit counts. */
  wip: number;
  /** The limit the agent is currently resolved against; `null` — no limit. */
  limit: number | null;
  overLimit: boolean;
}

export const wipLimitSettingsQueryKey = (companyId: string) =>
  ["myrmidon", "wip-limit", "settings", companyId] as const;

export const wipLimitStatusQueryKey = (companyId: string) =>
  ["myrmidon", "wip-limit", "status", companyId] as const;

const settingsPath = (companyId: string) =>
  `/myrmidon/companies/${encodeURIComponent(companyId)}/wip-limit/settings`;
const statusPath = (companyId: string) =>
  `/myrmidon/companies/${encodeURIComponent(companyId)}/wip-limit/status`;

export const wipLimitApi = {
  getSettings: (companyId: string) => api.get<WipLimitSettings>(settingsPath(companyId)),
  putSettings: (companyId: string, settings: WipLimitSettings) =>
    api.put<WipLimitSettings>(settingsPath(companyId), settings),
  getStatus: (companyId: string) => api.get<WipLimitStatusEntry[]>(statusPath(companyId)),
};