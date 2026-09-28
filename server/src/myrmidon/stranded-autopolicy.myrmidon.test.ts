import { describe, expect, it } from "vitest";
import {
  STRANDED_AUTO_POLICY_DEFAULT_RETRIES_PER_DAY,
  buildStrandedAutoPolicyManagerReviewComment,
  buildStrandedAutoPolicyManagerReviewPatch,
  buildStrandedAutoPolicyRetryInstruction,
  countAttemptsSince,
  decideStrandedAutoPolicy,
  isStrandedAutoPolicyCause,
  readStrandedAutoRetriesPerDay,
  resolveActiveManagerAgentId,
} from "./stranded-autopolicy.js";

describe("isStrandedAutoPolicyCause", () => {
  it("accepts only the two in-scope causes", () => {
    expect(isStrandedAutoPolicyCause("stranded_assigned_issue")).toBe(true);
    expect(isStrandedAutoPolicyCause("successful_run_missing_state")).toBe(true);
    expect(isStrandedAutoPolicyCause("process_lost")).toBe(false);
    expect(isStrandedAutoPolicyCause("workspace_validation_failed")).toBe(false);
    expect(isStrandedAutoPolicyCause(null)).toBe(false);
    expect(isStrandedAutoPolicyCause(undefined)).toBe(false);
  });
});

describe("readStrandedAutoRetriesPerDay", () => {
  it("defaults to 2 when unset, blank or invalid", () => {
    expect(STRANDED_AUTO_POLICY_DEFAULT_RETRIES_PER_DAY).toBe(2);
    expect(readStrandedAutoRetriesPerDay({})).toBe(2);
    expect(readStrandedAutoRetriesPerDay({ MYRMIDON_STRANDED_AUTO_RETRIES_PER_DAY: "  " })).toBe(2);
    expect(readStrandedAutoRetriesPerDay({ MYRMIDON_STRANDED_AUTO_RETRIES_PER_DAY: "-1" })).toBe(2);
    expect(readStrandedAutoRetriesPerDay({ MYRMIDON_STRANDED_AUTO_RETRIES_PER_DAY: "2.5" })).toBe(2);
    expect(readStrandedAutoRetriesPerDay({ MYRMIDON_STRANDED_AUTO_RETRIES_PER_DAY: "abc" })).toBe(2);
  });

  it("reads a configured non-negative integer, including zero", () => {
    expect(readStrandedAutoRetriesPerDay({ MYRMIDON_STRANDED_AUTO_RETRIES_PER_DAY: "5" })).toBe(5);
    expect(readStrandedAutoRetriesPerDay({ MYRMIDON_STRANDED_AUTO_RETRIES_PER_DAY: "0" })).toBe(0);
  });
});

describe("countAttemptsSince (24h window counter)", () => {
  const now = new Date("2026-09-28T12:00:00.000Z");
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  it("excludes rows older than the window and counts rows inside it", () => {
    const rows = [
      { createdAt: new Date("2026-09-27T11:00:00.000Z") }, // 1h before the window opens
      { createdAt: new Date("2026-09-27T13:00:00.000Z") }, // inside the window
      { createdAt: new Date("2026-09-28T11:00:00.000Z") }, // inside the window
    ];
    expect(countAttemptsSince(rows, since)).toBe(2);
  });

  it("includes a row exactly at the window boundary", () => {
    expect(countAttemptsSince([{ createdAt: since }], since)).toBe(1);
  });

  it("is a pure recount: calling it again after one more row lands advances by exactly one", () => {
    const rows = [{ createdAt: new Date("2026-09-28T10:00:00.000Z") }];
    const firstCount = countAttemptsSince(rows, since);
    expect(firstCount).toBe(1);

    // Simulates the next sweep tick observing the just-persisted retry run:
    // the recount reflects it once, not twice — no separate counter to drift.
    const rowsAfterOneMoreRetry = [...rows, { createdAt: new Date("2026-09-28T11:30:00.000Z") }];
    expect(countAttemptsSince(rowsAfterOneMoreRetry, since)).toBe(firstCount + 1);
    // Re-running the same recount against the same snapshot is idempotent.
    expect(countAttemptsSince(rowsAfterOneMoreRetry, since)).toBe(countAttemptsSince(rowsAfterOneMoreRetry, since));
  });
});

