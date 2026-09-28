// myrmidon(X8c): applies a /model or /think choice as a per-chat override on
// assignee_adapter_overrides.adapterConfig, and drops the provider session so
// the next reply picks it up (design doc fact F11: a model/effort change
// resets the provider session; the replay that follows needs the session
// gone, exactly like /new's own reset in agent-conversations.ts).

import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentTaskSessions, issues } from "@paperclipai/db";
import {
  persistActivity,
  publishActivity,
  type ActivityPublication,
} from "../../../services/activity-log.js";
import { isRecord } from "./models.js";

export interface ApplyChatAdapterOverrideInput {
  db: Db;
  companyId: string;
  /** The conversation's agent (== issue.conversationAgentId, checked by the caller). */
  conversationAgentId: string;
  issueId: string;
  boardUserId: string;
  key: "model" | "effort";
  /** The new value, or null to clear the override back to the agent card. */
  value: string | null;
}

/**
 * Merges `{ key: value }` into this conversation's `adapterConfig` override
 * (dropping the key entirely when `value` is null), keeping other override
 * keys as-is, then deletes this conversation's provider session so the next
 * reply starts fresh with a replay of recent history.
 */
export async function applyChatAdapterOverride(
  input: ApplyChatAdapterOverrideInput,
): Promise<void> {
  let publication: ActivityPublication | null = null;
  await input.db.transaction(async (tx) => {
    const [issue] = await tx
      .select({ assigneeAdapterOverrides: issues.assigneeAdapterOverrides })
      .from(issues)
      .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
      .for("update");
    if (!issue) return;

    const overrides: Record<string, unknown> = isRecord(issue.assigneeAdapterOverrides)
      ? issue.assigneeAdapterOverrides
      : {};
    const adapterConfig: Record<string, unknown> = {
      ...(isRecord(overrides.adapterConfig) ? overrides.adapterConfig : {}),
    };
    if (input.value === null) {
      delete adapterConfig[input.key];
    } else {
      adapterConfig[input.key] = input.value;
    }

    const nextOverrides: Record<string, unknown> = { ...overrides };
    if (Object.keys(adapterConfig).length > 0) {
      nextOverrides.adapterConfig = adapterConfig;
    } else {
      delete nextOverrides.adapterConfig;
    }

    await tx
      .update(issues)
      .set({
        assigneeAdapterOverrides: Object.keys(nextOverrides).length > 0 ? nextOverrides : null,
        updatedAt: new Date(),
      })
      .where(eq(issues.id, input.issueId));

    // Deliberately does not touch sessions belonging to other tasks (same
    // scope as /new's own delete in agent-conversations.ts:191-199).
    await tx
      .delete(agentTaskSessions)
      .where(
        and(
          eq(agentTaskSessions.companyId, input.companyId),
          eq(agentTaskSessions.agentId, input.conversationAgentId),
          eq(agentTaskSessions.taskKey, input.issueId),
        ),
      );

    publication = (
      await persistActivity(tx as unknown as Db, {
        companyId: input.companyId,
        actorType: "user",
        actorId: input.boardUserId,
        action: "issue.updated",
        entityType: "issue",
        entityId: input.issueId,
        issueId: input.issueId,
        details: {
          source: "chat:telegram",
          conversationOverride: { key: input.key, value: input.value },
        },
      })
    ).publication;
  });
  if (publication) publishActivity(publication);
}
