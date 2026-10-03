// myrmidon(STALE-BLOCK): pure liveness policy for one blocked task's reason.
// Everything here is a pure function over facts the caller reads; no SQL.

import { DEAD_BLOCKER_STATUSES, type StaleBlockReasonRef } from "./reason.js";

/** One reason a blocked task may cite, normalized for the policy. */
export interface StaleBlockReason {
  kind: "issue" | "event" | "date";
  /** For kind=issue: the blocker task id. */
  issueId: string | null;
  /** For kind=event: the gate/event key. */
  eventKey: string | null;
  /** For kind=date: the ISO due timestamp. */
  dueAt: string | null;
}

export type StaleBlockReasonDeadWhy = "blocker_done" | "blocker_cancelled" | "due_at_passed" | "event_cleared";

export type StaleBlockReasonVerdict =
  | { kind: "dead"; why: StaleBlockReasonDeadWhy }
  | { kind: "live" };

export interface StaleBlockPolicyFacts {
  /** Current status of the blocker task (kind=issue only), or `null` when the row is gone. */
  blockerStatus: string | null;
  /** Is the event/gate key of kind=event still set (still requested)? */
  eventStillSet: boolean;
  now: Date;
}

/**
 * One reason's verdict. The statuses `done` and `cancelled` are dead: `done`
 * closes the dependency, and a cancelled blocker never fires
 * `issue_blockers_resolved` (routes/issues.ts), so it would hold the task
 * forever. A date reason dies once its `dueAt` has passed. An event reason
 * dies once the gate is no longer set. Unknown facts (a missing blocker row
 * read as `undefined` by the caller) are the caller's decision, not the
 * policy's: pass `blockerStatus: null` only for a verified gone row.
 */
export function judgeStaleBlockReason(
  reason: StaleBlockReason,
  facts: StaleBlockPolicyFacts,
): StaleBlockReasonVerdict {
  if (reason.kind === "date") {
    if (reason.dueAt !== null && Date.parse(reason.dueAt) <= facts.now.getTime()) {
      return { kind: "dead", why: "due_at_passed" };
    }
    return { kind: "live" };
  }
  if (reason.kind === "event") {
    if (!facts.eventStillSet) return { kind: "dead", why: "event_cleared" };
    return { kind: "live" };
  }
  if (reason.issueId === null) return { kind: "live" };
  if (facts.blockerStatus === null) return { kind: "live" };
  if (facts.blockerStatus === "done") return { kind: "dead", why: "blocker_done" };
  if (DEAD_BLOCKER_STATUSES.has(facts.blockerStatus)) return { kind: "dead", why: "blocker_cancelled" };
  return { kind: "live" };
}

/**
 * The reasons a blocked task cites, in a stable order:
 * `reasonRef` first (the part A contract), then every `blockedByIssueIds`
 * edge that `reasonRef` did not already cover (kind=issue falls back to the
 * edges when there is no reasonRef).
 */
export function collectStaleBlockReasons(input: {
  reasonRef: StaleBlockReasonRef | null;
  blockedByIssueIds: readonly string[];
}): StaleBlockReason[] {
  const reasons: StaleBlockReason[] = [];
  if (input.reasonRef) {
    reasons.push({
      kind: input.reasonRef.kind,
      issueId: input.reasonRef.issueId ?? null,
      eventKey: input.reasonRef.eventKey ?? null,
      dueAt: input.reasonRef.dueAt ?? null,
    });
    return reasons;
  }
  for (const blockerIssueId of input.blockedByIssueIds) {
    if (blockerIssueId === "") continue;
    reasons.push({ kind: "issue", issueId: blockerIssueId, eventKey: null, dueAt: null });
  }
  return reasons;
}

/** Why a dead reason died, as stable machine text for comments and logs. */
export function describeStaleBlockReason(why: StaleBlockReasonDeadWhy): string {
  switch (why) {
    case "blocker_done": return "the blocking task is done";
    case "blocker_cancelled": return "the blocking task is cancelled";
    case "due_at_passed": return "the due date passed";
    case "event_cleared": return "the gate or event no longer applies";
  }
}
