import { afterEach, describe, expect, it } from "vitest";
import { bypassesSettledHold } from "./explicit-wake-gate.js";

const ENV_KEY = "MYRMIDON_SETTLED_HOLDS_BLOCK_EXPLICIT_WAKES";

describe("bypassesSettledHold", () => {
  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  it("bypasses the hold for an explicit, user-authorized wake by default", () => {
    expect(bypassesSettledHold({ source: "on_demand", reason: "issue_commented", requestedByActorType: "user" })).toBe(true);
  });

  it("does not bypass the hold for a non-explicit wake", () => {
    expect(bypassesSettledHold({ source: "timer", requestedByActorType: "user" })).toBe(false);
  });

  // Round-1 fix: a reason/source shape that would otherwise read as
  // explicit never bypasses on its own — an unattended automatic sweep can
  // set the exact same shape (recovery/service.ts's
  // `reconcileUnassignedBlockingIssues`, `assigned_todo_liveness_dispatch`;
  // issue-thread-interactions.ts's merged-PR sweep), all with
  // `requestedByActorType: "system"`.
  it("never bypasses the hold for a system-actor wake, whatever its reason/source", () => {
    expect(bypassesSettledHold({ source: "on_demand", reason: "issue_commented", requestedByActorType: "system" })).toBe(false);
    expect(bypassesSettledHold({ source: "assignment", reason: "issue_assigned", requestedByActorType: "system" })).toBe(false);
    expect(bypassesSettledHold({ source: "assignment", reason: "issue_assigned" })).toBe(false);
  });

  it("keeps the vendor's original behavior (never bypasses) when the setting is on", () => {
    process.env[ENV_KEY] = "1";
    expect(bypassesSettledHold({ source: "on_demand", reason: "issue_commented", requestedByActorType: "user" })).toBe(false);
    expect(bypassesSettledHold({ source: "assignment", reason: "issue_assigned", requestedByActorType: "user" })).toBe(false);
  });

  it("only the exact value \"1\" turns the setting on", () => {
    process.env[ENV_KEY] = "true";
    expect(bypassesSettledHold({ source: "on_demand", triggerDetail: "manual", requestedByActorType: "user" })).toBe(true);
  });
});
