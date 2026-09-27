import { describe, expect, it } from "vitest";
import { decideQueuedRunStaleness, type QueuedRunFacts } from "./policy.js";
import { looksLikePendingInteractionAddresseeWake } from "../myrmidon-pending-interaction-wake.js";

const NOW = new Date("2026-09-01T00:00:00.000Z");

function facts(overrides: Partial<QueuedRunFacts> = {}): QueuedRunFacts {
  return {
    runId: "run-a",
    runAgentId: "agent-b",
    issueId: "issue-a",
    retryReasonKind: "other",
    issueFound: true,
    issueStatus: "in_progress",
    issueAssigneeAgentId: "agent-a",
    issueExecutionRunId: null,
    isResolvedInteractionContinuation: false,
    isInteractionWake: false,
    isAuthorizedSourceScopedRecovery: false,
    isNonAssigneeWorkspaceBusyRetry: false,
    resumeIntent: false,
    wakeCommentIdPresent: false,
    continuationParkApplies: false,
    continuationParksExecutor: false,
    continuationSummaryBody: null,
    wakeReason: "interaction_pending",
    retryReason: null,
    reviewParticipant: {
      isInReview: false,
      hasParticipant: false,
      participantIsAgent: false,
      participantAgentId: null,
      currentStageType: null,
      currentParticipant: null,
    },
    ...overrides,
  };
}

describe("decideQueuedRunStaleness: pending interaction addressee (P2)", () => {
  it("does not treat the addressee wake of a non-assignee as stale", () => {
    expect(decideQueuedRunStaleness(facts({ isPendingInteractionAddresseeWake: true }), NOW)).toEqual({
      stale: false,
    });
  });

  it("still cancels a non-assignee wake without the addressee signal", () => {
    expect(decideQueuedRunStaleness(facts(), NOW)).toMatchObject({
      stale: true,
      errorCode: "issue_assignee_changed",
    });
  });

  it("does not bypass a terminal issue status", () => {
    expect(
      decideQueuedRunStaleness(facts({ isPendingInteractionAddresseeWake: true, issueStatus: "done" }), NOW),
    ).toMatchObject({ stale: true, errorCode: "issue_terminal_status" });
  });
});

describe("looksLikePendingInteractionAddresseeWake", () => {
  const interactionId = "3f2b6a4e-1c7d-4e8f-9a0b-5c6d7e8f9a0b";

  it("matches the wake sent on interaction creation", () => {
    expect(
      looksLikePendingInteractionAddresseeWake({
        wakeReason: "interaction_pending",
        source: "issue.interaction.created",
        interactionId,
      }),
    ).toBe(true);
  });

  it("rejects other reasons, other sources and malformed interaction ids", () => {
    expect(
      looksLikePendingInteractionAddresseeWake({ wakeReason: "issue_commented", source: "issue.interaction.created", interactionId }),
    ).toBe(false);
    expect(
      looksLikePendingInteractionAddresseeWake({ wakeReason: "interaction_pending", source: "automation", interactionId }),
    ).toBe(false);
    expect(
      looksLikePendingInteractionAddresseeWake({
        wakeReason: "interaction_pending",
        source: "issue.interaction.created",
        interactionId: "not-a-uuid",
      }),
    ).toBe(false);
  });
});
