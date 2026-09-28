import { describe, expect, it } from "vitest";
import {
  TELEGRAM_CONVERSATION_USER_PREFIX,
  conversationChannel,
  conversationOwnerUserId,
  parseTelegramConversationUserId,
  siblingConversationUserId,
  telegramConversationUserId,
} from "./identity.js";

describe("TELEGRAM_CONVERSATION_USER_PREFIX", () => {
  it("is the fixed string 'telegram:'", () => {
    expect(TELEGRAM_CONVERSATION_USER_PREFIX).toBe("telegram:");
  });
});

describe("telegramConversationUserId", () => {
  it("prefixes a board user id", () => {
    expect(telegramConversationUserId("user-a")).toBe("telegram:user-a");
  });

  it("throws on an empty id", () => {
    expect(() => telegramConversationUserId("")).toThrow();
  });

  it("throws on an id that already carries the prefix", () => {
    expect(() => telegramConversationUserId("telegram:user-a")).toThrow();
  });
});

describe("parseTelegramConversationUserId", () => {
  it("returns the board user id for a Telegram conversation key", () => {
    expect(parseTelegramConversationUserId("telegram:user-a")).toBe("user-a");
  });

  it("returns null for a web conversation id", () => {
    expect(parseTelegramConversationUserId("user-a")).toBeNull();
  });

  it("returns null for the bare prefix, null, undefined and empty string", () => {
    expect(parseTelegramConversationUserId("telegram:")).toBeNull();
    expect(parseTelegramConversationUserId(null)).toBeNull();
    expect(parseTelegramConversationUserId(undefined)).toBeNull();
    expect(parseTelegramConversationUserId("")).toBeNull();
  });
});

describe("conversationChannel", () => {
  it("is 'web' for a web conversation", () => {
    expect(
      conversationChannel({ conversationAgentId: "agent-a", conversationUserId: "user-a" }),
    ).toBe("web");
  });

  it("is 'telegram' for a Telegram conversation", () => {
    expect(
      conversationChannel({
        conversationAgentId: "agent-a",
        conversationUserId: "telegram:user-a",
      }),
    ).toBe("telegram");
  });

  it("is null when either identity field is missing", () => {
    expect(conversationChannel({ conversationAgentId: "agent-a", conversationUserId: null })).toBeNull();
    expect(conversationChannel({ conversationAgentId: null, conversationUserId: "user-a" })).toBeNull();
    expect(conversationChannel({})).toBeNull();
    expect(conversationChannel(null)).toBeNull();
    expect(conversationChannel(undefined)).toBeNull();
  });
});

describe("conversationOwnerUserId", () => {
  it("returns the board user id for a web conversation", () => {
    expect(
      conversationOwnerUserId({ conversationAgentId: "agent-a", conversationUserId: "user-a" }),
    ).toBe("user-a");
  });

  it("returns the board user id for a Telegram conversation", () => {
    expect(
      conversationOwnerUserId({
        conversationAgentId: "agent-a",
        conversationUserId: "telegram:user-a",
      }),
    ).toBe("user-a");
  });

  it("is null for a non-conversation", () => {
    expect(conversationOwnerUserId({ conversationAgentId: "agent-a", conversationUserId: null })).toBeNull();
    expect(conversationOwnerUserId(null)).toBeNull();
  });
});

describe("siblingConversationUserId", () => {
  it("maps a Telegram key to the plain board user id", () => {
    expect(siblingConversationUserId("telegram:user-a")).toBe("user-a");
  });

  it("maps a plain board user id to the Telegram key", () => {
    expect(siblingConversationUserId("user-a")).toBe("telegram:user-a");
  });

  it("throws on an empty id", () => {
    expect(() => siblingConversationUserId("")).toThrow();
  });

  it("throws on a bare 'telegram:' prefix with no board user id", () => {
    expect(() => siblingConversationUserId("telegram:")).toThrow();
  });
});
