// myrmidon(BROWSER-CONSOLE): API client for the Settings → Browsers section.
// Server side: server/src/myrmidon/browser-console/routes.ts.

import { api } from "@/api/client";
import type {
  BrowserConsoleStatus,
  BrowserScreenOpenResponse,
  BrowserScreenStatusResponse,
  BrowserSessionJournalEntry,
} from "@paperclipai/shared/myrmidon-browser-console";

export const browsersQueryKey = ["myrmidon", "browsers"] as const;
export const browsersJournalQueryKey = ["myrmidon", "browsers", "journal"] as const;

export const browsersApi = {
  list: () => api.get<{ browsers: BrowserConsoleStatus[] }>("/myrmidon/browsers"),
  journal: () => api.get<{ entries: BrowserSessionJournalEntry[] }>("/myrmidon/browsers/journal"),
  openScreen: (browserId: string, companyId: string) =>
    api.post<BrowserScreenOpenResponse>(`/myrmidon/browsers/${encodeURIComponent(browserId)}/screen/open?companyId=${encodeURIComponent(companyId)}`, {}),
  heartbeat: (browserId: string, companyId: string, activity: boolean) =>
    api.post<BrowserScreenStatusResponse & { active: boolean }>(
      `/myrmidon/browsers/${encodeURIComponent(browserId)}/screen/heartbeat?companyId=${encodeURIComponent(companyId)}`,
      { activity },
    ),
  done: (browserId: string, companyId: string) =>
    api.post<{ done: boolean }>(`/myrmidon/browsers/${encodeURIComponent(browserId)}/screen/done?companyId=${encodeURIComponent(companyId)}`, {}),
  clearSiteData: (browserId: string, companyId: string, domain: string) =>
    api.delete<{ cleared: boolean; domain: string }>(
      `/myrmidon/browsers/${encodeURIComponent(browserId)}/data?companyId=${encodeURIComponent(companyId)}`,
      { domain },
    ),
};

export function egressSummary(egress: Record<string, string>): string {
  const entries = Object.entries(egress);
  if (entries.length === 0) return "—";
  return entries.map(([key, value]) => `${key}: ${value}`).join(", ");
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  }
  return `${minutes}m ${seconds}s`;
}
