import { describe, expect, it } from "vitest";
import {
  STRANDED_AUTO_POLICY_DEFAULT_RETRIES_PER_DAY,
  STRANDED_AUTO_POLICY_RETRY_SOURCE,
  buildStrandedAutoPolicyManagerReviewComment,
  buildStrandedAutoPolicyManagerReviewPatch,
  buildStrandedAutoPolicyManagerReviewWakeContext,
  buildStrandedAutoPolicyRetryContext,
  buildStrandedAutoPolicyRetryIdempotencyKey,
  buildStrandedAutoPolicyRetryInstruction,
  countAttemptsSince,
  decideStrandedAutoPolicy,
  isStrandedAutoPolicyCause,
  isStrandedAutoPolicyManagerHandoffAlreadyApplied,
  issueExecutionPolicyHasManagerReviewStage,
  issueHasExistingExecutionWorkflow,
  readStrandedAutoPolicyEnabled,
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

  it("adds nothing of its own for a paused assignee, whatever the counter and the manager", () => {
    // Pausing is not stranding: a retry wake to a paused agent can only
    // throw, and a manager handoff would take its active work under review.
    expect(
      decideStrandedAutoPolicy({
        attemptsInWindow: 0,
        maxAttemptsPerDay: 2,
        managerAgentId: "manager-1",
        assigneePaused: true,
      }),
    ).toEqual({ kind: "vendor_default", attemptsInWindow: 0, maxAttemptsPerDay: 2 });
    expect(
      decideStrandedAutoPolicy({
        attemptsInWindow: 2,
        maxAttemptsPerDay: 2,
        managerAgentId: "manager-1",
        assigneePaused: true,
      }),
    ).toEqual({ kind: "vendor_default", attemptsInWindow: 2, maxAttemptsPerDay: 2 });
    // Not paused (explicitly false or absent) keeps the normal decision.
    expect(
      decideStrandedAutoPolicy({
        attemptsInWindow: 2,
        maxAttemptsPerDay: 2,
        managerAgentId: "manager-1",
        assigneePaused: false,
      }).kind,
    ).toBe("reassign_to_manager");
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
    expect(text).toContain("retry 1 of 2");
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

  // Review finding: this comment used to claim the source assignment was
  // "unchanged" and "resumes once the review clears" — false, since
  // approving a single-stage review closes the issue as done and only
  // requesting changes returns it to the original assignee.
  it("does not claim the assignment is unchanged, and states the actual outcome of each review decision", () => {
    const text = buildStrandedAutoPolicyManagerReviewComment({
      cause: "stranded_assigned_issue",
      attemptsInWindow: 1,
      maxAttemptsPerDay: 2,
    });
    expect(text).not.toContain("unchanged");
    expect(text).not.toContain("resumes once the review clears");
    expect(text).toContain("closes the issue as done");
    expect(text).toContain("sends it back to the original assignee");
  });
});

describe("issueHasExistingExecutionWorkflow", () => {
  it("is false for an issue with no policy and no state at all", () => {
    expect(issueHasExistingExecutionWorkflow({})).toBe(false);
    expect(issueHasExistingExecutionWorkflow({ executionPolicy: null, executionState: null })).toBe(false);
  });

  it("is true when an execution policy already has configured stages, even before any stage has started", () => {
    // An owner-configured approval policy sits on the issue from creation but
    // only *runs* on a transition to in_review/done
    // (`applyIssueExecutionStageTransition`'s `shouldStartWorkflow` gate), so
    // an in-progress issue can carry a non-empty policy with a still-null
    // executionState.
    expect(
      issueHasExistingExecutionWorkflow({
        executionPolicy: { mode: "normal", commentRequired: true, stages: [{ id: "s1", type: "approval", participants: [] }] },
        executionState: null,
      }),
    ).toBe(true);
  });

  it("is false when the policy has no stages (monitor-only or empty)", () => {
    expect(
      issueHasExistingExecutionWorkflow({
        executionPolicy: { mode: "normal", commentRequired: true, stages: [] },
        executionState: null,
      }),
    ).toBe(false);
  });

  it("is true for a non-idle execution state (pending, changes_requested or completed)", () => {
    for (const status of ["pending", "changes_requested", "completed"]) {
      expect(
        issueHasExistingExecutionWorkflow({ executionPolicy: null, executionState: { status } }),
      ).toBe(true);
    }
  });

  it("is false for an idle execution state (e.g. a monitor with no review stage)", () => {
    expect(
      issueHasExistingExecutionWorkflow({ executionPolicy: null, executionState: { status: "idle", monitor: {} } }),
    ).toBe(false);
  });

  it("is true for the exact shape this module's own manager-review handoff persists — a repeat handoff must see its own earlier one", () => {
    const assigneeAgentId = "00000000-0000-4000-8000-000000000001";
    const managerAgentId = "00000000-0000-4000-8000-000000000002";
    const patch = buildStrandedAutoPolicyManagerReviewPatch({
      issue: { status: "in_progress", assigneeAgentId, assigneeUserId: null },
      managerAgentId,
      cause: "stranded_assigned_issue",
    });
    expect(
      issueHasExistingExecutionWorkflow({
        executionPolicy: patch.executionPolicy,
        executionState: patch.executionState,
      }),
    ).toBe(true);
  });
});

describe("buildStrandedAutoPolicyManagerReviewWakeContext", () => {
  it("carries the reviewer role, allowed actions and the stage fields straight off the persisted execution state", () => {
    const context = buildStrandedAutoPolicyManagerReviewWakeContext({
      executionState: {
        currentStageId: "stage-1",
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: "manager-1", userId: null },
        returnAssignee: { type: "agent", agentId: "coder-1", userId: null },
        reviewRequest: { instructions: "Approve only if actually complete." },
        lastDecisionOutcome: null,
      },
    });
    expect(context).toEqual({
      wakeRole: "reviewer",
      stageId: "stage-1",
      stageType: "review",
      currentParticipant: { type: "agent", agentId: "manager-1", userId: null },
      returnAssignee: { type: "agent", agentId: "coder-1", userId: null },
      reviewRequest: { instructions: "Approve only if actually complete." },
      lastDecisionOutcome: null,
      allowedActions: ["approve", "request_changes"],
    });
  });

  it("tolerates a missing or malformed execution state", () => {
    expect(buildStrandedAutoPolicyManagerReviewWakeContext({ executionState: {} })).toEqual({
      wakeRole: "reviewer",
      stageId: null,
      stageType: null,
      currentParticipant: null,
      returnAssignee: null,
      reviewRequest: null,
      lastDecisionOutcome: null,
      allowedActions: ["approve", "request_changes"],
    });
  });
});

