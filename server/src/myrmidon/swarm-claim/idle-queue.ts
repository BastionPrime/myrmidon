// server/src/myrmidon/swarm-claim/idle-queue.ts
//
// myrmidon(1.6.1 SWARM-IDLE-WAKE): the DB half of the idle pass.
//
// One read per company answers both halves of the wake pair the ticket names:
// which roles have a non-empty ready queue, and which of their agents are free
// (no live claim, under the ceiling, not paused, no live run). The reads mirror
// `roleQueueRows`/`listRoleQueue` of part A so "ready" means the same thing on
// both paths, with the extra columns the idle pass needs (agents.id,
// agents.status, the live-run set of heartbeat_runs).

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { agents, companies, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { SWARM_CLAIM_QUEUE_ISSUE_STATUSES, type SwarmQueueCandidate } from "@paperclipai/shared";

/** The read-ready role pairs of one company: queue + its agents' idle state. */
export interface SwarmIdleRolePair {
  role: string;
  companyId: string;
  queue: SwarmQueueCandidate[];
  agents: {
    id: string;
    status: string | null;
    activeClaims: number;
    hasLiveRun: boolean;
  }[];
}

const LIVE_HEARTBEAT_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;

/**
 * Every role of a company that has at least one ready queue candidate and
 * every agent of that role, with its live-claim count. The per-agent ceiling
 * is NOT applied here (it can be caste-overridden per agent); the policy in
 * idle-wake.ts decides freeness.
 */
export async function listIdleRolePairs(
  db: Db,
  companyId: string,
): Promise<SwarmIdleRolePair[]> {
  const [queueRows, agentRows, liveRunAgentIds] = await Promise.all([
    listReadyQueueCandidates(db, companyId),
    db
      .select({
        id: agents.id,
        role: agents.role,
        status: agents.status,
      })
      .from(agents)
      .innerJoin(companies, eq(companies.id, agents.companyId))
      .where(and(eq(agents.companyId, companyId), eq(companies.status, "active"))),
    db
      .select({ agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          inArray(heartbeatRuns.status, [...LIVE_HEARTBEAT_RUN_STATUSES]),
        ),
      ),
  ] as const);

  const liveRuns = new Set(
    liveRunAgentIds.map((row: { agentId: string }) => row.agentId),
  );
  const rolesWithAgents = new Set(
    agentRows.map((agent) => agent.role).filter((role): role is string => Boolean(role)),
  );
  const byRole = new Map<string, SwarmQueueCandidate[]>();
  for (const row of queueRows) {
    const roles = rolesOfQueueRow(row, rolesWithAgents);
    for (const role of roles) {
      const list = byRole.get(role) ?? [];
      if (list.length < 200) list.push(row.candidate);
      byRole.set(role, list);
    }
  }

  const pairs: SwarmIdleRolePair[] = [];
  for (const [role, queue] of byRole) {
    if (queue.length === 0) continue;
    const roleAgents = agentRows
      .filter((agent) => agent.role === role)
      .map((agent) => ({
        id: agent.id,
        status: agent.status,
        activeClaims: 0,
        hasLiveRun: liveRuns.has(agent.id),
      }));
    // A role with no agents at all still reports the pair (the supervisor
    // metric counts it), but the policy wakes no one.
    pairs.push({ role, companyId, queue, agents: roleAgents });
  }
  return pairs;
}

/** The live (not released) claim counts per agent of one company. */
export async function liveClaimCountsByAgent(
  db: Db,
  companyId: string,
): Promise<Map<string, number>> {
  const { issueClaims } = await import("@paperclipai/db");
  const rows = await db
    .select({ agentId: issueClaims.agentId })
    .from(issueClaims)
    .where(and(eq(issueClaims.companyId, companyId), isNull(issueClaims.releasedAt)));
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.agentId, (counts.get(row.agentId) ?? 0) + 1);
  }
  return counts;
}

/** One raw ready queue row with the roles it belongs to. */
interface ReadyQueueRow {
  candidate: SwarmQueueCandidate;
  assigneeAgentId: string | null;
  assigneeRole: string | null;
}

/** The ready queue of a company (both assigned-to-role and unassigned rows). */
async function listReadyQueueCandidates(db: Db, companyId: string) {
  const rows = await db
    .select({
      issueId: issues.id,
      identifier: issues.identifier,
      priority: issues.priority,
      queuedAt: issues.createdAt,
      assigneeAgentId: issues.assigneeAgentId,
      assigneeRole: agents.role,
    })
    .from(issues)
    .leftJoin(agents, eq(agents.id, issues.assigneeAgentId))
    .where(
      and(
        eq(issues.companyId, companyId),
        isNull(issues.assigneeUserId),
        isNull(issues.hiddenAt),
        isNull(issues.conversationAgentId),
        inArray(issues.status, [...SWARM_CLAIM_QUEUE_ISSUE_STATUSES]),
        // The readiness filters of idle-pickup: no open blocker, not a plan
        // container, not mid-decomposition. Ready means one thing everywhere.
        sql`not exists (
          select 1
          from issue_relations ir
            join issues blocker on blocker.id = ir.issue_id and blocker.company_id = ${issues.companyId}
          where ir.company_id = ${issues.companyId}
            and ir.related_issue_id = ${issues.id}
            and ir.type = 'blocks'
            and blocker.status <> 'done'
        )`,
        sql`not exists (
          select 1
          from issues child
          where child.company_id = ${issues.companyId}
            and child.parent_id = ${issues.id}
            and child.status not in ('done', 'cancelled')
        )`,
        sql`not exists (
          select 1
          from issue_plan_decompositions decomp
          where decomp.company_id = ${issues.companyId}
            and decomp.source_issue_id = ${issues.id}
            and decomp.status = 'in_flight'
        )`,
      ),
    )
    .orderBy(asc(issues.createdAt))
    .limit(500);
  return rows.map((row): ReadyQueueRow => ({
    candidate: {
      issueId: row.issueId,
      identifier: row.identifier,
      priority: row.priority,
      queuedAt: row.queuedAt,
    },
    assigneeAgentId: row.assigneeAgentId,
    assigneeRole: row.assigneeRole ?? null,
  }));
}

/**
 * Which role queues a ready row belongs to. An assigned task queues for the
 * assignee's role only; an unassigned task is offered to every role that has
 * agents (the roles the company actually runs, minus no-caste agents).
 */
function rolesOfQueueRow(row: ReadyQueueRow, knownRoles?: Set<string>): string[] {
  if (row.assigneeAgentId) {
    return row.assigneeRole ? [row.assigneeRole] : [];
  }
  if (!knownRoles) return [];
  return [...knownRoles];
}

export { rolesOfQueueRow };
