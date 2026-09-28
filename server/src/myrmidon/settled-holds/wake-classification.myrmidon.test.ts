import { describe, expect, it } from "vitest";
import { isExplicitWake } from "./wake-classification.js";

describe("isExplicitWake", () => {
  it("treats a human/agent comment as explicit only when it carries no comment id of its own", () => {
    expect(isExplicitWake({ source: "automation", triggerDetail: "system", reason: "issue_commented" })).toBe(true);
    expect(isExplicitWake({ source: "on_demand", triggerDetail: "manual", reason: "issue_reopened_via_comment" })).toBe(true);
  });

  it("never treats a wake that carries a comment id as explicit, whatever else it matches", () => {
    // A real comment/message wake already has its own verified path —
    // explicit-native-continuation.ts's admission, or heartbeat.ts's
    // durable chat/comment delivery and coalescing receipts — that this
    // classifier must not shortcut.
    expect(isExplicitWake({ source: "on_demand", triggerDetail: "manual", reason: "issue_commented", commentId: "c1" })).toBe(false);
    expect(isExplicitWake({ source: "assignment", reason: "issue_assigned", commentId: "c1" })).toBe(false);
  });

  it("treats an assignment and a resumed-paused-subtree wake as explicit", () => {
    expect(isExplicitWake({ source: "assignment", triggerDetail: "system", reason: "issue_assigned" })).toBe(true);
    expect(isExplicitWake({ source: "assignment", triggerDetail: "system", reason: "issue_tree_resumed" })).toBe(true);
    // The source alone already marks it explicit, regardless of reason.
    expect(isExplicitWake({ source: "assignment", reason: null })).toBe(true);
  });

  it("treats an on-demand wake as explicit only with the \"manual\" trigger detail", () => {
    expect(isExplicitWake({ source: "on_demand", triggerDetail: "manual", reason: null })).toBe(true);
    // "on_demand" is also heartbeat_runs.invocation_source's schema default,
    // so a non-manual trigger detail (or none at all) must not qualify on
    // source alone.
    expect(isExplicitWake({ source: "on_demand", triggerDetail: "callback", reason: "some_api_wake" })).toBe(false);
    expect(isExplicitWake({ source: "on_demand", reason: null })).toBe(false);
  });

  it("treats an approval decision as explicit even under source \"automation\"", () => {
    expect(isExplicitWake({ source: "automation", triggerDetail: "system", reason: "approval_approved" })).toBe(true);
    expect(isExplicitWake({ source: "automation", triggerDetail: "system", reason: "approval_rejected" })).toBe(true);
    expect(isExplicitWake({ source: "automation", triggerDetail: "system", reason: "approval_revision_requested" })).toBe(true);
  });

  it("never treats a retry of the exact stopped run as explicit, even as an on-demand/manual wake", () => {
    expect(isExplicitWake({ source: "on_demand", triggerDetail: "manual", reason: "retry_failed_run" })).toBe(false);
  });

  it("does not treat the scheduler's timer or an unattended monitor/recovery sweep as explicit", () => {
    expect(isExplicitWake({ source: "timer", triggerDetail: "system", reason: null })).toBe(false);
    expect(isExplicitWake({ source: "automation", triggerDetail: "system", reason: "issue_monitor_recovery" })).toBe(false);
    expect(isExplicitWake({ source: "automation", triggerDetail: "system", reason: "goal_control" })).toBe(false);
    expect(isExplicitWake({})).toBe(false);
  });
});
