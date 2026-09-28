import { describe, expect, it } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { isTelegramConversationIssue, TELEGRAM_CONVERSATION_USER_PREFIX } from "./telegram-conversation";

type ConversationIssue = Pick<Issue, "conversationAgentId" | "conversationUserId">;

function buildIssue(overrides: Partial<ConversationIssue> = {}): ConversationIssue {
  return {
    conversationAgentId: null,
    conversationUserId: null,
    ...overrides,
  };
}

describe("myrmidon(X8f) isTelegramConversationIssue", () => {
  it("is true for a conversation whose user id carries the telegram prefix", () => {
    const issue = buildIssue({
      conversationAgentId: "agent-a",
      conversationUserId: `${TELEGRAM_CONVERSATION_USER_PREFIX}user-a`,
    });
    expect(isTelegramConversationIssue(issue)).toBe(true);
  });

  it("is false for a web Agent Chat conversation (plain user id)", () => {
    const issue = buildIssue({ conversationAgentId: "agent-a", conversationUserId: "user-a" });
    expect(isTelegramConversationIssue(issue)).toBe(false);
  });

  it("is false for a regular, non-conversation issue", () => {
    const issue = buildIssue();
    expect(isTelegramConversationIssue(issue)).toBe(false);
  });

  it("is false without a conversationAgentId even if conversationUserId has the prefix", () => {
    const issue = buildIssue({ conversationUserId: `${TELEGRAM_CONVERSATION_USER_PREFIX}user-a` });
    expect(isTelegramConversationIssue(issue)).toBe(false);
  });

  it("is false for null or undefined", () => {
    expect(isTelegramConversationIssue(null)).toBe(false);
    expect(isTelegramConversationIssue(undefined)).toBe(false);
  });

  it("is false for the bare prefix with no board user id after it", () => {
    const issue = buildIssue({
      conversationAgentId: "agent-a",
      conversationUserId: TELEGRAM_CONVERSATION_USER_PREFIX,
    });
    expect(isTelegramConversationIssue(issue)).toBe(false);
  });
});