describe("buildStrandedAutoPolicyManagerReviewPatch", () => {
  // The patch runs through the vendor's own execution-state schema
  // (`issueExecutionStagePrincipalSchema`), which requires `agentId` to be a
  // GUID — plain fixture ids like "agent-a" fail that validation silently
  // (`parseIssueExecutionState` returns null), so this test uses UUID-shaped
  // neutral ids instead.
  const assigneeAgentId = "00000000-0000-4000-8000-000000000001";
  const managerAgentId = "00000000-0000-4000-8000-000000000002";

  it("moves the issue to in_review with the manager as reviewer and the original assignee as the return path", () => {
    const patch = buildStrandedAutoPolicyManagerReviewPatch({
      issue: { status: "in_progress", assigneeAgentId, assigneeUserId: null },
      managerAgentId,
      cause: "successful_run_missing_state",
    });

    expect(patch.status).toBe("in_review");
    expect(patch.assigneeAgentId).toBe(managerAgentId);
    expect(patch.assigneeUserId).toBeNull();

    const executionState = patch.executionState as {
      status: string;
      currentParticipant: { type: string; agentId: string | null };
      returnAssignee: { type: string; agentId: string | null };
    };
    expect(executionState).not.toBeNull();
    expect(executionState.status).toBe("pending");
    expect(executionState.currentParticipant).toEqual({ type: "agent", agentId: managerAgentId, userId: null });
    expect(executionState.returnAssignee).toEqual({ type: "agent", agentId: assigneeAgentId, userId: null });

    const executionPolicy = patch.executionPolicy as { stages: Array<{ participants: Array<{ agentId: string | null }> }> };
    expect(executionPolicy.stages).toHaveLength(1);
    expect(executionPolicy.stages[0]?.participants[0]?.agentId).toBe(managerAgentId);

    // Review finding: the reviewRequest text used to tell the manager
    // "Approve to send the issue back to the original assignee" — the
    // opposite of what approving a single-stage review actually does
    // (closes the issue as done; only requesting changes returns it).
    const reviewRequest = (patch.executionState as { reviewRequest?: { instructions?: string } }).reviewRequest;
    expect(reviewRequest?.instructions).toContain("closes the issue as done");
    expect(reviewRequest?.instructions).not.toContain("Approve to send the issue back to the original assignee");
  });
});

