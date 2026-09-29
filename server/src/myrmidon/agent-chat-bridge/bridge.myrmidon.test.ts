// myrmidon(X8b): unit coverage for the pure decision logic — the identity
// helpers (X8a's contract) and `decideTelegramDmBinding`, which never touch
// the database except for the one settings lookup mocked below. The DB-backed
// scenarios (actually creating/binding conversations, commands, refusals)
// live in server/src/__tests__/chat-telegram-dm-conversation.myrmidon.test.ts.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../services/instance-settings.js", () => ({
  instanceSettingsService: vi.fn(),
}));

import { instanceSettingsService } from "../../services/instance-settings.js";
import { decideTelegramDmBinding } from "./bridge.js";
import {
  conversationChannel,
  conversationOwnerUserId,
  parseTelegramConversationUserId,
  siblingConversationUserId,
  telegramConversationUserId,
  TELEGRAM_CONVERSATION_USER_PREFIX,
} from "./identity.js";
import {
  TELEGRAM_DM_CONVERSATIONS_ENV,
  telegramDmConversationsEnabled,
} from "./settings.js";

function mockExperimental(enableAgentChat: boolean) {
  vi.mocked(instanceSettingsService).mockReturnValue({
    getExperimental: async () => ({ enableAgentChat }) as never,
  } as never);
}

describe("identity", () => {
  it("builds and parses the Telegram conversation key", () => {
    const boardUserId = "board-user-a";
    const key = telegramConversationUserId(boardUserId);
    expect(key).toBe(`${TELEGRAM_CONVERSATION_USER_PREFIX}${boardUserId}`);
    expect(parseTelegramConversationUserId(key)).toBe(boardUserId);
  });

  it("refuses to double-prefix an already-Telegram key", () => {
    const key = telegramConversationUserId("board-user-a");
    expect(() => telegramConversationUserId(key)).toThrow();
  });

  it("parses null/undefined/non-Telegram values as null", () => {
    expect(parseTelegramConversationUserId(null)).toBeNull();
    expect(parseTelegramConversationUserId(undefined)).toBeNull();
    expect(parseTelegramConversationUserId("board-user-a")).toBeNull();
    expect(parseTelegramConversationUserId(TELEGRAM_CONVERSATION_USER_PREFIX)).toBeNull();
  });

  it("classifies a conversation's channel", () => {
    expect(conversationChannel(null)).toBeNull();
    expect(conversationChannel({})).toBeNull();
    expect(
      conversationChannel({ conversationAgentId: "a", conversationUserId: null }),
    ).toBeNull();
    expect(
      conversationChannel({
        conversationAgentId: "a",
        conversationUserId: "board-user-a",
      }),
    ).toBe("web");
    expect(
      conversationChannel({
        conversationAgentId: "a",
        conversationUserId: telegramConversationUserId("board-user-a"),
      }),
    ).toBe("telegram");
  });

  it("finds the owning board user id regardless of channel", () => {
    expect(
      conversationOwnerUserId({
        conversationAgentId: "a",
        conversationUserId: "board-user-a",
      }),
    ).toBe("board-user-a");
    expect(
      conversationOwnerUserId({
        conversationAgentId: "a",
        conversationUserId: telegramConversationUserId("board-user-a"),
      }),
    ).toBe("board-user-a");
    expect(conversationOwnerUserId(null)).toBeNull();
  });

  it("swaps a conversation_user_id between the two channels", () => {
    const web = "board-user-a";
    const telegram = telegramConversationUserId(web);
    expect(siblingConversationUserId(web)).toBe(telegram);
    expect(siblingConversationUserId(telegram)).toBe(web);
  });
});

describe("settings: telegramDmConversationsEnabled", () => {
  const endpointId = "endpoint-a";

  it("is off when the variable is unset or empty", () => {
    expect(telegramDmConversationsEnabled(endpointId, {})).toBe(false);
    expect(
      telegramDmConversationsEnabled(endpointId, {
        [TELEGRAM_DM_CONVERSATIONS_ENV]: "  ",
      }),
    ).toBe(false);
  });

  it("is on for every endpoint with '*'", () => {
    expect(
      telegramDmConversationsEnabled(endpointId, {
        [TELEGRAM_DM_CONVERSATIONS_ENV]: "*",
      }),
    ).toBe(true);
  });

  it("matches a comma-separated allowlist, trimmed", () => {
    const env = {
      [TELEGRAM_DM_CONVERSATIONS_ENV]: ` other-endpoint , ${endpointId} ,third`,
    };
    expect(telegramDmConversationsEnabled(endpointId, env)).toBe(true);
    expect(telegramDmConversationsEnabled("not-listed", env)).toBe(false);
  });
});

