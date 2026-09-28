import { describe, expect, it, vi } from "vitest";
import { queueIssueAssignmentWakeup } from "./issue-assignment-wakeup.js";

function heartbeatSpy() {
  const wakeup = vi.fn().mockResolvedValue(undefined);
  return { heartbeat: { wakeup }, wakeup };
}

describe("queueIssueAssignmentWakeup", () => {
  it("wakes an Agent Chat conversation with taskKey = issue.id even when a stale taskKey is passed in", async () => {
    const { heartbeat, wakeup } = heartbeatSpy();
    await queueIssueAssignmentWakeup({
      heartbeat,
      issue: {
        id: "issue-a",
        assigneeAgentId: "agent-a",
        status: "in_review",
        conversationAgentId: "agent-a",
        conversationUserId: "user-a",
      },
      reason: "External chat message received",
      mutation: "chat_message_received",
      contextSource: "chat:telegram",
      taskKey: "ABC-1",
    });
    expect(wakeup).toHaveBeenCalledTimes(1);
    const opts = wakeup.mock.calls[0][1];
    expect(opts.payload.taskKey).toBe("issue-a");
    expect(opts.contextSnapshot.taskKey).toBe("issue-a");
  });

  it("wakes an Agent Chat conversation with taskKey = issue.id when no taskKey is passed in", async () => {
    const { heartbeat, wakeup } = heartbeatSpy();
    await queueIssueAssignmentWakeup({
      heartbeat,
      issue: {
        id: "issue-a",
        assigneeAgentId: "agent-a",
        status: "in_review",
        conversationAgentId: "agent-a",
        conversationUserId: "user-a",
      },
      reason: "External chat message received",
      mutation: "chat_message_received",
      contextSource: "chat:telegram",
    });
    const opts = heartbeat.wakeup.mock.calls[0][1];
    expect(opts.payload.taskKey).toBe("issue-a");
    expect(opts.contextSnapshot.taskKey).toBe("issue-a");
  });

  it("keeps the caller's taskKey for a plain (non-conversation) task", async () => {
    const { heartbeat } = heartbeatSpy();
    await queueIssueAssignmentWakeup({
      heartbeat,
      issue: { id: "issue-b", assigneeAgentId: "agent-a", status: "in_review" },
      reason: "External chat message received",
      mutation: "chat_message_received",
      contextSource: "chat:telegram",
      taskKey: "ABC-1",
    });
    const opts = heartbeat.wakeup.mock.calls[0][1];
    expect(opts.payload.taskKey).toBe("ABC-1");
    expect(opts.contextSnapshot.taskKey).toBe("ABC-1");
  });

  it("treats a Telegram-keyed conversation (conversationUserId = telegram:user-a) as a conversation too", async () => {
    const { heartbeat } = heartbeatSpy();
    await queueIssueAssignmentWakeup({
      heartbeat,
      issue: {
        id: "issue-c",
        assigneeAgentId: "agent-a",
        status: "in_review",
        conversationAgentId: "agent-a",
        conversationUserId: "telegram:user-a",
      },
      reason: "External chat message received",
      mutation: "chat_message_received",
      contextSource: "chat:telegram",
      taskKey: "ABC-2",
    });
    const opts = heartbeat.wakeup.mock.calls[0][1];
    expect(opts.payload.taskKey).toBe("issue-c");
    expect(opts.contextSnapshot.taskKey).toBe("issue-c");
  });
});
