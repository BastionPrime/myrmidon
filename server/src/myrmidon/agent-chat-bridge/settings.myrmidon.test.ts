import { describe, expect, it } from "vitest";
import {
  DEFAULT_CROSS_CHANNEL_LOOKBACK_HOURS,
  DEFAULT_CROSS_CHANNEL_MESSAGES,
  DEFAULT_CROSS_CHANNEL_MESSAGE_CHARS,
  DEFAULT_CROSS_CHANNEL_TOTAL_CHARS,
  readCrossChannelSettings,
  telegramDmConversationsConfigured,
  telegramDmConversationsEnabled,
} from "./settings.js";

describe("telegramDmConversationsEnabled", () => {
  it("defaults to off when unset or blank", () => {
    expect(telegramDmConversationsEnabled("bot-a", {})).toBe(false);
    expect(telegramDmConversationsEnabled("bot-a", { MYRMIDON_TELEGRAM_DM_CONVERSATIONS: "" })).toBe(false);
    expect(telegramDmConversationsEnabled("bot-a", { MYRMIDON_TELEGRAM_DM_CONVERSATIONS: "  " })).toBe(false);
  });

  it("enables every endpoint with '*'", () => {
    expect(
      telegramDmConversationsEnabled("bot-a", { MYRMIDON_TELEGRAM_DM_CONVERSATIONS: "*" }),
    ).toBe(true);
    expect(
      telegramDmConversationsEnabled("bot-z", { MYRMIDON_TELEGRAM_DM_CONVERSATIONS: "*" }),
    ).toBe(true);
  });

  it("matches a comma-separated list with surrounding spaces and drops empty entries", () => {
    const env = { MYRMIDON_TELEGRAM_DM_CONVERSATIONS: " bot-a, , bot-b ,bot-c" };
    expect(telegramDmConversationsEnabled("bot-a", env)).toBe(true);
    expect(telegramDmConversationsEnabled("bot-b", env)).toBe(true);
    expect(telegramDmConversationsEnabled("bot-c", env)).toBe(true);
    expect(telegramDmConversationsEnabled("bot-d", env)).toBe(false);
    expect(telegramDmConversationsEnabled("", env)).toBe(false);
  });
});

describe("telegramDmConversationsConfigured", () => {
  it("is false when unset, blank, or only separators (vendor path stays untouched)", () => {
    expect(telegramDmConversationsConfigured({})).toBe(false);
    expect(telegramDmConversationsConfigured({ MYRMIDON_TELEGRAM_DM_CONVERSATIONS: "" })).toBe(false);
    expect(telegramDmConversationsConfigured({ MYRMIDON_TELEGRAM_DM_CONVERSATIONS: "  " })).toBe(false);
    expect(telegramDmConversationsConfigured({ MYRMIDON_TELEGRAM_DM_CONVERSATIONS: " , ,," })).toBe(false);
  });

  it("is true for '*' and for a list with at least one id, regardless of any one endpoint", () => {
    expect(telegramDmConversationsConfigured({ MYRMIDON_TELEGRAM_DM_CONVERSATIONS: "*" })).toBe(true);
    expect(telegramDmConversationsConfigured({ MYRMIDON_TELEGRAM_DM_CONVERSATIONS: "bot-a" })).toBe(true);
    expect(telegramDmConversationsConfigured({ MYRMIDON_TELEGRAM_DM_CONVERSATIONS: " , bot-a ," })).toBe(true);
  });

  it("agrees with telegramDmConversationsEnabled: a matching endpoint implies configured", () => {
    for (const value of ["*", "bot-a", " bot-b , bot-a "]) {
      const env = { MYRMIDON_TELEGRAM_DM_CONVERSATIONS: value };
      expect(telegramDmConversationsEnabled("bot-a", env)).toBe(true);
      expect(telegramDmConversationsConfigured(env)).toBe(true);
    }
  });
});

describe("readCrossChannelSettings", () => {
  it("defaults to 12/600/4000/168", () => {
    expect(DEFAULT_CROSS_CHANNEL_MESSAGES).toBe(12);
    expect(DEFAULT_CROSS_CHANNEL_MESSAGE_CHARS).toBe(600);
    expect(DEFAULT_CROSS_CHANNEL_TOTAL_CHARS).toBe(4000);
    expect(DEFAULT_CROSS_CHANNEL_LOOKBACK_HOURS).toBe(168);
    expect(readCrossChannelSettings({})).toEqual({
      messages: 12,
      messageChars: 600,
      totalChars: 4000,
      lookbackHours: 168,
    });
  });

  it("reads configured non-negative integers, including 0 to disable", () => {
    expect(
      readCrossChannelSettings({
        MYRMIDON_CHAT_CROSS_CHANNEL_MESSAGES: "0",
        MYRMIDON_CHAT_CROSS_CHANNEL_MESSAGE_CHARS: " 300 ",
        MYRMIDON_CHAT_CROSS_CHANNEL_TOTAL_CHARS: "2000",
        MYRMIDON_CHAT_CROSS_CHANNEL_LOOKBACK_HOURS: "24",
      }),
    ).toEqual({ messages: 0, messageChars: 300, totalChars: 2000, lookbackHours: 24 });
  });

  it("falls back to the default on negative and non-numeric values", () => {
    expect(
      readCrossChannelSettings({
        MYRMIDON_CHAT_CROSS_CHANNEL_MESSAGES: "-5",
        MYRMIDON_CHAT_CROSS_CHANNEL_MESSAGE_CHARS: "many",
        MYRMIDON_CHAT_CROSS_CHANNEL_TOTAL_CHARS: "",
        MYRMIDON_CHAT_CROSS_CHANNEL_LOOKBACK_HOURS: "1.5",
      }),
    ).toEqual({
      messages: DEFAULT_CROSS_CHANNEL_MESSAGES,
      messageChars: DEFAULT_CROSS_CHANNEL_MESSAGE_CHARS,
      totalChars: DEFAULT_CROSS_CHANNEL_TOTAL_CHARS,
      lookbackHours: DEFAULT_CROSS_CHANNEL_LOOKBACK_HOURS,
    });
  });
});
