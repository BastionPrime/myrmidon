// myrmidon(1.6-CTO-CHAT-A): UI API client for the Commander chat planning
// endpoint. The endpoint itself (POST /api/myrmidon/cto-chat/plan) is owned by
// Part B; this client only mirrors the agreed response contract (see the seam
// note in the ticket thread): { planId, epic, tasks } with acceptanceCriteria
// as a separate array and parentClientKey linking children to the epic's
// clientKey. Kept in one file so a contract change on the server side lands
// in one edit here.
import { api } from "./client";

export interface CtoChatPlanTask {
  clientKey: string;
  parentClientKey: string | null;
  title: string;
  description: string | null;
  acceptanceCriteria: string[];
  priority?: string | null;
}

export interface CtoChatPlan {
  planId: string;
  epic: { title: string; description: string | null };
  tasks: CtoChatPlanTask[];
}

export interface CtoChatPlanRequest {
  text: string;
  source: { kind: "portal" | "telegram" };
}

export const ctoChatApi = {
  createPlan: (companyId: string, data: CtoChatPlanRequest) =>
    api.post<CtoChatPlan>(`/myrmidon/companies/${companyId}/cto-chat/plan`, data),
};
