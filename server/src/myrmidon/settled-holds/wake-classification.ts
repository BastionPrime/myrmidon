// myrmidon(L2): classifies a wake as explicitly authorized (a human/agent
// comment, an assignment, an on-demand/manual wake, a resume from pause, or
// an interaction wake) versus the heartbeat scheduler's own timer or an
// unattended automatic recovery/monitor sweep. See
// docs/myrmidon/DIVERGENCE.md "L2".

/**
 * Wake reasons that are explicit regardless of invocation source. A
 * reassignment or resume-from-pause wake (issue-tree-control.ts) records
 * these even when its `source` is "automation" (heartbeat.ts). The two
 * comment reasons are listed for a wake that names one without also
 * carrying a `commentId` (see `isExplicitWake` below, which excludes any
 * wake that does).
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

/**
 * `reason: "retry_failed_run"` (enqueueWakeup, heartbeat.ts) means "replay
 * this exact stopped run" — the one thing a settled no-replay disposition
 * exists to withhold, whether a person clicks retry or the scheduler
 * requests it automatically. It always records `source: "on_demand",
 * triggerDetail: "manual"` (the same shape genuine manual wakes use), so it
 * must be excluded explicitly rather than by source/triggerDetail alone.
 */
const NEVER_EXPLICIT_REASONS = new Set<string>(["retry_failed_run"]);

export interface WakeClassificationInput {
  source?: string | null;
  triggerDetail?: string | null;
  reason?: string | null;
  /**
   * The comment/message this wake carries (contextSnapshot.wakeCommentId /
   * commentId), if any. A wake that carries one already has a dedicated,
   * verified path — explicit-native-continuation.ts's admission, or the
   * durable chat/comment delivery and coalescing receipts in
   * heartbeat.ts's `enqueueWakeup` — that this module must not shortcut.
   * Only a wake with no message attached is safe to admit on classification
   * alone.
   */
  commentId?: string | null;
  /**
   * Who actually asked for this wake (`opts.requestedByActorType` in
   * `enqueueWakeup`). Round-1 fix: a reason/source shape alone is not proof
   * a person authorized anything — an unattended automatic sweep can set
   * the very same `reason` a genuine explicit wake uses (for example
   * `recovery/service.ts`'s `reconcileUnassignedBlockingIssues` and
   * `assigned_todo_liveness_dispatch` reassign and wake a task with
   * `reason: "issue_assigned"`, `requestedByActorType: "system"`, and
   * `issue-thread-interactions.ts`'s merged-PR sweep wakes with
   * `reason: "issue_commented"`, `requestedByActorType: "system"`, neither
   * with a person ever approving it). Only `"user"` bypasses; `"agent"` and
   * `"system"` never do, regardless of reason/source — see
   * docs/myrmidon/DIVERGENCE.md "L2".
   */
  requestedByActorType?: "user" | "agent" | "system" | null;
}

/**
 * True when `input` describes a wake a *person* authorized — as opposed to
 * the heartbeat scheduler's own timer, an unattended automatic recovery/
 * monitor sweep (even one that reuses an explicit wake's `reason`/`source`
 * shape), an agent acting on its own, or a retry of the exact stopped run.
 * An unrecognized reason, or a wake with no known requester, stays
 * not-explicit: the safe default keeps a settled hold blocking, the same as
 * before this module existed.
 */
export function isExplicitWake(input: WakeClassificationInput): boolean {
  if (input.commentId) return false;
  const reason = input.reason ?? "";
  if (NEVER_EXPLICIT_REASONS.has(reason)) return false;
  // Round-1 fix: gate on who asked, not just the reason/source shape. See
  // `requestedByActorType`'s own doc comment above.
  if (input.requestedByActorType !== "user") return false;
  if (EXPLICIT_WAKE_REASONS.has(reason) || reason.startsWith(APPROVAL_REASON_PREFIX)) return true;
  if (input.source === "assignment") return true;
  // "on_demand" alone is too broad: it is also this schema's default
  // invocation source (heartbeat_runs.invocation_source), so require the
  // "manual" trigger detail the board's own wake actions actually send
  // (routes/agents.ts's wakeup/heartbeat.invoke endpoints).
  return input.source === "on_demand" && input.triggerDetail === "manual";
}
