// myrmidon(1.6.1 CUSTOM-CASTES C): API client for the company caste
// directory ("Agent castes" settings screen). Speaks the Part A contract
// against /api/myrmidon/companies/:id/castes:
//   GET    /castes        (list; first read seeds the 12 built-in rows)
//   POST   /castes        (create; 409 when the key already exists)
//   PATCH  /castes/:key   (edit everything except key; builtIn stays)
//   DELETE /castes/:key   (409 while agents with this role exist; else 204)
// The screen is written against this contract while the server part merges;
// CasteView mirrors the fixed shared contract (key, names, description,
// color, icon, default model, swarm eligibility, task limit, builtIn flag).
import { api } from "@/api/client";

export interface CasteView {
  /** Stable identifier; matches `agents.role`. Latin letters and hyphen, 1–60. */
  key: string;
  nameEn: string;
  nameRu: string;
  description: string;
  /** A value from the token layer (see CASTE_COLORS below). */
  color: string;
  /** A name from the curated agent icon set. */
  icon: string;
  defaultModel: string | null;
  swarmEligible: boolean;
  /** null = the global swarm limit applies. */
  maxActiveTasks: number | null;
  builtIn: boolean;
  createdAt: string;
  updatedAt: string;
}

/** POST body — the key is part of creation only and never changes after. */
export interface AddCasteInput {
  key: string;
  nameEn: string;
  nameRu: string;
  description: string;
  color: string;
  icon: string;
  defaultModel: string | null;
  swarmEligible: boolean;
  maxActiveTasks: number | null;
}

/** PATCH body — every mutable field is optional; `key`/`builtIn` are not. */
export interface UpdateCasteInput {
  nameEn?: string;
  nameRu?: string;
  description?: string;
  color?: string;
  icon?: string;
  defaultModel?: string | null;
  swarmEligible?: boolean;
  maxActiveTasks?: number | null;
}

const base = (companyId: string) =>
  `/myrmidon/companies/${encodeURIComponent(companyId)}/castes`;

export const castesQueryKey = (companyId: string) =>
  ["myrmidon", "castes", companyId] as const;

export const castesApi = {
  /** GET /castes → { castes } (the directory; the first read seeds it). */
  view: (companyId: string) => api.get<{ castes: CasteView[] }>(`${base(companyId)}`),

  /** POST /castes — 409 when the key already exists in the directory. */
  add: (companyId: string, input: AddCasteInput) =>
    api.post<{ caste: CasteView }>(`${base(companyId)}`, input),

  /** PATCH /castes/:key — everything except key; builtIn cannot be turned off. */
  update: (companyId: string, key: string, input: UpdateCasteInput) =>
    api.patch<{ caste: CasteView }>(`${base(companyId)}/${encodeURIComponent(key)}`, input),

  /** DELETE /castes/:key — 409 while live agents hold the role; else 204. */
  remove: (companyId: string, key: string) =>
    api.delete<{ ok: true }>(`${base(companyId)}/${encodeURIComponent(key)}`),
};
