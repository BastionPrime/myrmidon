// myrmidon(X8c): /status — a short, secret-free summary of this Telegram
// chat: agent, model/reasoning source, session state, whether a reply is
// running, last reply's usage, and whether the web conversation is shared
// into this chat's context (X8d).

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentTaskSessions, heartbeatRuns } from "@paperclipai/db";
import { safeChatTaskUrl } from "../../../services/chat-task-url.js";
import { issueService } from "../../../services/issues.js";
import { readCrossChannelSettings } from "../settings.js";
import type { BridgedCommandContext } from "./context.js";
import {
  THINK_OVERRIDE_ALLOWED_ADAPTER_TYPES,
  describeEffectiveChatValue,
  readOverrideAdapterConfig,
} from "./models.js";

export interface BuildChatStatusReplyInput {
  db: Db;
  companyId: string;
  agentId: string;
  boardUserId: string;
  publicBaseUrl: string | null;
  context: BridgedCommandContext;
}

export async function buildChatStatusReply(input: BuildChatStatusReplyInput): Promise<string> {
  const { db, companyId, agentId, boardUserId, publicBaseUrl, context } = input;
  const lines: string[] = [`${context.agent.name} · Telegram chat`];

  const boardUrl = safeChatTaskUrl(publicBaseUrl, context.issue.id);
  if (boardUrl) lines.push(`Board: ${boardUrl}`);

  const overrideAdapterConfig = readOverrideAdapterConfig(context.issue.assigneeAdapterOverrides);
  const model = describeEffectiveChatValue(overrideAdapterConfig, context.agent.adapterConfig, "model");
  lines.push(`Model: ${model.value} (${model.source})`);
  if (THINK_OVERRIDE_ALLOWED_ADAPTER_TYPES.includes(context.agent.adapterType)) {
    const reasoning = describeEffectiveChatValue(overrideAdapterConfig, context.agent.adapterConfig, "effort");
    lines.push(`Reasoning: ${reasoning.value} (${reasoning.source})`);
  }

  const hasModelSession = await hasAgentTaskSession(db, companyId, agentId, context.issue.id);
  lines.push(
    `Session: #${context.issue.conversationSessionGeneration + 1}, model session ${
      hasModelSession ? "active" : "starts fresh on next reply"
    }`,
  );

  lines.push(await describeCurrentTurn(db, companyId, agentId, context.issue.id));

  const usageLine = formatUsageLine(await findLastSucceededRunUsage(db, companyId, agentId, context.issue.id));
  if (usageLine) lines.push(usageLine);

  const crossChannel = readCrossChannelSettings();
  if (crossChannel.messages > 0) {
    const webConversation = await issueService(db).getConversation(companyId, agentId, boardUserId);
    lines.push(`Web chat: ${webConversation ? `shared (last ${crossChannel.messages} messages)` : "none"}`);
  } else {
    lines.push("Web chat: not shared");
  }

  return lines.join("\n");
}

async function hasAgentTaskSession(
  db: Db,
  companyId: string,
  agentId: string,
  issueId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: agentTaskSessions.id })
    .from(agentTaskSessions)
    .where(
      and(
        eq(agentTaskSessions.companyId, companyId),
        eq(agentTaskSessions.agentId, agentId),
        eq(agentTaskSessions.taskKey, issueId),
      ),
    )
    .limit(1);
  return Boolean(row);
}

async function describeCurrentTurn(
  db: Db,
  companyId: string,
  agentId: string,
  issueId: string,
): Promise<string> {
  const [run] = await db
    .select({
      status: heartbeatRuns.status,
      startedAt: heartbeatRuns.startedAt,
      createdAt: heartbeatRuns.createdAt,
    })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.agentId, agentId),
        inArray(heartbeatRuns.status, ["queued", "running"]),
        sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
      ),
    )
    .orderBy(desc(heartbeatRuns.createdAt))
    .limit(1);
  if (!run) return "Now: idle";
  if (run.status === "queued") return "Now: queued";
  return `Now: replying since ${formatUtcTime(run.startedAt ?? run.createdAt)}`;
}

function formatUtcTime(value: Date | string | null): string {
  const date = value instanceof Date ? value : value ? new Date(value) : new Date();
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm} UTC`;
}

async function findLastSucceededRunUsage(
  db: Db,
  companyId: string,
  agentId: string,
  issueId: string,
): Promise<Record<string, unknown> | null> {
  const [run] = await db
    .select({ usageJson: heartbeatRuns.usageJson })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.agentId, agentId),
        eq(heartbeatRuns.status, "succeeded"),
        sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
      ),
    )
    .orderBy(desc(heartbeatRuns.createdAt))
    .limit(1);
  return (run?.usageJson as Record<string, unknown> | null) ?? null;
}

function firstFiniteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

/** Mirrors heartbeat.ts:5337 (readRawUsageTotals) for the two fields /status needs, plus cost. */
function formatUsageLine(usageJson: Record<string, unknown> | null): string | null {
  if (!usageJson) return null;
  const inputTokens = firstFiniteNumber(usageJson.rawInputTokens, usageJson.inputTokens);
  const outputTokens = firstFiniteNumber(usageJson.rawOutputTokens, usageJson.outputTokens);
  if (inputTokens === null && outputTokens === null) return null;
  const cost = firstFiniteNumber(usageJson.costUsd, usageJson.cacheAdjustedCostUsd);
  const costText = cost !== null && cost > 0 ? `, $${cost.toFixed(2)}` : "";
  return `Last reply: ${inputTokens ?? 0} in / ${outputTokens ?? 0} out tokens${costText}`;
}
