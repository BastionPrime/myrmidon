// myrmidon(L2): classifies a wake as explicitly authorized (a human/agent
// comment, an assignment, an on-demand/manual wake, a resume from pause, or
// an interaction wake) versus the heartbeat scheduler's own timer or an
// unattended automatic recovery/monitor sweep. See
// docs/myrmidon/DIVERGENCE.md "L2".

/**
 * Wake reasons that are explicit regardless of invocation source. A comment
 * (including one an accepted interaction surfaces as, e.g. a merged pull
 * request confirmation: issue-thread-interactions.ts) and a reassignment or
 * resume-from-pause wake (issue-tree-control.ts) record these even when
 * their `source` is "automation" (heartbeat.ts).
 */
const EXPLICIT_WAKE_REASONS = new Set<string>([
  "issue_commented",
  "issue_reopened_via_comment",
  "issue_assigned",
  "issue_tree_resumed",
]);

/**
 * Approval decisions (approved / rejected / revision_requested) record
 * `reason: "approval_<status>"` (routes/approvals.ts); the decision itself
 * is the explicit, human-authorized act, even though the heartbeat records
 * it under `source: "automation"`.
 */
const APPROVAL_REASON_PREFIX = "approval_";

export interface WakeClassificationInput {
  source?: string | null;
  triggerDetail?: string | null;
  reason?: string | null;
}

/**
 * True when `input` describes a wake that a person, an agent, or an
 * explicit board/API action authorized, as opposed to the heartbeat
 * scheduler's own timer or an unattended automatic recovery/monitor sweep.
 * An unrecognized reason stays not-explicit: the safe default keeps a
 * settled hold blocking, the same as before this module existed.
 */
export function isExplicitWake(input: WakeClassificationInput): boolean {
  const reason = input.reason ?? "";
  if (EXPLICIT_WAKE_REASONS.has(reason) || reason.startsWith(APPROVAL_REASON_PREFIX)) return true;
  return input.source === "assignment" || input.source === "on_demand";
}
