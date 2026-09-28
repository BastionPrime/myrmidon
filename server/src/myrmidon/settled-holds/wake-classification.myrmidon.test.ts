import { describe, expect, it } from "vitest";
import { isExplicitWake } from "./wake-classification.js";

describe("isExplicitWake", () => {
  it("treats a human/agent comment as explicit", () => {
    expect(isExplicitWake({ source: "automation", triggerDetail: "system", reason: "issue_commented" })).toBe(true);
    expect(isExplicitWake({ source: "on_demand", triggerDetail: "manual", reason: "issue_reopened_via_comment" })).toBe(true);
  });

  it("treats an assignment and a resumed-paused-subtree wake as explicit", () => {
    expect(isExplicitWake({ source: "assignment", triggerDetail: "system", reason: "issue_assigned" })).toBe(true);
    expect(isExplicitWake({ source: "assignment", triggerDetail: "system", reason: "issue_tree_resumed" })).toBe(true);
    // The source alone already marks it explicit, regardless of reason.
    expect(isExplicitWake({ source: "assignment", reason: null })).toBe(true);
  });

  it("treats any on-demand/manual wake as explicit", () => {
    expect(isExplicitWake({ source: "on_demand", triggerDetail: "manual", reason: null })).toBe(true);
    expect(isExplicitWake({ source: "on_demand", triggerDetail: "callback", reason: "some_api_wake" })).toBe(true);
  });

  it("treats an approval decision as explicit even under source \"automation\"", () => {
    expect(isExplicitWake({ source: "automation", triggerDetail: "system", reason: "approval_approved" })).toBe(true);
    expect(isExplicitWake({ source: "automation", triggerDetail: "system", reason: "approval_rejected" })).toBe(true);
    expect(isExplicitWake({ source: "automation", triggerDetail: "system", reason: "approval_revision_requested" })).toBe(true);
  });

  it("does not treat the scheduler's timer or an unattended monitor/recovery sweep as explicit", () => {
    expect(isExplicitWake({ source: "timer", triggerDetail: "system", reason: null })).toBe(false);
    expect(isExplicitWake({ source: "automation", triggerDetail: "system", reason: "issue_monitor_recovery" })).toBe(false);
    expect(isExplicitWake({ source: "automation", triggerDetail: "system", reason: "goal_control" })).toBe(false);
    expect(isExplicitWake({})).toBe(false);
  });
});
