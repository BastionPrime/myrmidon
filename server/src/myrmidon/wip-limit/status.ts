// server/src/myrmidon/wip-limit/status.ts
//
// myrmidon(1.6.1-WIP-LIMIT-A): the live per-agent WIP picture.
//
// One read joins every agent of the company with the counts of its in-flight
// tasks (`in_progress` + `in_review`, visible rows only). The lead rule runs
// over the same row set: an agent someone reports to is a lead, and a lead
// holding implementation work is over the limit by definition (the lead's
// implementation limit is 0). Everything is computed on the fly — no new
// tables, the same shape the stack registry and the budget signal use.

import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issues } from "@paperclipai/db";
import {
  buildWipLimitAgentStatus,
  isWipLimitLead,
  resolveWipLimitForAgent,
  type WipLimitAgentStatus,
  type WipLimitSettings,
} from "@paperclipai/shared";

/** In-flight statuses the count reads. */
export const WIP_LIMIT_COUNTED_STATUSES = ["in_progress", "in_review"] as const;

/** One agent's in-flight counts. */
export interface WipCounts {
  inProgress: number;
  inReview: number;
}

/** Count in-flight tasks per assignee agent (visible rows only). */
export async function countAgentWip(db: Db, companyId: string): Promise<Map<string, WipCounts>> {
  const rows = await db
    .select({
      agentId: issues.assigneeAgentId,
      status: issues.status,
      count: sql<number>`count(*)::int`,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        isNull(issues.hiddenAt),
        sql`${issues.status} in ('in_progress', 'in_review')`,
        sql`${issues.assigneeAgentId} is not null`,
      ),
    )
    .groupBy(issues.assigneeAgentId, issues.status);

  const counts = new Map<string, WipCounts>();
  for (const row of rows) {
    const agentId = row.agentId;
    if (!agentId) continue;
    const current = counts.get(agentId) ?? { inProgress: 0, inReview: 0 };
    if (row.status === "in_progress") current.inProgress += row.count;
    if (row.status === "in_review") current.inReview += row.count;
    counts.set(agentId, current);
  }
  return counts;
}

/** Every agent of the company with its reportsTo, for the lead rule. */
export async function loadCompanyAgents(
  db: Db,
  companyId: string,
): Promise<Array<{ id: string; reportsTo: string | null }>> {
  return db
    .select({ id: agents.id, reportsTo: agents.reportsTo })
    .from(agents)
    .where(eq(agents.companyId, companyId));
}

/** The status rows of every agent of the company, in stable id order. */
export async function buildWipLimitStatus(
  db: Db,
  companyId: string,
  settings: WipLimitSettings,
): Promise<WipLimitAgentStatus[]> {
  const [agentRows, counts] = await Promise.all([
    loadCompanyAgents(db, companyId),
    countAgentWip(db, companyId),
  ]);
  const reportsById = new Map(agentRows.map((row) => [row.id, row.reportsTo] as const));
  return agentRows
    .map((row) => {
      const count = counts.get(row.id) ?? { inProgress: 0, inReview: 0 };
      return buildWipLimitAgentStatus({
        agentId: row.id,
        inProgress: count.inProgress,
        inReview: count.inReview,
        limit: resolveWipLimitForAgent(settings, row.id),
        isLead: isWipLimitLead(row.id, reportsById),
      });
    })
    .sort((left, right) => left.agentId.localeCompare(right.agentId));
}
