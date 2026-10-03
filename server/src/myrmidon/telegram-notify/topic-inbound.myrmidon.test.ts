// myrmidon(TG-NOTIFY-D): unit coverage for the topic-inbound gate and task
// title/body helpers (part D of the 1.6.1 TG-NOTIFY settings contract).
import { describe, expect, it } from "vitest";
import {
  isTelegramTopicThread,
  topicInboundAdmitted,
  topicTaskBody,
  topicTaskTitle,
} from "./topic-inbound.js";
import {
  parseTelegramNotifyInbound,
  readTelegramNotifyInbound,
  readTelegramNotifyDocument,
  DEFAULT_TELEGRAM_NOTIFY_INBOUND,
} from "./settings.js";

describe("isTelegramTopicThread", () => {
  it("recognizes forum topic thread ids", () => {
    expect(isTelegramTopicThread("telegram:-100123:77")).toBe(true);
    expect(isTelegramTopicThread("telegram:-100123:1")).toBe(true);
  });
  it("rejects group roots and other providers", () => {
    expect(isTelegramTopicThread("telegram:-100123")).toBe(false);
    expect(isTelegramTopicThread("slack:C123:456")).toBe(false);
    expect(isTelegramTopicThread("")).toBe(false);
  });
});

describe("topicInboundAdmitted", () => {
  it("is off by default: nothing is admitted without stored settings", () => {
    expect(
      topicInboundAdmitted({
        inbound: { enabled: false, requireMention: true },
        threadId: "telegram:-100123:77",
        addressed: true,
      }),
    ).toBe(false);
  });
  it("admits an addressed message when inbound is enabled", () => {
    expect(
      topicInboundAdmitted({
        inbound: { enabled: true, requireMention: true },
        threadId: "telegram:-100123:77",
        addressed: true,
      }),
    ).toBe(true);
  });
  it("requireMention=true ignores an unaddressed message", () => {
    expect(
      topicInboundAdmitted({
        inbound: { enabled: true, requireMention: true },
        threadId: "telegram:-100123:77",
        addressed: false,
      }),
    ).toBe(false);
  });
  it("requireMention=false admits an unaddressed topic message", () => {
    expect(
      topicInboundAdmitted({
        inbound: { enabled: true, requireMention: false },
        threadId: "telegram:-100123:77",
        addressed: false,
      }),
    ).toBe(true);
  });
  it("never admits a non-topic thread even when inbound is on", () => {
    expect(
      topicInboundAdmitted({
        inbound: { enabled: true, requireMention: false },
        threadId: "telegram:-100123",
        addressed: false,
      }),
    ).toBe(false);
  });
});

describe("parseTelegramNotifyInbound", () => {
  it("returns the safe default for garbage and absent documents", () => {
    expect(parseTelegramNotifyInbound(null)).toEqual(
      DEFAULT_TELEGRAM_NOTIFY_INBOUND,
    );
    expect(parseTelegramNotifyInbound("nope")).toEqual(
      DEFAULT_TELEGRAM_NOTIFY_INBOUND,
    );
    expect(parseTelegramNotifyInbound({})).toEqual(
      DEFAULT_TELEGRAM_NOTIFY_INBOUND,
    );
  });
  it("reads the contract fields and keeps defaults for invalid values", () => {
    expect(
      parseTelegramNotifyInbound({ inbound: { enabled: true } }),
    ).toEqual({ enabled: true, requireMention: true });
    expect(
      parseTelegramNotifyInbound({
        inbound: { enabled: "yes", requireMention: "false" },
      }),
    ).toEqual(DEFAULT_TELEGRAM_NOTIFY_INBOUND);
  });
});

describe("readTelegramNotifyInbound", () => {
  it("reads the telegramNotify key from instance settings general", async () => {
    const rows: Array<{ general: Record<string, unknown> | null }> = [
      { general: { telegramNotify: { inbound: { enabled: true } } } },
    ];
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            then: (resolve: (value: typeof rows) => unknown) =>
              Promise.resolve(rows).then(resolve as never),
          }),
        }),
      }),
    };
    expect(await readTelegramNotifyInbound(db as never)).toEqual({
      enabled: true,
      requireMention: true,
    });
    expect(await readTelegramNotifyDocument(db as never)).toEqual({
      inbound: { enabled: true },
    });
  });
  it("falls back to the default when no row exists", async () => {
    const rows: Array<{ general: Record<string, unknown> | null }> = [];
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            then: (resolve: (value: typeof rows) => unknown) =>
              Promise.resolve(rows).then(resolve as never),
          }),
        }),
      }),
    };
    expect(await readTelegramNotifyInbound(db as never)).toEqual(
      DEFAULT_TELEGRAM_NOTIFY_INBOUND,
    );
  });
});

describe("topicTaskTitle", () => {
  it("uses the first words of the message", () => {
    expect(topicTaskTitle("Fix the login page tonight please", "agent-bot")).toBe(
      "Fix the login page tonight please",
    );
  });
  it("strips bot mentions and uses only the first line", () => {
    expect(
      topicTaskTitle("@agent-bot fix the deploy\nsecond line", "agent-bot"),
    ).toBe("fix the deploy");
  });
  it("caps long messages at 160 characters", () => {
    const title = topicTaskTitle("x".repeat(300), null);
    expect(title.length).toBe(160);
  });
  it("falls back to a neutral title for mention-only text", () => {
    expect(topicTaskTitle("@agent-bot", "agent-bot")).toBe(
      "Telegram topic message for @agent-bot",
    );
    expect(topicTaskTitle("", null)).toBe("Telegram topic message");
  });
});

describe("topicTaskBody", () => {
  it("contains the message text and the thread link", () => {
    const body = topicTaskBody({
      text: "Please fix the login page",
      threadUrl: "https://t.me/c/100123/77/42",
      chatLabel: "eng-group",
    });
    expect(body).toContain("Please fix the login page");
    expect(body).toContain("https://t.me/c/100123/77/42");
    expect(body).toContain("eng-group");
  });
  it("works without a thread url or chat label", () => {
    const body = topicTaskBody({ text: "hello", threadUrl: null, chatLabel: null });
    expect(body).toContain("hello");
    expect(body).toContain("Origin: Telegram topic");
  });
  it("marks an empty message body explicitly", () => {
    const body = topicTaskBody({ text: "  ", threadUrl: null, chatLabel: null });
    expect(body).toContain("(empty message)");
  });
});
