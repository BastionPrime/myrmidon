// myrmidon(MEMORY-UI): API client for the agent card's Memory tab.
// Server side: server/src/myrmidon/agent-memory/routes.ts.

import { api } from "@/api/client";

export interface MemoryCardStatus {
  enabled: boolean;
  bank: { bankId: string; source: "agent-card" | "plugin-config" } | null;
  reason: string | null;
}

export interface MemoryItemView {
  id: string;
  text: string;
  factType: string | null;
  state: string | null;
  occurredAt: string | null;
  createdAt: string | null;
  documentId: string | null;
  tags: string[];
}

export interface MemoryPageView {
  items: MemoryItemView[];
  total: number;
  limit: number;
  offset: number;
}

export interface MemoryExportView {
  items: MemoryItemView[];
  total: number;
  truncated: boolean;
}

export const memoryStatusKey = (agentId: string) => ["myrmidon", "agent-memory", agentId, "status"] as const;
export const memoriesKey = (agentId: string, offset: number, state: string | null) =>
  ["myrmidon", "agent-memory", agentId, "memories", offset, state] as const;

const base = (agentId: string) => `/myrmidon/agents/${encodeURIComponent(agentId)}/memory`;

export const memoryApi = {
  status: (agentId: string) => api.get<MemoryCardStatus>(`${base(agentId)}`),
  list: (agentId: string, opts: { limit?: number; offset?: number; state?: string } = {}) => {
    const params = new URLSearchParams();
    params.set("limit", String(opts.limit ?? 50));
    params.set("offset", String(opts.offset ?? 0));
    if (opts.state) params.set("state", opts.state);
    return api.get<MemoryPageView>(`${base(agentId)}/memories?${params.toString()}`);
  },
  remove: (agentId: string, memoryId: string, reason: string) =>
    api.delete<{ deleted: boolean }>(`${base(agentId)}/memories/${encodeURIComponent(memoryId)}`, { reason }),
  clear: (agentId: string) =>
    api.post<{ cleared: boolean; deletedCount: number | null }>(`${base(agentId)}/clear`, {}),
};

/** Download the export as a JSON file, browser-side (auth cookies ride fetch). */
export async function downloadMemoryExport(agentId: string): Promise<MemoryExportView> {
  const response = await fetch(`/api${base(agentId)}/export`, { credentials: "include" });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Request failed: ${response.status}`);
  }
  return (await response.json()) as MemoryExportView;
}

/** A short, readable date or an em dash. */
export function formatMemoryDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}
