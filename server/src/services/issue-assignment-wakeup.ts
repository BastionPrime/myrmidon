import { logger } from "../middleware/logger.js";
import { isConversation } from "./agent-conversations.js";
import type { DurableChatWakeupRequest } from "./durable-chat-wakeup.js";

type WakeupTriggerDetail = "manual" | "ping" | "callback" | "system";
type WakeupSource = "timer" | "assignment" | "on_demand" | "automation";

export interface IssueAssignmentWakeupDeps {
  wakeup: (
    agentId: string,
    opts: {
      source?: WakeupSource;
      triggerDetail?: WakeupTriggerDetail;
      reason?: string | null;
      payload?: Record<string, unknown> | null;
      idempotencyKey?: string | null;
      allowRunCoalescing?: boolean;
      requestedByActorType?: "user" | "agent" | "system";
      requestedByActorId?: string | null;
      contextSnapshot?: Record<string, unknown>;
      durableChatRequest?: DurableChatWakeupRequest;
    },
  ) => Promise<unknown>;
}

export function queueIssueAssignmentWakeup(input: {
  heartbeat: IssueAssignmentWakeupDeps;
  issue: {
    id: string;
    assigneeAgentId: string | null;
    status: string;
    conversationAgentId?: string | null;
    conversationUserId?: string | null;
  };
  reason: string;
  mutation: string;
  contextSource: string;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  taskKey?: string | null;
  /** Latest issue comment that caused this wakeup. Included in both payload
   * and context so the heartbeat can build the exact turn that was requested. */
  wakeCommentId?: string | null;
  /** Closed, server-derived omission counts for provider attachments on the
   * exact wake comment. These are prompt diagnostics, never authorization. */
  attachmentOmissionReasons?: Record<string, number> | null;
  rethrowOnError?: boolean;
  durableChatRequest?: DurableChatWakeupRequest;
}) {
  if (!input.issue.assigneeAgentId || input.issue.status === "backlog") return;

  // myrmidon(X8a): an Agent Chat conversation keeps one provider session
  // keyed by issue id, regardless of the taskKey a caller passed in. Without
  // this, a connector-driven conversation (taskKey = issue.identifier) and
  // the web conversation UI (taskKey = issue.id, see agent-conversations.ts)
  // race for the same issue on two different provider sessions, and /new
  // -- which deletes the session by issue.id -- only ever clears one of them.
  const taskKey = isConversation(input.issue) ? input.issue.id : input.taskKey;

  return input.heartbeat
    .wakeup(input.issue.assigneeAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: input.reason,
      payload: {
        issueId: input.issue.id,
        mutation: input.mutation,
        ...(taskKey ? { taskKey } : {}),
        ...(input.wakeCommentId ? { wakeCommentId: input.wakeCommentId } : {}),
      },
      requestedByActorType: input.requestedByActorType,
      requestedByActorId: input.requestedByActorId ?? null,
      ...(input.durableChatRequest
        ? { durableChatRequest: input.durableChatRequest }
        : {}),
      contextSnapshot: {
        issueId: input.issue.id,
        source: input.contextSource,
        ...(taskKey ? { taskKey } : {}),
        ...(input.wakeCommentId ? { wakeCommentId: input.wakeCommentId } : {}),
        ...(input.wakeCommentId && input.attachmentOmissionReasons
          ? {
              externalAttachmentOmissions: [
                {
                  commentId: input.wakeCommentId,
                  reasons: input.attachmentOmissionReasons,
                },
              ],
            }
          : {}),
      },
    })
    .catch((err) => {
      logger.warn(
        { err, issueId: input.issue.id },
        "failed to wake assignee on issue assignment",
      );
      if (input.rethrowOnError) throw err;
      return null;
    });
}
