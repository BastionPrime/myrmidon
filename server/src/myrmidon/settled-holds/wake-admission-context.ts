// myrmidon(L2, round 1 fix): freezes the exact wake-classification inputs an
// admission (enqueueWakeup, heartbeat.ts) used, onto the successor run's own
// context snapshot, so a later reader of *that same run* — its own first
// claim, or a scheduled retry that inherits its context wholesale
// (scheduleBoundedRetryForRun spreads the failed run's contextSnapshot) —
// reclassifies from the same frozen inputs instead of re-deriving them from
// a context a same-transaction comment adoption
// (issue-queued-comment-queue.ts's withQueuedCommentIdsInRunContext) or a
// later retry's own wake reason has since changed. Without this,
// `decideCurrentRunStaleness` (run-dispatch/adapters/postgres.ts) recomputes
// `isExplicitWake` from `run.invocationSource`/`triggerDetail` and
// `contextSnapshot.wakeReason`/commentId at claim time — fields the very
// same transaction can mutate between the admission decision and the first
// claim. See wake-classification.ts and docs/myrmidon/DIVERGENCE.md "L2".
//
// The record is bound to the id of the one run it was written for. A later
// run that merely inherits the context (a scheduled retry spreads the failed
// run's snapshot wholesale) is a *different* run and must never inherit the
// authorization: a retry of a run is exactly what a settled hold exists to
// stop, so it has to be classified from its own (non-explicit) wake, not
// from its predecessor's.
import type { WakeClassificationInput } from "./wake-classification.js";

const CONTEXT_KEY = "myrmidonSettledHoldWakeContext";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readActorType(value: unknown): "user" | "agent" | "system" | null {
  return value === "user" || value === "agent" || value === "system" ? value : null;
}

/**
 * Records the exact inputs `isExplicitWake` classified this wake with onto
 * `contextSnapshot`, mutating it in place — matching this module's own
 * style of building up a run's context snapshot incrementally
 * (`enrichedContextSnapshot.previousRunId = …`, etc.). Call once per
 * admission, with the id of the run that context is about to be inserted
 * for, before any later step (pending-comment adoption) can change the
 * wake's own commentId.
 */
export function recordSettledHoldWakeContext(
  contextSnapshot: Record<string, unknown>,
  wake: WakeClassificationInput,
  runId: string,
): void {
  contextSnapshot[CONTEXT_KEY] = {
    runId,
    source: wake.source ?? null,
    triggerDetail: wake.triggerDetail ?? null,
    reason: wake.reason ?? null,
    commentId: wake.commentId ?? null,
    requestedByActorType: wake.requestedByActorType ?? null,
  };
}

/**
 * Reads back the classification recorded for `runId`, if that run's context
 * snapshot carries one (a well-formed object under `CONTEXT_KEY`). Any other
 * shape reads as absent, and so does a record written for a different run:
 * one left over from a run created before this fix, by a path other than
 * `enqueueWakeup`, or inherited by a successor that spread its
 * predecessor's context (a scheduled retry). Returns null in every such case
 * so the caller falls back to its own derivation from the run row, which
 * carries no requester and therefore never bypasses a hold.
 */
export function readSettledHoldWakeContext(
  contextSnapshot: unknown,
  runId: string,
): WakeClassificationInput | null {
  const raw = record(contextSnapshot)[CONTEXT_KEY];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (readNonEmptyString(value.runId) !== runId) return null;
  return {
    source: readNonEmptyString(value.source),
    triggerDetail: readNonEmptyString(value.triggerDetail),
    reason: readNonEmptyString(value.reason),
    commentId: readNonEmptyString(value.commentId),
    requestedByActorType: readActorType(value.requestedByActorType),
  };
}