describe("decideTelegramDmBinding", () => {
  const db = {} as never;
  const endpoint = {
    provider: "telegram",
    id: "endpoint-a",
    assignedAgentId: "agent-a",
  };
  const boardUserId = "board-user-a";

  beforeEach(() => {
    process.env[TELEGRAM_DM_CONVERSATIONS_ENV] = "*";
    mockExperimental(true);
  });

  afterEach(() => {
    delete process.env[TELEGRAM_DM_CONVERSATIONS_ENV];
    vi.clearAllMocks();
  });

  function telegramIssue(overrides: {
    id?: string;
    boardUserId?: string;
    agentId?: string;
  } = {}) {
    return {
      id: overrides.id ?? randomUUID(),
      conversationAgentId: overrides.agentId ?? endpoint.assignedAgentId,
      conversationUserId: telegramConversationUserId(
        overrides.boardUserId ?? boardUserId,
      ),
    };
  }

  it("does not apply for a non-Telegram provider", async () => {
    const decision = await decideTelegramDmBinding(db, {
      endpoint: { ...endpoint, provider: "slack" },
      isDirectMessage: true,
      boardUserId,
      existingConversation: null,
      existingIssue: null,
    });
    expect(decision).toEqual({ applies: false, detachExisting: false });
  });

  it("does not apply outside a direct message", async () => {
    const decision = await decideTelegramDmBinding(db, {
      endpoint,
      isDirectMessage: false,
      boardUserId,
      existingConversation: null,
      existingIssue: null,
    });
    expect(decision.applies).toBe(false);
  });

  it("does not apply for an unlinked account (null boardUserId)", async () => {
    const decision = await decideTelegramDmBinding(db, {
      endpoint,
      isDirectMessage: true,
      boardUserId: null,
      existingConversation: null,
      existingIssue: null,
    });
    expect(decision.applies).toBe(false);
  });

  it("does not apply when the endpoint is not listed", async () => {
    process.env[TELEGRAM_DM_CONVERSATIONS_ENV] = "some-other-endpoint";
    const decision = await decideTelegramDmBinding(db, {
      endpoint,
      isDirectMessage: true,
      boardUserId,
      existingConversation: null,
      existingIssue: null,
    });
    expect(decision.applies).toBe(false);
  });

  it("does not apply when Agent Chat is disabled instance-wide", async () => {
    mockExperimental(false);
    const decision = await decideTelegramDmBinding(db, {
      endpoint,
      isDirectMessage: true,
      boardUserId,
      existingConversation: null,
      existingIssue: null,
    });
    expect(decision.applies).toBe(false);
  });

  it("applies with nothing to detach on a fresh thread", async () => {
    const decision = await decideTelegramDmBinding(db, {
      endpoint,
      isDirectMessage: true,
      boardUserId,
      existingConversation: null,
      existingIssue: null,
    });
    expect(decision).toEqual({ applies: true, detachExisting: false });
  });

  it("stays bound when already on the right Telegram conversation (active)", async () => {
    const issue = telegramIssue();
    const decision = await decideTelegramDmBinding(db, {
      endpoint,
      isDirectMessage: true,
      boardUserId,
      existingConversation: { id: "conv-1", state: "active" },
      existingIssue: issue,
    });
    expect(decision).toEqual({ applies: true, detachExisting: false });
  });

  it("stays bound when already on the right Telegram conversation (waiting)", async () => {
    const issue = telegramIssue();
    const decision = await decideTelegramDmBinding(db, {
      endpoint,
      isDirectMessage: true,
      boardUserId,
      existingConversation: { id: "conv-1", state: "waiting" },
      existingIssue: issue,
    });
    expect(decision).toEqual({ applies: true, detachExisting: false });
  });

  it("detaches a completed row on its own (now-stale) Telegram conversation, without a release id", async () => {
    const issue = telegramIssue();
    const decision = await decideTelegramDmBinding(db, {
      endpoint,
      isDirectMessage: true,
      boardUserId,
      existingConversation: { id: "conv-1", state: "completed" },
      existingIssue: issue,
    });
    expect(decision).toEqual({ applies: true, detachExisting: true });
  });

  it("releases and migrates off a plain (non-conversation) task binding", async () => {
    const oldIssueId = randomUUID();
    const decision = await decideTelegramDmBinding(db, {
      endpoint,
      isDirectMessage: true,
      boardUserId,
      existingConversation: { id: "conv-1", state: "active" },
      existingIssue: {
        id: oldIssueId,
        conversationAgentId: null,
        conversationUserId: null,
      },
    });
    expect(decision).toEqual({
      applies: true,
      detachExisting: true,
      releaseConversationId: "conv-1",
      migratedFromIssueId: oldIssueId,
    });
  });

  it("releases a different agent's Telegram conversation without a migration notice", async () => {
    const issue = telegramIssue({ agentId: "some-other-agent" });
    const decision = await decideTelegramDmBinding(db, {
      endpoint,
      isDirectMessage: true,
      boardUserId,
      existingConversation: { id: "conv-1", state: "active" },
      existingIssue: issue,
    });
    expect(decision).toEqual({
      applies: true,
      detachExisting: true,
      releaseConversationId: "conv-1",
    });
  });

  it("releases another person's Telegram conversation on the same thread without a migration notice", async () => {
    const issue = telegramIssue({ boardUserId: "someone-else" });
    const decision = await decideTelegramDmBinding(db, {
      endpoint,
      isDirectMessage: true,
      boardUserId,
      existingConversation: { id: "conv-1", state: "waiting" },
      existingIssue: issue,
    });
    expect(decision).toEqual({
      applies: true,
      detachExisting: true,
      releaseConversationId: "conv-1",
    });
  });

  it("releases a web-channel conversation bound to this thread without a migration notice", async () => {
    const oldIssueId = randomUUID();
    const decision = await decideTelegramDmBinding(db, {
      endpoint,
      isDirectMessage: true,
      boardUserId,
      existingConversation: { id: "conv-1", state: "active" },
      existingIssue: {
        id: oldIssueId,
        conversationAgentId: endpoint.assignedAgentId,
        conversationUserId: boardUserId,
      },
    });
    expect(decision).toEqual({
      applies: true,
      detachExisting: true,
      releaseConversationId: "conv-1",
    });
  });

  it("rolls back to the vendor path (releasing) when the flag is off but the thread is already a Telegram conversation", async () => {
    delete process.env[TELEGRAM_DM_CONVERSATIONS_ENV];
    const issue = telegramIssue();
    const decision = await decideTelegramDmBinding(db, {
      endpoint,
      isDirectMessage: true,
      boardUserId,
      existingConversation: { id: "conv-1", state: "active" },
      existingIssue: issue,
    });
    expect(decision).toEqual({
      applies: false,
      detachExisting: true,
      releaseConversationId: "conv-1",
    });
  });

  it("rolls back to the vendor path (releasing) when Agent Chat is disabled but the thread is already a Telegram conversation", async () => {
    mockExperimental(false);
    const issue = telegramIssue();
    const decision = await decideTelegramDmBinding(db, {
      endpoint,
      isDirectMessage: true,
      boardUserId,
      existingConversation: { id: "conv-1", state: "waiting" },
      existingIssue: issue,
    });
    expect(decision).toEqual({
      applies: false,
      detachExisting: true,
      releaseConversationId: "conv-1",
    });
  });

  it("does nothing when it does not apply and there is nothing Telegram-bound to release", async () => {
    delete process.env[TELEGRAM_DM_CONVERSATIONS_ENV];
    const decision = await decideTelegramDmBinding(db, {
      endpoint,
      isDirectMessage: true,
      boardUserId,
      existingConversation: { id: "conv-1", state: "active" },
      existingIssue: {
        id: randomUUID(),
        conversationAgentId: null,
        conversationUserId: null,
      },
    });
    expect(decision).toEqual({ applies: false, detachExisting: false });
  });
});
