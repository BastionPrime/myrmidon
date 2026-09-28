import { afterEach, describe, expect, it } from "vitest";
import { bypassesSettledHold } from "./explicit-wake-gate.js";

const ENV_KEY = "MYRMIDON_SETTLED_HOLDS_BLOCK_EXPLICIT_WAKES";

describe("bypassesSettledHold", () => {
  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  it("bypasses the hold for an explicit wake by default", () => {
    expect(bypassesSettledHold({ source: "on_demand", reason: "issue_commented" })).toBe(true);
  });

  it("does not bypass the hold for a non-explicit wake", () => {
    expect(bypassesSettledHold({ source: "timer" })).toBe(false);
  });

  it("keeps the vendor's original behavior (never bypasses) when the setting is on", () => {
    process.env[ENV_KEY] = "1";
    expect(bypassesSettledHold({ source: "on_demand", reason: "issue_commented" })).toBe(false);
    expect(bypassesSettledHold({ source: "assignment", reason: "issue_assigned" })).toBe(false);
  });

  it("only the exact value \"1\" turns the setting on", () => {
    process.env[ENV_KEY] = "true";
    expect(bypassesSettledHold({ source: "on_demand" })).toBe(true);
  });
});
