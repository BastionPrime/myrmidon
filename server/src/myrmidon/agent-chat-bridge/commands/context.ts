// myrmidon(X8c): loads and authorizes the bridged Telegram conversation a
// command is running against: it must be the caller's own Telegram
// conversation with the agent it claims to run for.

import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns, issues } from "@paperclipai/db";
import { conversationChannel, conversationOwnerUserId } from "../identity.js";

/** Reply text for a command that cannot be attributed to the caller's own bridged conversation. */
export const CHAT_NOT_AVAILABLE_TEXT = "This chat is not available.";

export interface BridgedCommandIssueContext {
  id: string;
  companyId: string;
  conversationAgentId: string;
  conversationUserId: string;
  conversationSessionGeneration: number;
  assigneeAdapterOverrides: Record<string, unknown> | null;
  executionRunId: string | null;
}

export interface BridgedCommandAgentContext {
  id: string;
  name: string;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
}

export interface BridgedCommandContext {
  issue: BridgedCommandIssueContext;
  agent: BridgedCommandAgentContext;
  /** A reply for this conversation is queued or already running. */
  turnInProgress: boolean;
}

/**
 * Loads the bridged conversation and its agent, and checks that the command
 * is running against the caller's own Telegram conversation with the agent
 * it claims to run for. Returns null when any of that does not hold; callers
 * must answer with CHAT_NOT_AVAILABLE_TEXT and make no other record (design
 * doc section 2.9: commands act only on the owner's own Telegram chat).
 */
export async function loadBridgedCommandContext(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    boardUserId: string;
    conversationIssueId: string;
  },
): Promise<BridgedCommandContext | null> {
  const [issueRow] = await db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      conversationAgentId: issues.conversationAgentId,
      conversationUserId: issues.conversationUserId,
      conversationSessionGeneration: issues.conversationSessionGeneration,
      assigneeAdapterOverrides: issues.assigneeAdapterOverrides,
      executionRunId: issues.executionRunId,
    })
    .from(issues)
    .where(
      and(
        eq(issues.id, input.conversationIssueId),
        eq(issues.companyId, input.companyId),
      ),
    )
    .limit(1);

  if (!issueRow) return null;
  if (!issueRow.conversationAgentId || !issueRow.conversationUserId) return null;
  if (conversationChannel(issueRow) !== "telegram") return null;
  if (conversationOwnerUserId(issueRow) !== input.boardUserId) return null;
  if (issueRow.conversationAgentId !== input.agentId) return null;

  const [agentRow] = await db
    .select({
      id: agents.id,
      name: agents.name,
      adapterType: agents.adapterType,
      adapterConfig: agents.adapterConfig,
    })
    .from(agents)
    .where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)))
    .limit(1);
  if (!agentRow) return null;

  const turnInProgress = await isBridgedCommandTurnInProgress(db, {
    companyId: input.companyId,
    agentId: input.agentId,
    issueId: issueRow.id,
    executionRunId: issueRow.executionRunId,
  });

  return {
    issue: {
      id: issueRow.id,
      companyId: issueRow.companyId,
      conversationAgentId: issueRow.conversationAgentId,
      conversationUserId: issueRow.conversationUserId,
      conversationSessionGeneration: issueRow.conversationSessionGeneration,
      assigneeAdapterOverrides:
        (issueRow.assigneeAdapterOverrides as Record<string, unknown> | null) ?? null,
      executionRunId: issueRow.executionRunId,
    },
    agent: {
      id: agentRow.id,
      name: agentRow.name,
      adapterType: agentRow.adapterType,
      adapterConfig: (agentRow.adapterConfig as Record<string, unknown> | null) ?? {},
    },
    turnInProgress,
  };
}

async function isBridgedCommandTurnInProgress(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    issueId: string;
    executionRunId: string | null;
  },
): Promise<boolean> {
  if (input.executionRunId) return true;
  const [running] = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
        inArray(heartbeatRuns.status, ["queued", "running"]),
        sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${input.issueId}`,
      ),
    )
    .limit(1);
  return Boolean(running);
}
