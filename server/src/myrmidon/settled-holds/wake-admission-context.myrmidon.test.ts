// myrmidon(L2, round 1 fix): recordSettledHoldWakeContext /
// readSettledHoldWakeContext — see wake-admission-context.ts.
import { describe, expect, it } from "vitest";
import { readSettledHoldWakeContext, recordSettledHoldWakeContext } from "./wake-admission-context.js";

const RUN_ID = "3f0c1d52-9d6e-4b0f-a4b0-2f6a4a1b7c01";
const OTHER_RUN_ID = "8a1e6a7c-40d5-4c1e-93f3-0d2f0b1f5e02";

describe("recordSettledHoldWakeContext / readSettledHoldWakeContext", () => {
  it("round-trips the exact classification inputs an admission used, for the run it was written for", () => {
    const contextSnapshot: Record<string, unknown> = { issueId: "issue-a" };
    recordSettledHoldWakeContext(contextSnapshot, {
      source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      commentId: null, requestedByActorType: "user",
    }, RUN_ID);

    expect(readSettledHoldWakeContext(contextSnapshot, RUN_ID)).toEqual({
      source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      commentId: null, requestedByActorType: "user",
    });
    // The rest of the context snapshot is untouched.
    expect(contextSnapshot.issueId).toBe("issue-a");
  });

  it("survives a later mutation of the run's own wakeCommentId/commentId", () => {
    // Mirrors issue-queued-comment-queue.ts's withQueuedCommentIdsInRunContext,
    // which sets these two keys when a pending comment is adopted into a
    // successor run's context after the admission decision above was made.
    const contextSnapshot: Record<string, unknown> = {};
    recordSettledHoldWakeContext(contextSnapshot, {
      source: "assignment", reason: "issue_assigned", requestedByActorType: "user", commentId: null,
    }, RUN_ID);

    contextSnapshot.wakeCommentId = "c1";
    contextSnapshot.commentId = "c1";

    // The recorded classification still reads no comment id: it is frozen
    // at admission time, not re-derived from the (now mutated) context.
    expect(readSettledHoldWakeContext(contextSnapshot, RUN_ID)?.commentId).toBeNull();
    expect(readSettledHoldWakeContext(contextSnapshot, RUN_ID)?.requestedByActorType).toBe("user");
  });

  it("is not inherited by a run that only copies the context, such as a scheduled retry", () => {
    const originalContext: Record<string, unknown> = { issueId: "issue-a" };
    recordSettledHoldWakeContext(originalContext, {
      source: "assignment", reason: "issue_assigned", requestedByActorType: "user", commentId: null,
    }, RUN_ID);

    // scheduleBoundedRetryForRun (heartbeat.ts) builds a retry's context as
    // `{ ...contextSnapshot, retryOfRunId, wakeReason, retryReason, ... }`.
    const retryContext = {
      ...originalContext,
      retryOfRunId: RUN_ID,
      wakeReason: "transient_failure_retry",
      retryReason: "transient_failure_retry",
    };

    // A retry of a run is exactly what a settled hold exists to stop: it
    // must not carry its predecessor's authorization.
    expect(readSettledHoldWakeContext(retryContext, OTHER_RUN_ID)).toBeNull();
    // The run the record was written for still reads it.
    expect(readSettledHoldWakeContext(retryContext, RUN_ID)?.requestedByActorType).toBe("user");
  });

  it("reads as absent for a run with no recorded context (created before this fix, or by another path)", () => {
    expect(readSettledHoldWakeContext({ issueId: "issue-a" }, RUN_ID)).toBeNull();
    expect(readSettledHoldWakeContext(null, RUN_ID)).toBeNull();
    expect(readSettledHoldWakeContext(undefined, RUN_ID)).toBeNull();
  });

  it("reads as absent for a malformed value under the same key", () => {
    expect(readSettledHoldWakeContext({ myrmidonSettledHoldWakeContext: "not-an-object" }, RUN_ID)).toBeNull();
    expect(readSettledHoldWakeContext({ myrmidonSettledHoldWakeContext: ["not", "an", "object"] }, RUN_ID)).toBeNull();
    // No run id recorded at all.
    expect(readSettledHoldWakeContext({
      myrmidonSettledHoldWakeContext: { requestedByActorType: "user", reason: "issue_assigned" },
    }, RUN_ID)).toBeNull();
  });

  it("normalizes an invalid requestedByActorType to null instead of trusting it", () => {
    expect(readSettledHoldWakeContext({
      myrmidonSettledHoldWakeContext: { runId: RUN_ID, requestedByActorType: "not-a-real-actor-type" },
    }, RUN_ID)).toEqual({ source: null, triggerDetail: null, reason: null, commentId: null, requestedByActorType: null });
  });
});
