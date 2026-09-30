// myrmidon(M2-A): LLM gateway (LiteLLM) costs and model catalog, collected by
// the server-side sweep. GET /api/myrmidon/companies/:id/litellm/{costs,models}.
import { api } from "@/api/client";

export interface LitellmCostRow {
  agentId: string;
  issueId: string | null;
  heartbeatRunId: string | null;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  occurredAt: string;
}

export interface LitellmModelView {
  modelName: string;
  provider: string | null;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  inputCostPerToken: number | null;
  outputCostPerToken: number | null;
  cacheReadInputTokenCost: number | null;
  cacheCreationInputTokenCost: number | null;
  seenAt: string;
}

/** 503 body while the instance switch is off: the UI shows "not enabled". */
export function isNotEnabledError(err: unknown): boolean {
  return err instanceof Error && /not enabled/i.test(err.message);
}

function rangeParams(from?: string, to?: string): string {
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

const base = (companyId: string) => `/myrmidon/companies/${encodeURIComponent(companyId)}/litellm`;

export const litellmCostsApi = {
  costs: (companyId: string, from?: string, to?: string) =>
    api.get<LitellmCostRow[]>(`${base(companyId)}/costs${rangeParams(from, to)}`),
  models: (companyId: string) => api.get<LitellmModelView[]>(`${base(companyId)}/models`),
};

/** USD per token -> "$0.0000011" style, or "-" when the gateway gave no price. */
export function formatPerToken(rate: number | null): string {
  if (rate == null) return "-";
  const usd = rate;
  if (usd === 0) return "$0";
  return `$${usd.toPrecision(3)}`;
}

/** Price per 1M tokens, the form operators compare models in. */
export function formatPerMillion(rate: number | null): string {
  if (rate == null) return "-";
  const perM = rate * 1_000_000;
  if (perM === 0) return "$0";
  return `$${perM < 0.1 ? perM.toPrecision(3) : perM.toFixed(2)}`;
}

export const litellmCostsKey = (companyId: string, from?: string, to?: string) =>
  ["myrmidon", "litellm", "costs", companyId, from ?? null, to ?? null] as const;
export const litellmModelsKey = (companyId: string) => ["myrmidon", "litellm", "models", companyId] as const;