describe("decideStrandedAutoPolicy", () => {
  it("retries while attempts remain under the daily cap", () => {
    const decision = decideStrandedAutoPolicy({
      attemptsInWindow: 0,
      maxAttemptsPerDay: 2,
      managerAgentId: "manager-1",
    });
    expect(decision).toEqual({ kind: "retry", attempt: 1, maxAttemptsPerDay: 2 });

    const secondAttempt = decideStrandedAutoPolicy({
      attemptsInWindow: 1,
      maxAttemptsPerDay: 2,
      managerAgentId: "manager-1",
    });
    expect(secondAttempt).toEqual({ kind: "retry", attempt: 2, maxAttemptsPerDay: 2 });
  });

  it("hands off to the manager once the cap is reached and a manager exists", () => {
    const decision = decideStrandedAutoPolicy({
      attemptsInWindow: 2,
      maxAttemptsPerDay: 2,
      managerAgentId: "manager-1",
    });
    expect(decision).toEqual({
      kind: "reassign_to_manager",
      managerAgentId: "manager-1",
      attemptsInWindow: 2,
      maxAttemptsPerDay: 2,
    });
  });

  it("falls back to the vendor's own escalation once the cap is reached with no manager", () => {
    const decision = decideStrandedAutoPolicy({
      attemptsInWindow: 2,
      maxAttemptsPerDay: 2,
      managerAgentId: null,
    });
    expect(decision).toEqual({
      kind: "vendor_default",
      attemptsInWindow: 2,
      maxAttemptsPerDay: 2,
    });
  });

  it("treats a zero cap as no automatic retries at all", () => {
    expect(
      decideStrandedAutoPolicy({ attemptsInWindow: 0, maxAttemptsPerDay: 0, managerAgentId: "manager-1" }),
    ).toEqual({
      kind: "reassign_to_manager",
      managerAgentId: "manager-1",
      attemptsInWindow: 0,
      maxAttemptsPerDay: 0,
    });
  });
});

describe("resolveActiveManagerAgentId", () => {
  const assignee = { id: "agent-a", companyId: "company-a", reportsTo: "agent-b" };

  it("resolves the direct manager when active and in the same company", () => {
    const managerAgentId = resolveActiveManagerAgentId({
      assignee,
      manager: { id: "agent-b", companyId: "company-a", status: "idle" },
    });
    expect(managerAgentId).toBe("agent-b");
  });

  it("returns null when there is no manager (no reportsTo, or the row is missing)", () => {
    expect(resolveActiveManagerAgentId({ assignee: { ...assignee, reportsTo: null }, manager: null })).toBeNull();
    expect(resolveActiveManagerAgentId({ assignee, manager: null })).toBeNull();
  });

  it("returns null when the manager is paused, terminated or pending approval", () => {
    for (const status of ["paused", "terminated", "pending_approval"]) {
      expect(
        resolveActiveManagerAgentId({ assignee, manager: { id: "agent-b", companyId: "company-a", status } }),
      ).toBeNull();
    }
  });

  it("returns null on a company or identity mismatch", () => {
    expect(
      resolveActiveManagerAgentId({
        assignee,
        manager: { id: "agent-b", companyId: "company-b", status: "idle" },
      }),
    ).toBeNull();
    expect(
      resolveActiveManagerAgentId({
        assignee,
        manager: { id: "agent-c", companyId: "company-a", status: "idle" },
      }),
    ).toBeNull();
  });
});

describe("buildStrandedAutoPolicyRetryInstruction / buildStrandedAutoPolicyManagerReviewComment", () => {
  it("names the attempt count and the daily cap in the retry instruction", () => {
    const text = buildStrandedAutoPolicyRetryInstruction({
      cause: "successful_run_missing_state",
      attempt: 1,
      maxAttemptsPerDay: 2,
    });
    expect(text).toContain("attempt 1 of 2");
    expect(text).toContain("`done`");
    expect(text).toContain("`in_review`");
    expect(text).toContain("`blocked`");
    expect(text).toContain("`todo`");
  });

  it("names the cause and attempt count in the manager review comment", () => {
    const text = buildStrandedAutoPolicyManagerReviewComment({
      cause: "stranded_assigned_issue",
      attemptsInWindow: 2,
      maxAttemptsPerDay: 2,
    });
    expect(text).toContain("stranded_assigned_issue");
    expect(text).toContain("2 automatic continuation attempts");
  });
});

describe("buildStrandedAutoPolicyManagerReviewPatch", () => {
  it("moves the issue to in_review with the manager as reviewer and the original assignee as the return path", () => {
    const patch = buildStrandedAutoPolicyManagerReviewPatch({
      issue: { status: "in_progress", assigneeAgentId: "agent-a", assigneeUserId: null },
      managerAgentId: "agent-b",
      cause: "successful_run_missing_state",
    });

    expect(patch.status).toBe("in_review");
    expect(patch.assigneeAgentId).toBe("agent-b");
    expect(patch.assigneeUserId).toBeNull();

    const executionState = patch.executionState as {
      status: string;
      currentParticipant: { type: string; agentId: string | null };
      returnAssignee: { type: string; agentId: string | null };
    };
    expect(executionState.status).toBe("pending");
    expect(executionState.currentParticipant).toEqual({ type: "agent", agentId: "agent-b", userId: null });
    expect(executionState.returnAssignee).toEqual({ type: "agent", agentId: "agent-a", userId: null });

    const executionPolicy = patch.executionPolicy as { stages: Array<{ participants: Array<{ agentId: string | null }> }> };
    expect(executionPolicy.stages).toHaveLength(1);
    expect(executionPolicy.stages[0]?.participants[0]?.agentId).toBe("agent-b");
  });
});
