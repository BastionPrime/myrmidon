import { and, eq, isNull, sql } from "drizzle-orm";
import { issueThreadInteractions, issues, type Db } from "@paperclipai/db";

/**
 * Skip idle timer heartbeats (M3, part 1).
 *
 * A generic timer heartbeat (no issue, comment or task in its context) of an
 * agent that has nothing to do still starts a model run and burns tokens. The
 * vendor can skip such wakes per agent (`runtimeConfig.heartbeat
 * .skipTimerWhenNoActionableWork`), counting only assigned todo/in_progress
 * issues as work. MYRMIDON_SKIP_IDLE_HEARTBEATS turns the skip on for every
 * agent, and the checks below add the work the vendor check does not see.
 * Wakes with a concrete reason never reach this check.
 */

export const SKIP_IDLE_HEARTBEATS_ENV = "MYRMIDON_SKIP_IDLE_HEARTBEATS";

export function skipIdleHeartbeatsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[SKIP_IDLE_HEARTBEATS_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * Work beyond assigned todo/in_progress issues: a pending interaction addressed
 * to the agent, or an in_review issue whose current review participant is the agent.
 */
export async function hasOtherActionableWork(
  db: Db,
  agent: { id: string; companyId: string },
): Promise<boolean> {
  const [interaction] = await db
    .select({ id: issueThreadInteractions.id })
    .from(issueThreadInteractions)
    .where(
      and(
        eq(issueThreadInteractions.companyId, agent.companyId),
        eq(issueThreadInteractions.addresseeAgentId, agent.id),
        eq(issueThreadInteractions.status, "pending"),
      ),
    )
    .limit(1);
  if (interaction) return true;

  const [review] = await db
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, agent.companyId),
        eq(issues.status, "in_review"),
        isNull(issues.hiddenAt),
        sql`${issues.executionState} -> 'currentParticipant' ->> 'type' = 'agent'`,
        sql`${issues.executionState} -> 'currentParticipant' ->> 'agentId' = ${agent.id}`,
      ),
    )
    .limit(1);
  return Boolean(review);
}
