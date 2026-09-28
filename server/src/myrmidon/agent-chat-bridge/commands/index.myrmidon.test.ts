import { describe, expect, it, vi } from "vitest";
import {
  TELEGRAM_DM_COMMANDS,
  parseBridgedCommand,
  runBridgedDirectMessageCommand,
  type BridgedCommandInput,
} from "./index.js";

describe("parseBridgedCommand", () => {
  it("parses a bare command", () => {
    expect(parseBridgedCommand("/new")).toEqual({ name: "new", args: "" });
  });

  it("parses a command with an @bot suffix", () => {
    expect(parseBridgedCommand("/new@some_bot")).toEqual({ name: "new", args: "" });
  });

  it("lowercases the command name", () => {
    expect(parseBridgedCommand("/NEW")).toEqual({ name: "new", args: "" });
  });

  it("parses /reset", () => {
    expect(parseBridgedCommand("/reset")).toEqual({ name: "reset", args: "" });
  });

  it("parses arguments, trimmed", () => {
    expect(parseBridgedCommand("/model a b")).toEqual({ name: "model", args: "a b" });
  });

  it("does not treat a mid-string slash as a command", () => {
    expect(parseBridgedCommand("/home/x")).toBeNull();
  });

  it("does not treat plain text as a command", () => {
    expect(parseBridgedCommand("hello")).toBeNull();
  });

  it("does not treat a slash followed by a space as a command", () => {
    expect(parseBridgedCommand("/ new")).toBeNull();
  });
});

function input(text: string): BridgedCommandInput {
  return {
    db: {} as BridgedCommandInput["db"],
    companyId: "company-a",
    agentId: "agent-a",
    endpointId: "endpoint-a",
    deliveryId: "delivery-a",
    boardUserId: "user-a",
    conversationIssueId: "issue-a",
    text,
    publicBaseUrl: null,
    cancelRun: vi.fn().mockResolvedValue(undefined),
  };
}

describe("runBridgedDirectMessageCommand", () => {
  it("turns /new into a message '/new'", async () => {
    expect(await runBridgedDirectMessageCommand(input("/new"))).toEqual({
      kind: "message",
      body: "/new",
    });
  });

  it("turns /reset into a message '/new'", async () => {
    expect(await runBridgedDirectMessageCommand(input("/reset"))).toEqual({
      kind: "message",
      body: "/new",
    });
  });

  it("leaves other commands unhandled (null) until X8c", async () => {
    expect(await runBridgedDirectMessageCommand(input("/model x"))).toBeNull();
    expect(await runBridgedDirectMessageCommand(input("/help"))).toBeNull();
    expect(await runBridgedDirectMessageCommand(input("hello"))).toBeNull();
  });
});

describe("TELEGRAM_DM_COMMANDS", () => {
  it("has names that are valid Telegram bot command identifiers", () => {
    for (const spec of TELEGRAM_DM_COMMANDS) {
      expect(spec.command).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(spec.description.length).toBeGreaterThan(0);
      expect(spec.description.length).toBeLessThanOrEqual(256);
    }
  });
});
