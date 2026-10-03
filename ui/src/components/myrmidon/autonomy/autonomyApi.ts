// myrmidon(1.6 AUTONOMY-MATRIX B): API client for the "Autonomy matrix"
// settings screen. Part A landed in main (packages/shared/src/myrmidon-autonomy.ts,
// server/src/myrmidon/autonomy): this client speaks the landed REST contract —
// GET /api/myrmidon/autonomy (snapshot), PATCH /api/myrmidon/autonomy/matrix,
// POST/PATCH/DELETE regulation verbs — with `companyId` following the
// access-hub query-param pattern. Types import from @paperclipai/shared.
import { api } from "@/api/client";
import type {
  AutonomyMatrix,
  AutonomyMatrixPatch,
  AutonomyRegulation,
  AutonomySnapshot,
} from "@paperclipai/shared";

export type AutonomyView = AutonomySnapshot;

export const autonomyQueryKey = (companyId: string) =>
  ["myrmidon", "autonomy", companyId] as const;

const qs = (companyId: string) =>
  `?companyId=${encodeURIComponent(companyId)}`;

export const autonomyApi = {
  /** GET /api/myrmidon/autonomy → { matrix, regulations, changeLog } */
  view: (companyId: string) =>
    api.get<AutonomyView>(`/myrmidon/autonomy${qs(companyId)}`),

  /** Full-matrix replace; expectedVersion mismatch → 409. */
  updateMatrix: (companyId: string, patch: AutonomyMatrixPatch) =>
    api.patch<{ matrix: AutonomyMatrix }>(
      `/myrmidon/autonomy/matrix${qs(companyId)}`,
      patch,
    ),

  /** Create a draft regulation (revision 1). */
  createRegulation: (
    companyId: string,
    input: { role: string; title: string; bodyMarkdown: string },
  ) =>
    api.post<{ regulation: AutonomyRegulation }>(
      `/myrmidon/autonomy/regulations${qs(companyId)}`,
      input,
    ),

  /** Draft edit — server appends a revision. */
  updateRegulation: (
    companyId: string,
    id: string,
    input: { title?: string; bodyMarkdown?: string },
  ) =>
    api.patch<{ regulation: AutonomyRegulation }>(
      `/myrmidon/autonomy/regulations/${encodeURIComponent(id)}${qs(companyId)}`,
      input,
    ),

  /** draft → approved (board actor, direct action). */
  approveRegulation: (companyId: string, id: string) =>
    api.post<{ regulation: AutonomyRegulation }>(
      `/myrmidon/autonomy/regulations/${encodeURIComponent(id)}/approve${qs(companyId)}`,
      {},
    ),

  /** Re-promote a prior revision. */
  restoreRegulationRevision: (companyId: string, id: string, revision: number) =>
    api.post<{ regulation: AutonomyRegulation }>(
      `/myrmidon/autonomy/regulations/${encodeURIComponent(id)}/revisions/${revision}/restore${qs(companyId)}`,
      {},
    ),
};

/** 409 from the matrix PATCH means the matrix version moved underneath us. */
export function isVersionConflict(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    (err as { status?: unknown }).status === 409
  );
}
