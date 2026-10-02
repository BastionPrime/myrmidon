// myrmidon(M2-B): per-agent LLM gateway keys and the gateway's fallback
// topology. GET/POST /api/myrmidon/companies/:id/litellm/keys/*.
import { api } from "@/api/client";

export interface AgentGatewayKeyView {
  agentId: string;
  secretName: string;
  present: boolean;
  /** sha256 of the key value — the only form the value is ever reported in. */
  valueHash: string | null;
  canManageKeys: boolean;
}

export interface GatewayFallbackCycle {
  path: string[];
  described: string;
}

export interface GatewayFallbackReport {
  chains: Array<{ model: string; targets: string[] }>;
  cycles: GatewayFallbackCycle[];
  error?: string;
}

/** 503 body while the instance switch is off: the tab says "not enabled". */
export function isKeysNotEnabledError(err: unknown): boolean {
  return err instanceof Error && /not enabled/i.test(err.message);
}

const base = (companyId: string) => `/myrmidon/companies/${encodeURIComponent(companyId)}/litellm`;

export const litellmKeysApi = {
  keys: (companyId: string) => api.get<AgentGatewayKeyView[]>(`${base(companyId)}/keys`),
  fallbacks: (companyId: string) => api.get<GatewayFallbackReport>(`${base(companyId)}/fallbacks`),
  create: (companyId: string, agentId: string) =>
    api.post<AgentGatewayKeyView & { value: string }>(
      `${base(companyId)}/keys/${encodeURIComponent(agentId)}`,
      {},
    ),
  rotate: (companyId: string, agentId: string) =>
    api.post<AgentGatewayKeyView>(`${base(companyId)}/keys/${encodeURIComponent(agentId)}/rotate`, {}),
};

export const litellmKeysKey = (companyId: string) =>
  ["myrmidon", "litellm", "keys", companyId] as const;
export const litellmFallbacksKey = (companyId: string) =>
  ["myrmidon", "litellm", "fallbacks", companyId] as const;

/** How many agents of a company already have a key of their own. */
export function countKeyedAgents(keys: AgentGatewayKeyView[]): { keyed: number; total: number } {
  return { keyed: keys.filter((entry) => entry.present).length, total: keys.length };
}