describe("issueExecutionPolicyHasManagerReviewStage / isStrandedAutoPolicyManagerHandoffAlreadyApplied", () => {
  // Third-round review finding: the reassign-to-manager transaction's
  // optimistic guard used to `return null` (fall through to the vendor's
  // own board escalation) whenever the re-read row differed from the
  // caller's stale snapshot in *any* way — including the one case where
  // that difference is a racing caller having already committed this exact
  // handoff moments earlier. These two functions distinguish that specific,
  // already-safe case from a genuine conflict.
  const assigneeAgentId = "00000000-0000-4000-8000-000000000001";
  const managerAgentId = "00000000-0000-4000-8000-000000000002";
  const otherAgentId = "00000000-0000-4000-8000-000000000003";

  it("issueExecutionPolicyHasManagerReviewStage matches the exact patch shape buildStrandedAutoPolicyManagerReviewPatch produces", () => {
    const patch = buildStrandedAutoPolicyManagerReviewPatch({
      issue: { status: "in_progress", assigneeAgentId, assigneeUserId: null },
      managerAgentId,
      cause: "stranded_assigned_issue",
    });
    expect(issueExecutionPolicyHasManagerReviewStage(patch.executionPolicy, managerAgentId)).toBe(true);
    expect(issueExecutionPolicyHasManagerReviewStage(patch.executionPolicy, otherAgentId)).toBe(false);
  });

  it("issueExecutionPolicyHasManagerReviewStage tolerates a missing, null or malformed policy", () => {
    expect(issueExecutionPolicyHasManagerReviewStage(null, managerAgentId)).toBe(false);
    expect(issueExecutionPolicyHasManagerReviewStage(undefined, managerAgentId)).toBe(false);
    expect(issueExecutionPolicyHasManagerReviewStage({}, managerAgentId)).toBe(false);
    expect(issueExecutionPolicyHasManagerReviewStage({ stages: "not-an-array" }, managerAgentId)).toBe(false);
    expect(
      issueExecutionPolicyHasManagerReviewStage(
        { stages: [{ type: "review", participants: "not-an-array" }] },
        managerAgentId,
      ),
    ).toBe(false);
  });

  it("recognizes a racing caller's already-committed handoff: in_review, manager as assignee, manager as review participant", () => {
    const patch = buildStrandedAutoPolicyManagerReviewPatch({
      issue: { status: "in_progress", assigneeAgentId, assigneeUserId: null },
      managerAgentId,
      cause: "stranded_assigned_issue",
    });
    expect(
      isStrandedAutoPolicyManagerHandoffAlreadyApplied({
        current: { status: "in_review", assigneeAgentId: managerAgentId, executionPolicy: patch.executionPolicy },
        managerAgentId,
      }),
    ).toBe(true);
  });

  it("does not treat an unrelated in_review state (different reviewer, or assignee never moved to the manager) as already applied", () => {
    const patch = buildStrandedAutoPolicyManagerReviewPatch({
      issue: { status: "in_progress", assigneeAgentId, assigneeUserId: null },
      managerAgentId: otherAgentId,
      cause: "stranded_assigned_issue",
    });
    // in_review, but for a different reviewer entirely.
    expect(
      isStrandedAutoPolicyManagerHandoffAlreadyApplied({
        current: { status: "in_review", assigneeAgentId: otherAgentId, executionPolicy: patch.executionPolicy },
        managerAgentId,
      }),
    ).toBe(false);
    // in_review with the manager's id as assignee, but no matching review
    // stage (e.g. some unrelated policy shape) — not our handoff.
    expect(
      isStrandedAutoPolicyManagerHandoffAlreadyApplied({
        current: { status: "in_review", assigneeAgentId: managerAgentId, executionPolicy: null },
        managerAgentId,
      }),
    ).toBe(false);
    // Still in_progress — no handoff has happened at all yet.
    const inProgressPatch = buildStrandedAutoPolicyManagerReviewPatch({
      issue: { status: "in_progress", assigneeAgentId, assigneeUserId: null },
      managerAgentId,
      cause: "stranded_assigned_issue",
    });
    expect(
      isStrandedAutoPolicyManagerHandoffAlreadyApplied({
        current: { status: "in_progress", assigneeAgentId, executionPolicy: inProgressPatch.executionPolicy },
        managerAgentId,
      }),
    ).toBe(false);
  });
});

