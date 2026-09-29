import { describe, expect, it } from "vitest";
import { isExplicitWake } from "./wake-classification.js";

describe("isExplicitWake", () => {
  it("treats a human comment as explicit only when it carries no comment id of its own", () => {
    expect(isExplicitWake({ source: "automation", triggerDetail: "system", reason: "issue_commented", requestedByActorType: "user" })).toBe(true);
    expect(isExplicitWake({ source: "on_demand", triggerDetail: "manual", reason: "issue_reopened_via_comment", requestedByActorType: "user" })).toBe(true);
  });

  it("never treats a wake that carries a comment id as explicit, whatever else it matches", () => {
    // A real comment/message wake already has its own verified path —
    // explicit-native-continuation.ts's admission, or heartbeat.ts's
    // durable chat/comment delivery and coalescing receipts — that this
    // classifier must not shortcut.
    expect(isExplicitWake({ source: "on_demand", triggerDetail: "manual", reason: "issue_commented", commentId: "c1", requestedByActorType: "user" })).toBe(false);
    expect(isExplicitWake({ source: "assignment", reason: "issue_assigned", commentId: "c1", requestedByActorType: "user" })).toBe(false);
  });

  it("treats an assignment and a resumed-paused-subtree wake as explicit", () => {
    expect(isExplicitWake({ source: "assignment", triggerDetail: "system", reason: "issue_assigned", requestedByActorType: "user" })).toBe(true);
    expect(isExplicitWake({ source: "assignment", triggerDetail: "system", reason: "issue_tree_resumed", requestedByActorType: "user" })).toBe(true);
    // The source alone already marks it explicit, regardless of reason.
    expect(isExplicitWake({ source: "assignment", reason: null, requestedByActorType: "user" })).toBe(true);
  });

  it("treats an on-demand wake as explicit only with the \"manual\" trigger detail", () => {
    expect(isExplicitWake({ source: "on_demand", triggerDetail: "manual", reason: null, requestedByActorType: "user" })).toBe(true);
    // "on_demand" is also heartbeat_runs.invocation_source's schema default,
    // so a non-manual trigger detail (or none at all) must not qualify on
    // source alone.
    expect(isExplicitWake({ source: "on_demand", triggerDetail: "callback", reason: "some_api_wake", requestedByActorType: "user" })).toBe(false);
    expect(isExplicitWake({ source: "on_demand", reason: null, requestedByActorType: "user" })).toBe(false);
  });

  it("treats an approval decision as explicit even under source \"automation\"", () => {
    // An approval decision is always recorded with requestedByActorType
    // "user" (routes/approvals.ts) — the decision itself is the human act,
    // even though the heartbeat wake it triggers has source "automation".
    expect(isExplicitWake({ source: "automation", triggerDetail: "system", reason: "approval_approved", requestedByActorType: "user" })).toBe(true);
    expect(isExplicitWake({ source: "automation", triggerDetail: "system", reason: "approval_rejected", requestedByActorType: "user" })).toBe(true);
    expect(isExplicitWake({ source: "automation", triggerDetail: "system", reason: "approval_revision_requested", requestedByActorType: "user" })).toBe(true);
  });

  it("never treats a retry of the exact stopped run as explicit, even as an on-demand/manual wake", () => {
    expect(isExplicitWake({ source: "on_demand", triggerDetail: "manual", reason: "retry_failed_run", requestedByActorType: "user" })).toBe(false);
  });

  it("does not treat the scheduler's timer or an unattended monitor/recovery sweep as explicit", () => {
    expect(isExplicitWake({ source: "timer", triggerDetail: "system", reason: null, requestedByActorType: "user" })).toBe(false);
    expect(isExplicitWake({ source: "automation", triggerDetail: "system", reason: "issue_monitor_recovery", requestedByActorType: "user" })).toBe(false);
    expect(isExplicitWake({ source: "automation", triggerDetail: "system", reason: "goal_control", requestedByActorType: "user" })).toBe(false);
    expect(isExplicitWake({})).toBe(false);
  });

  // Round-1 fix: a wake's reason/source alone is not proof a person
  // authorized it. An unattended automatic sweep sets the very same
  // "explicit" reason/source shape a genuine person-driven wake uses:
  // recovery/service.ts's `reconcileUnassignedBlockingIssues` and
  // `assigned_todo_liveness_dispatch` reassign and wake a task with reason
  // "issue_assigned", requestedByActorType "system"; issue-thread-
  // interactions.ts's merged-PR sweep wakes with reason "issue_commented",
  // requestedByActorType "system". Neither has a person ever approving it,
  // so neither may bypass a settled hold.
  it("never treats a system-actor wake as explicit, even with an otherwise-explicit reason/source", () => {
    expect(isExplicitWake({ source: "automation", triggerDetail: "system", reason: "issue_commented", requestedByActorType: "system" })).toBe(false);
    expect(isExplicitWake({ source: "automation", triggerDetail: "system", reason: "issue_assigned", requestedByActorType: "system" })).toBe(false);
    expect(isExplicitWake({ source: "assignment", triggerDetail: "system", reason: "issue_assigned", requestedByActorType: "system" })).toBe(false);
    expect(isExplicitWake({ source: "on_demand", triggerDetail: "manual", requestedByActorType: "system" })).toBe(false);
    expect(isExplicitWake({ source: "automation", triggerDetail: "system", reason: "approval_approved", requestedByActorType: "system" })).toBe(false);
  });

  it("never treats an agent-actor wake as explicit either, without an explicit owner decision to include agents", () => {
    expect(isExplicitWake({ source: "assignment", triggerDetail: "system", reason: "issue_assigned", requestedByActorType: "agent" })).toBe(false);
  });

  it("never treats a wake with no known requester as explicit", () => {
    expect(isExplicitWake({ source: "assignment", triggerDetail: "system", reason: "issue_assigned" })).toBe(false);
    expect(isExplicitWake({ source: "assignment", triggerDetail: "system", reason: "issue_assigned", requestedByActorType: null })).toBe(false);
  });
});
