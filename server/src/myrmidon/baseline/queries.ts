// server/src/myrmidon/baseline/queries.ts
//
// myrmidon(1.6-BASELINE): the read side. Each function loads one slice of the
// board history for a company and a window; the metric math lives in
// metrics.ts. Every query is company-scoped.

import { and, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  costEvents,
  heartbeatRuns,
  issueRelations,
  issues,
  litellmCostEvents,
  type Db,
} from "@paperclipai/db";
import type {
  BaselineAgentRoleRow,
  BaselineBlockerRow,
  BaselineCostRow,
  BaselineRunRow,
  BaselineTaskRow,
  BaselineTransitionRow,
  BaselineWindow,
} from "./metrics.js";

export type BaselineCostSource = "litellm_cost_events" | "cost_events" | "none";

/** Tasks whose completedAt falls inside the window. */
export async function loadCompletedTasks(
  db: Db,
  companyId: string,
  window: BaselineWindow,
): Promise<BaselineTaskRow[]> {
  const rows = await db
    .select({
      id: issues.id,
      projectId: issues.projectId,
      assigneeAgentId: issues.assigneeAgentId,
      createdAt: issues.createdAt,
      completedAt: issues.completedAt,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        isNotNull(issues.completedAt),
        gte(issues.completedAt, window.from),
        lte(issues.completedAt, window.to),
      ),
    );

  return rows.flatMap((row) =>
    row.completedAt
      ? [
          {
            id: row.id,
            projectId: row.projectId,
            assigneeAgentId: row.assigneeAgentId,
            createdAt: row.createdAt,
            completedAt: row.completedAt,
          },
        ]
      : [],
  );
}

/** Status transitions (activity_log issue.updated rows) for the given tasks. */
export async function loadTransitions(
  db: Db,
  companyId: string,
  issueIds: string[],
): Promise<BaselineTransitionRow[]> {
  if (issueIds.length === 0) return [];
  const rows = await db
    .select({
      issueId: activityLog.entityId,
      at: activityLog.createdAt,
      from: sql<string | null>`${activityLog.details} -> '_previous' ->> 'status'`,
      to: sql<string | null>`${activityLog.details} ->> 'status'`,
    })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.entityType, "issue"),
        eq(activityLog.action, "issue.updated"),
        inArray(activityLog.entityId, issueIds),
        sql`${activityLog.details} ->> 'status' is not null`,
      ),
    )
    .orderBy(activityLog.createdAt);

  return rows.flatMap((row) =>
    row.to ? [{ issueId: row.issueId, at: row.at, from: row.from, to: row.to }] : [],
  );
}

/** Heartbeat runs attributed to the given tasks (contextSnapshot.issueId). */
export async function loadRuns(
  db: Db,
  companyId: string,
  issueIds: string[],
  window: BaselineWindow,
): Promise<BaselineRunRow[]> {
  if (issueIds.length === 0) return [];
  const rows = await db
    .select({
      issueId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`,
      at: heartbeatRuns.startedAt,
    })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        isNotNull(heartbeatRuns.startedAt),
        gte(heartbeatRuns.startedAt, window.from),
        lte(heartbeatRuns.startedAt, window.to),
        inArray(sql`(${heartbeatRuns.contextSnapshot} ->> 'issueId')`, issueIds),
      ),
    );

  return rows.flatMap((row) =>
    row.issueId && row.at ? [{ issueId: row.issueId, at: row.at }] : [],
  );
}

/**
 * Which cost ledger the instance can answer from. The gateway-collected
 * litellm_cost_events wins when the window has rows there; otherwise the
 * vendor cost_events is used; otherwise the answer is `none` and every
 * costPerTask stays zero.
 */
export async function detectCostSource(
  db: Db,
  companyId: string,
  window: BaselineWindow,
): Promise<BaselineCostSource> {
  const gateway = await db
    .select({ id: litellmCostEvents.id })
    .from(litellmCostEvents)
    .where(
      and(
        eq(litellmCostEvents.companyId, companyId),
        gte(litellmCostEvents.occurredAt, window.from),
        lte(litellmCostEvents.occurredAt, window.to),
      ),
    )
    .limit(1);
  if (gateway.length > 0) return "litellm_cost_events";

  const vendor = await db
    .select({ id: costEvents.id })
    .from(costEvents)
    .where(
      and(
        eq(costEvents.companyId, companyId),
        gte(costEvents.occurredAt, window.from),
        lte(costEvents.occurredAt, window.to),
      ),
    )
    .limit(1);
  if (vendor.length > 0) return "cost_events";

  return "none";
}

/** Cost rows of one ledger for the given tasks inside the window. */
export async function loadCosts(
  db: Db,
  companyId: string,
  issueIds: string[],
  window: BaselineWindow,
  source: BaselineCostSource,
): Promise<BaselineCostRow[]> {
  if (source === "none" || issueIds.length === 0) return [];

  if (source === "litellm_cost_events") {
    const rows = await db
      .select({
        issueId: litellmCostEvents.issueId,
        cents: litellmCostEvents.costCents,
        at: litellmCostEvents.occurredAt,
      })
      .from(litellmCostEvents)
      .where(
        and(
          eq(litellmCostEvents.companyId, companyId),
          inArray(litellmCostEvents.issueId, issueIds),
          gte(litellmCostEvents.occurredAt, window.from),
          lte(litellmCostEvents.occurredAt, window.to),
        ),
      );
    return rows.flatMap((row) =>
      row.issueId ? [{ issueId: row.issueId, cents: row.cents, at: row.at }] : [],
    );
  }

  const rows = await db
    .select({
      issueId: costEvents.issueId,
      cents: costEvents.costCents,
      at: costEvents.occurredAt,
    })
    .from(costEvents)
    .where(
      and(
        eq(costEvents.companyId, companyId),
        inArray(costEvents.issueId, issueIds),
        gte(costEvents.occurredAt, window.from),
        lte(costEvents.occurredAt, window.to),
      ),
    );
  return rows.flatMap((row) =>
    row.issueId ? [{ issueId: row.issueId, cents: row.cents, at: row.at }] : [],
  );
}

/** Current blocker relations (issue_relations type=blocks) of the given tasks. */
export async function loadBlockers(
  db: Db,
  companyId: string,
  issueIds: string[],
): Promise<BaselineBlockerRow[]> {
  if (issueIds.length === 0) return [];
  return db
    .select({
      issueId: issueRelations.relatedIssueId,
      blockerIssueId: issueRelations.issueId,
    })
    .from(issueRelations)
    .where(
      and(
        eq(issueRelations.companyId, companyId),
        eq(issueRelations.type, "blocks"),
        inArray(issueRelations.relatedIssueId, issueIds),
      ),
    );
}

/** Roles of the assignees of the given tasks. */
export async function loadRoles(
  db: Db,
  companyId: string,
  agentIds: string[],
): Promise<BaselineAgentRoleRow[]> {
  if (agentIds.length === 0) return [];
  return db
    .select({ agentId: agents.id, role: agents.role })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds)));
}