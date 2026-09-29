import { describe, expect, it } from "vitest";
import { TELEGRAM_DM_COMMANDS, parseBridgedCommand } from "./index.js";

// myrmidon(X8a/X8c): pure, DB-free coverage of the parsing helper and the
// command spec list shared by the whole X8 contract. `runBridgedDirectMessageCommand`
// itself is covered end to end, with a real DB, in `commands.myrmidon.test.ts`
// (X8c's full command set replaces X8a's `/new`/`/reset`-only stand-in).
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

describe("TELEGRAM_DM_COMMANDS", () => {
  it("has names that are valid Telegram bot command identifiers", () => {
    for (const spec of TELEGRAM_DM_COMMANDS) {
      expect(spec.command).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(spec.description.length).toBeGreaterThan(0);
      expect(spec.description.length).toBeLessThanOrEqual(256);
    }
  });
});
