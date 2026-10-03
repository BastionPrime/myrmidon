// myrmidon(1.6-SKILL-LIFE): API client for the company skill lifecycle.
//
// Server side: /api/myrmidon/companies/:companyId/skill-lifecycle (list, state,
// history, promote-request, promote, deprecate, rollback, candidate).

import { api } from "@/api/client";

export type SkillLifecycleState = "candidate" | "verified" | "deprecated";

export interface SkillLifecycleView {
  skillId: string;
  key: string;
  name: string;
  slug: string;
  state: SkillLifecycleState;
  /** No lifecycle row yet: legacy delivery, shown as verified. */
  implicit: boolean;
  currentVersionId: string | null;
  verifiedVersionId: string | null;
  previousVerifiedVersionId: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  reason: string | null;
  updatedAt: string | null;
  verifiedRevisionNumber: number | null;
}

export interface SkillLifecycleEvent {
  id: string;
  skillId: string;
  fromState: SkillLifecycleState | null;
  toState: SkillLifecycleState;
  versionId: string | null;
  actorType: "agent" | "user" | "system";
  actorId: string | null;
  approvalId: string | null;
  reason: string | null;
  createdAt: string;
}

export const skillLifecycleQueryKey = (companyId: string) => ["myrmidon", "skill-lifecycle", companyId] as const;
export const skillLifecycleHistoryQueryKey = (companyId: string, skillId: string) =>
  ["myrmidon", "skill-lifecycle", companyId, skillId, "history"] as const;

export const skillLifecycleApi = {
  list: (companyId: string) =>
    api.get<{ skills: SkillLifecycleView[] }>(`/myrmidon/companies/${companyId}/skill-lifecycle`),
  history: (companyId: string, skillId: string) =>
    api.get<{ events: SkillLifecycleEvent[] }>(
      `/myrmidon/companies/${companyId}/skill-lifecycle/${skillId}/history`,
    ),
  requestPromotion: (companyId: string, skillId: string, note?: string) =>
    api.post<{ approvalId: string }>(`/myrmidon/companies/${companyId}/skill-lifecycle/${skillId}/promote-request`, {
      note: note ?? null,
    }),
  promote: (companyId: string, skillId: string, approvalId: string) =>
    api.post<SkillLifecycleView>(`/myrmidon/companies/${companyId}/skill-lifecycle/${skillId}/promote`, {
      approvalId,
    }),
  deprecate: (companyId: string, skillId: string, reason: string | null) =>
    api.post<SkillLifecycleView>(`/myrmidon/companies/${companyId}/skill-lifecycle/${skillId}/deprecate`, { reason }),
  rollback: (companyId: string, skillId: string) =>
    api.post<SkillLifecycleView>(`/myrmidon/companies/${companyId}/skill-lifecycle/${skillId}/rollback`, {}),
  setCandidate: (companyId: string, skillId: string) =>
    api.post<SkillLifecycleView>(`/myrmidon/companies/${companyId}/skill-lifecycle/${skillId}/candidate`, {}),
};

/** Badge label + color class for a state (Tailwind palette names, no raw values). */
export function stateBadge(state: SkillLifecycleState, implicit: boolean): { label: string; className: string } {
  if (implicit) return { label: "verified (unmanaged)", className: "border-border bg-muted text-muted-foreground" };
  switch (state) {
    case "verified":
      return { label: "verified", className: "border-transparent bg-emerald-500/15 text-emerald-600" };
    case "candidate":
      return { label: "candidate", className: "border-transparent bg-amber-500/15 text-amber-600" };
    default:
      return { label: "deprecated", className: "border-transparent bg-destructive/15 text-destructive" };
  }
}

/** "revision 3" or a dash when the skill has none yet. */
export function revisionLabel(revisionNumber: number | null): string {
  return revisionNumber === null ? "—" : `revision ${revisionNumber}`;
}

/** Who approved, with the time; the panel shows this next to the state. */
export function approverLabel(view: SkillLifecycleView): string {
  if (!view.approvedBy) return view.implicit ? "no approval needed (unmanaged)" : "not approved";
  const when = view.approvedAt ? new Date(view.approvedAt).toLocaleString() : "unknown time";
  return `${view.approvedBy} · ${when}`;
}

/** One history line, human readable. */
export function historyLine(event: SkillLifecycleEvent): string {
  const from = event.fromState ?? "new";
  const actor = event.actorId ?? event.actorType;
  const reason = event.reason ? ` — ${event.reason}` : "";
  return `${from} → ${event.toState} · ${actor} · ${new Date(event.createdAt).toLocaleString()}${reason}`;
}