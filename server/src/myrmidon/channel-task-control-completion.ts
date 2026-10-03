import { and, desc, eq, inArray, like } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { chatConversations, chatPublications } from "@paperclipai/db";
import { projectSafeChatPublication } from "../services/chat-publication-projection.js";

/**
 * myrmidon(CHANNEL-TASK-CLOSE): status-only close of a channel-bound task.
 *
 * A Telegram-born task holds a chat_conversations row, and the vendor's own
 * completion surface for that conversation is the `control:close:` chat
 * publication (the /close command in the bound chat). Before this module the
 * only way the bound conversation learned the task had finished was the owner
 * typing /close — an agent (or board operator) flipping the issue status on the
 * API left the conversation active with no notification at all.
 *
 * This helper stages the same `control:close:` publication the chat command
 * uses, from inside the issue update transaction, so the regular pending
 * publication sweep delivers it, renders the standard task-control notice, and
 * completes the conversation (commitTaskControlCompletion in chat-channels.ts
 * keys off the `control:close:` prefix, no other wiring needed).
 *
 * Deliberately narrow:
 * - only terminal transitions (done/cancelled);
 * - only when the actor is the currently assigned agent of the task
 *   (assignment changes on a channel-bound task keep their own 409 lock);
 * - only one completion publication per conversation: if any `control:close:`
 *   publication already exists, staging is a no-op;
 * - insert is onConflictDoNothing, so concurrent statuses cannot double-post.
 */

const CONTROL_CLOSE_PREFIX = "control:close:";
const TERMINAL_STATUSES = ["done", "cancelled"] as const;

export function isTerminalIssueStatus(status: string | undefined): boolean {
  return !!status && (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * Stage the task-control completion publication for a channel-bound issue that
 * just transitioned to a terminal status. Returns the staged publication id
 * when a new row was created, null when nothing was staged (no binding,
 * conversation already carrying a close publication, or the actor is not the
 * assigned agent).
 */
export async function stageChannelTaskCompletionPublication(
  tx: Db,
  input: {
    companyId: string;
    issueId: string;
    issueIdentifier: string;
    issueTitle: string;
    issueStatus: string;
    actorAgentId: string | null;
    assigneeAgentId: string | null;
  },
): Promise<string | null> {
  if (!isTerminalIssueStatus(input.issueStatus)) return null;
  // Only the assigned agent's own close drives this; every other actor keeps
  // the vendor behaviour (the chat-side /close command remains the surface for
  // owners, and board operators already have their own flows).
  if (!input.actorAgentId || input.actorAgentId !== input.assigneeAgentId) {
    return null;
  }
  const [conversation] = await tx
    .select({
      id: chatConversations.id,
      endpointId: chatConversations.endpointId,
    })
    .from(chatConversations)
    .where(
      and(
        eq(chatConversations.companyId, input.companyId),
        eq(chatConversations.issueId, input.issueId),
        inArray(chatConversations.state, ["active", "waiting"]),
      ),
    )
    .orderBy(desc(chatConversations.sessionGeneration))
    .limit(1);
  if (!conversation) return null;
  const existingClose = await tx
    .select({ id: chatPublications.id })
    .from(chatPublications)
    .where(
      and(
        eq(chatPublications.companyId, input.companyId),
        eq(chatPublications.endpointId, conversation.endpointId),
        eq(chatPublications.conversationId, conversation.id),
        like(chatPublications.idempotencyKey, `${CONTROL_CLOSE_PREFIX}%`),
      ),
    )
    .limit(1);
  if (existingClose.length > 0) return null;
  const [inserted] = await tx
    .insert(chatPublications)
    .values({
      companyId: input.companyId,
      endpointId: conversation.endpointId,
      conversationId: conversation.id,
      issueId: input.issueId,
      idempotencyKey: `${CONTROL_CLOSE_PREFIX}status:${input.issueId}`,
      payload: projectSafeChatPublication({
        classification: "external",
        source: "task_control",
        text: `${input.issueIdentifier}: ${input.issueTitle} — ${input.issueStatus}`,
      }),
      state: "pending",
    })
    .onConflictDoNothing()
    .returning({ id: chatPublications.id });
  return inserted?.id ?? null;
}