describe("readStrandedAutoPolicyEnabled", () => {
  it("defaults to enabled when unset, blank or unrecognized", () => {
    expect(readStrandedAutoPolicyEnabled({})).toBe(true);
    expect(readStrandedAutoPolicyEnabled({ MYRMIDON_STRANDED_AUTOPOLICY_ENABLED: "  " })).toBe(true);
    expect(readStrandedAutoPolicyEnabled({ MYRMIDON_STRANDED_AUTOPOLICY_ENABLED: "yes" })).toBe(true);
    expect(readStrandedAutoPolicyEnabled({ MYRMIDON_STRANDED_AUTOPOLICY_ENABLED: "true" })).toBe(true);
  });

  it("disables on false or 0, case-insensitively", () => {
    expect(readStrandedAutoPolicyEnabled({ MYRMIDON_STRANDED_AUTOPOLICY_ENABLED: "false" })).toBe(false);
    expect(readStrandedAutoPolicyEnabled({ MYRMIDON_STRANDED_AUTOPOLICY_ENABLED: "FALSE" })).toBe(false);
    expect(readStrandedAutoPolicyEnabled({ MYRMIDON_STRANDED_AUTOPOLICY_ENABLED: "0" })).toBe(false);
  });
});

describe("buildStrandedAutoPolicyRetryContext", () => {
  // Regression for a review finding: the retry wake's instruction was built
  // but spread under a bare `instruction` key that `buildPaperclipWakePayload`
  // (server/src/services/heartbeat.ts) never reads, so it never reached the
  // agent's rendered prompt. These are the exact field names that function
  // derives `livenessContinuation` from.
  it("uses the livenessContinuation* field names buildPaperclipWakePayload reads, not a bare instruction key", () => {
    const context = buildStrandedAutoPolicyRetryContext({
      cause: "successful_run_missing_state",
      attempt: 1,
      maxAttemptsPerDay: 2,
      sourceRunId: "run-1",
    });

    expect(context).not.toHaveProperty("instruction");
    expect(context.livenessContinuationState).toBe("successful_run_missing_state");
    expect(context.livenessContinuationAttempt).toBe(1);
    expect(context.livenessContinuationMaxAttempts).toBe(2);
    expect(context.livenessContinuationSourceRunId).toBe("run-1");
    expect(typeof context.livenessContinuationInstruction).toBe("string");
    expect(context.livenessContinuationInstruction).toContain("retry 1 of 2");
    expect(context.livenessContinuationInstruction).toBe(
      buildStrandedAutoPolicyRetryInstruction({
        cause: "successful_run_missing_state",
        attempt: 1,
        maxAttemptsPerDay: 2,
      }),
    );
  });
});

describe("buildStrandedAutoPolicyRetryIdempotencyKey", () => {
  // Review finding: two racing callers (the sweep, the wake-queue module,
  // direct heartbeat.ts callers) can reach `escalateStrandedAssignedIssue`
  // for the same stranded issue with an identical stale `latestRun`
  // snapshot; this key ties one retry wake to that one (issue, source run)
  // pair so a caller-side existence check can detect the duplicate.
  it("is stable for the same (issueId, sourceRunId) pair and namespaced under the retry source", () => {
    const key = buildStrandedAutoPolicyRetryIdempotencyKey({
      issueId: "issue-1",
      sourceRunId: "run-1",
    });
    expect(key).toBe(`${STRANDED_AUTO_POLICY_RETRY_SOURCE}:issue-1:run-1`);
    expect(
      buildStrandedAutoPolicyRetryIdempotencyKey({ issueId: "issue-1", sourceRunId: "run-1" }),
    ).toBe(key);
  });

  it("differs when the issue or the source run differs", () => {
    const base = buildStrandedAutoPolicyRetryIdempotencyKey({ issueId: "issue-1", sourceRunId: "run-1" });
    expect(
      buildStrandedAutoPolicyRetryIdempotencyKey({ issueId: "issue-2", sourceRunId: "run-1" }),
    ).not.toBe(base);
    expect(
      // A second successful run on the same issue (e.g. after a manager
      // handoff and a return to the original assignee) must get its own key,
      // not be treated as a repeat of the earlier one.
      buildStrandedAutoPolicyRetryIdempotencyKey({ issueId: "issue-1", sourceRunId: "run-2" }),
    ).not.toBe(base);
  });
});
