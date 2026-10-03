// myrmidon(1.6.1 MODEL-PROVIDERS C): API client for the "Model providers"
// settings screen. Speaks the Part A contract (branch
// myr/1.6.1-model-providers-store) against
// /api/myrmidon/companies/:id/model-providers:
//   POST   /providers            (add; key write-only, never returned)
//   GET    /providers            (list without the key, hasKey flag)
//   PATCH  /providers/:pid       (rotate key)
//   DELETE /providers/:pid
//   GET    /providers/:pid/models (cached model list from validation)
//   POST   /providers/:pid/models (enable/disable models)
// The screen is written against this contract while Part A merges; the
// response types carry only key-free fields.
import { api } from "@/api/client";

export const MODEL_PROVIDER_TYPES = [
  "dashscope",
  "openai",
  "google",
  "openai-compatible",
] as const;

export type ModelProviderType = (typeof MODEL_PROVIDER_TYPES)[number];

export interface ModelProviderView {
  id: string;
  type: ModelProviderType;
  name: string;
  baseUrl: string | null;
  /** The key is write-only: the API answers only whether one is stored. */
  hasKey: boolean;
  free: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ModelProviderModelView {
  modelName: string;
  litellmModelName: string;
  enabled: boolean;
  free: boolean;
}

export interface ModelProviderModelsView {
  providerId: string;
  models: ModelProviderModelView[];
}

export interface ModelProviderChangeLogEntry {
  id: string;
  at: string;
  actor: { type: "board" | "agent" | "system"; id: string };
  action: "provider_added" | "provider_rotated" | "provider_removed" | "models_updated";
  summary: string;
}

export interface ModelProvidersView {
  providers: ModelProviderView[];
  changeLog: ModelProviderChangeLogEntry[];
}

/** POST body — carries the raw key once, only on the wire to the server. */
export interface AddModelProviderInput {
  type: ModelProviderType;
  name: string;
  baseUrl: string | null;
  key: string;
  free: boolean;
}

export interface RotateModelProviderInput {
  key: string;
}

export interface UpdateModelsInput {
  /** Full desired state: the models to keep enabled, each with its free flag. */
  models: Array<{ modelName: string; litellmModelName: string; enabled: boolean; free: boolean }>;
}

const base = (companyId: string) =>
  `/myrmidon/companies/${encodeURIComponent(companyId)}/model-providers`;

export const modelProvidersQueryKey = (companyId: string) =>
  ["myrmidon", "model-providers", companyId] as const;

export const modelProviderModelsQueryKey = (companyId: string, providerId: string) =>
  ["myrmidon", "model-providers", companyId, "models", providerId] as const;

export const modelProvidersApi = {
  /** GET /providers → { providers, changeLog } (no key values ever). */
  view: (companyId: string) => api.get<ModelProvidersView>(`${base(companyId)}/providers`),

  /** POST /providers — validates the key and returns the provider with its
   * discovered models; the key itself is not part of any response. */
  add: (companyId: string, input: AddModelProviderInput) =>
    api.post<{ provider: ModelProviderView; models: ModelProviderModelView[] }>(
      `${base(companyId)}/providers`,
      input,
    ),

  /** PATCH /providers/:pid — rotate the stored key. */
  rotate: (companyId: string, providerId: string, input: RotateModelProviderInput) =>
    api.patch<{ provider: ModelProviderView; models: ModelProviderModelView[] }>(
      `${base(companyId)}/providers/${encodeURIComponent(providerId)}`,
      input,
    ),

  /** DELETE /providers/:pid — remove the provider and its models. */
  remove: (companyId: string, providerId: string) =>
    api.delete<{ ok: true }>(`${base(companyId)}/providers/${encodeURIComponent(providerId)}`),

  /** GET /providers/:pid/models — the cached model list. */
  models: (companyId: string, providerId: string) =>
    api.get<ModelProviderModelsView>(
      `${base(companyId)}/providers/${encodeURIComponent(providerId)}/models`,
    ),

  /** POST /providers/:pid/models — enable/disable models. */
  updateModels: (companyId: string, providerId: string, input: UpdateModelsInput) =>
    api.post<{ models: ModelProviderModelView[] }>(
      `${base(companyId)}/providers/${encodeURIComponent(providerId)}/models`,
      input,
    ),
};

/**
 * The owner's rule: free models first, and among the free ones the free
 * DashScope models come before everything else. Stable alphabetical order
 * inside each group so the list never reorders on re-render.
 */
export function sortModels(models: ModelProviderModelView[]): ModelProviderModelView[] {
  return [...models].sort((a, b) => {
    const aFree = a.free ? 0 : 1;
    const bFree = b.free ? 0 : 1;
    if (aFree !== bFree) return aFree - bFree;
    if (aFree === 0) {
      // Both free: DashScope free models are the owner's first pick. The
      // provider type is not on the model row, so the rule keys on the
      // model-name prefix the LiteLLM names carry ("dashscope/…").
      const aDash = a.litellmModelName.startsWith("dashscope/") ? 0 : 1;
      const bDash = b.litellmModelName.startsWith("dashscope/") ? 0 : 1;
      if (aDash !== bDash) return aDash - bDash;
    }
    return a.modelName.localeCompare(b.modelName);
  });
}
