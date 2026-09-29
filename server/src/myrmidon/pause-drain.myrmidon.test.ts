import { describe, expect, it } from "vitest";
import { HttpError } from "../errors.js";
import {
  isAgentNotInvokableConflict,
  isBudgetBlockConflict,
  isSkippableStartupRecoveryConflict,
  readCancelActiveRequested,
  readPauseDrainsEnabled,
  shouldCancelActiveRunsOnOperatorPause,
} from "./pause-drain.js";

describe("readPauseDrainsEnabled", () => {
  it("defaults to enabled when unset or empty", () => {
    expect(readPauseDrainsEnabled({})).toBe(true);
    expect(readPauseDrainsEnabled({ MYRMIDON_PAUSE_DRAINS: "  " })).toBe(true);
  });

  it("disables only on an explicit off value, case-insensitively", () => {
    expect(readPauseDrainsEnabled({ MYRMIDON_PAUSE_DRAINS: "0" })).toBe(false);
    expect(readPauseDrainsEnabled({ MYRMIDON_PAUSE_DRAINS: "false" })).toBe(false);
    expect(readPauseDrainsEnabled({ MYRMIDON_PAUSE_DRAINS: "OFF" })).toBe(false);
    expect(readPauseDrainsEnabled({ MYRMIDON_PAUSE_DRAINS: "no" })).toBe(false);
  });

  it("treats any other value as enabled", () => {
    expect(readPauseDrainsEnabled({ MYRMIDON_PAUSE_DRAINS: "1" })).toBe(true);
    expect(readPauseDrainsEnabled({ MYRMIDON_PAUSE_DRAINS: "true" })).toBe(true);
    expect(readPauseDrainsEnabled({ MYRMIDON_PAUSE_DRAINS: "garbage" })).toBe(true);
  });
});

describe("readCancelActiveRequested", () => {
  it("is false with no body and no query", () => {
    expect(readCancelActiveRequested({})).toBe(false);
    expect(readCancelActiveRequested({ body: undefined, forceQueryParam: undefined })).toBe(false);
  });

  it("reads cancelActive: true from the body", () => {
    expect(readCancelActiveRequested({ body: { cancelActive: true } })).toBe(true);
    expect(readCancelActiveRequested({ body: { cancelActive: "true" } })).toBe(false);
    expect(readCancelActiveRequested({ body: { cancelActive: false } })).toBe(false);
  });

  it("reads ?force=1 or ?force=true from the query, including an array value", () => {
    expect(readCancelActiveRequested({ forceQueryParam: "1" })).toBe(true);
    expect(readCancelActiveRequested({ forceQueryParam: "true" })).toBe(true);
    expect(readCancelActiveRequested({ forceQueryParam: "0" })).toBe(false);
    expect(readCancelActiveRequested({ forceQueryParam: ["1", "true"] })).toBe(true);
  });

  it("ignores a non-object body instead of throwing", () => {
    expect(readCancelActiveRequested({ body: "not an object" })).toBe(false);
    expect(readCancelActiveRequested({ body: null })).toBe(false);
  });
});

describe("shouldCancelActiveRunsOnOperatorPause", () => {
  it("drains by default: no cancel when draining is enabled and not explicitly requested", () => {
    expect(shouldCancelActiveRunsOnOperatorPause({ drainsEnabled: true, cancelActiveRequested: false })).toBe(false);
  });

  it("an explicit cancelActive/force request always cancels, even while draining is enabled", () => {
    expect(shouldCancelActiveRunsOnOperatorPause({ drainsEnabled: true, cancelActiveRequested: true })).toBe(true);
  });

  it("MYRMIDON_PAUSE_DRAINS=0 always cancels, matching the vendor default", () => {
    expect(shouldCancelActiveRunsOnOperatorPause({ drainsEnabled: false, cancelActiveRequested: false })).toBe(true);
    expect(shouldCancelActiveRunsOnOperatorPause({ drainsEnabled: false, cancelActiveRequested: true })).toBe(true);
  });
});

describe("isAgentNotInvokableConflict", () => {
  it("matches the 409 enqueueWakeup throws for a non-invokable agent", () => {
    const err = new HttpError(409, "Agent is not invokable in its current state", {
      agentId: "agent-a",
      status: "paused",
      reason: "paused",
    });
    expect(isAgentNotInvokableConflict(err)).toBe(true);
  });

  it("does not match a differently-shaped 409, other statuses, or a plain error", () => {
    expect(isAgentNotInvokableConflict(new HttpError(409, "Company is not active", { status: "archived" }))).toBe(
      false,
    );
    expect(isAgentNotInvokableConflict(new HttpError(403, "Forbidden", { status: "paused", reason: "paused" }))).toBe(
      false,
    );
    expect(isAgentNotInvokableConflict(new Error("boom"))).toBe(false);
    expect(isAgentNotInvokableConflict(new HttpError(409, "no details"))).toBe(false);
    expect(isAgentNotInvokableConflict("not an error")).toBe(false);
  });

  // myrmidon(L3): it must not match the OTHER 409 `enqueueWakeup` throws —
  // a budget-block conflict has no `reason`/`status` details fields at all
  // (its reason text is the HttpError message), which is exactly why
  // startup recovery re-threw it uncaught before `isBudgetBlockConflict`.
  it("does not match a budget-block conflict (that is isBudgetBlockConflict's job)", () => {
    expect(
      isAgentNotInvokableConflict(
        new HttpError(409, "Company is paused because its budget hard-stop was reached.", {
          scopeType: "company",
          scopeId: "company-a",
        }),
      ),
    ).toBe(false);
  });
});

describe("isBudgetBlockConflict", () => {
  it("matches the 409 enqueueWakeup throws for a company/agent/project budget hard-stop", () => {
    for (const scopeType of ["company", "agent", "project"] as const) {
      const err = new HttpError(409, "Budget hard-stop reached", { scopeType, scopeId: "scope-a" });
      expect(isBudgetBlockConflict(err)).toBe(true);
    }
  });

  it("does not match the agent-invokability 409, other statuses, or a plain error", () => {
    expect(
      isBudgetBlockConflict(
        new HttpError(409, "Agent is not invokable in its current state", { status: "paused", reason: "paused" }),
      ),
    ).toBe(false);
    expect(isBudgetBlockConflict(new HttpError(409, "Budget hard-stop reached", { scopeType: "unknown-scope" })))
      .toBe(false);
    expect(
      isBudgetBlockConflict(new HttpError(403, "Forbidden", { scopeType: "company", scopeId: "company-a" })),
    ).toBe(false);
    expect(isBudgetBlockConflict(new Error("boom"))).toBe(false);
    expect(isBudgetBlockConflict(new HttpError(409, "no details"))).toBe(false);
    expect(isBudgetBlockConflict("not an error")).toBe(false);
  });
});

describe("isSkippableStartupRecoveryConflict", () => {
  it("matches either 409 shape that startup session-goal recovery must skip instead of crash", () => {
    expect(
      isSkippableStartupRecoveryConflict(
        new HttpError(409, "Agent is not invokable in its current state", { status: "paused", reason: "paused" }),
      ),
    ).toBe(true);
    expect(
      isSkippableStartupRecoveryConflict(
        new HttpError(409, "Company is paused because its budget hard-stop was reached.", {
          scopeType: "company",
          scopeId: "company-a",
        }),
      ),
    ).toBe(true);
  });

  it("does not swallow an unrelated error", () => {
    expect(isSkippableStartupRecoveryConflict(new Error("boom"))).toBe(false);
    expect(
      isSkippableStartupRecoveryConflict(
        new HttpError(422, "Unable to resolve responsible user for heartbeat run dispatch"),
      ),
    ).toBe(false);
  });
});
