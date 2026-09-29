// myrmidon(L4): a successful run that leaves an issue without an explicit
// disposition (`stranded_assigned_issue` / `successful_run_missing_state`,
// both only when the *last* run status is "succeeded" — a failed run is L1's
// concern) resolves by policy instead of escalating straight to an owner
// card ("Paperclip needs a disposition…" / "board decision is required").
//
// Policy, applied from the single choke point every such escalation already
// passes through (`escalateStrandedAssignedIssue` in
// `server/src/services/recovery/service.ts`):
//
//  1. Up to `MYRMIDON_STRANDED_AUTO_RETRIES_PER_DAY` (default 2) times within
//     a rolling 24h window, send the assignee a normal continuation wake that
//     explicitly asks it to record a final disposition (done / in_review /
//     blocked with a reason / todo with a reason).
//  2. Once that window's retries are used up, hand the issue to the
//     assignee's direct manager (`agents.reportsTo`) as the `in_review`
//     reviewer, if that manager exists, belongs to the same company and is
//     invokable, *and* the issue carries no execution policy of any kind, no
//     monitor state and no execution state in flight (see
//     `issueHasExistingExecutionWorkflow` below — a policy with no stages
//     still holds the trust boundary, the review preset or a monitor, a
//     monitor state keeps its own history, and a non-idle state covers a
//     repeat handoff attempt on an issue this policy already handed off
//     once). A system comment explains why. Approving the review closes the
//     issue as done; requesting changes sends it back to the original
//     assignee.
//  3. No eligible manager, or an execution workflow is already in effect —
//     fall back to the vendor's own board escalation unchanged
//     (`vendor_default`).
//
// A `paused` assignee is exempt from all of the above: pausing is not
// stranding. An auto-retry wake to a paused agent can only throw (paused is
// not invokable), and a manager handoff would take the paused agent's work
// under review over something that is not stuck. So this policy adds nothing
// of its own while the assignee is paused — no retry wake, no manager
// handoff — and the vendor's own handling of a non-invokable assignee
// applies unchanged, as it did before this policy existed
// (`vendor_default`). That handling still includes the vendor's board card
// and the `blocked` status: L4 neither suppresses them nor promises that
// anything wakes the issue after a resume. Which paths keep the vendor
// behavior for a paused assignee is recorded in `DIVERGENCE.md` (rows L3b
// and L4).
//
// The attempt count is derived from persisted heartbeat runs tagged with
// `STRANDED_AUTO_POLICY_RETRY_SOURCE`, not a separate mutable counter, so
// reprocessing the same issue on a later sweep tick naturally sees the
// updated count instead of double-counting or double-waking: see
// `countStrandedAutoPolicyAttemptsInWindow` below and its `*.myrmidon.test.ts`.
//
// `MYRMIDON_STRANDED_AUTOPOLICY_ENABLED=false` is a full kill switch back to
// the vendor's own board escalation, for incident rollback without a code
// revert (`MYRMIDON_STRANDED_AUTO_RETRIES_PER_DAY=0` alone still hands the
// issue straight to a manager when one is configured — see
// `readStrandedAutoPolicyEnabled` below).

import { randomUUID } from "node:crypto";
import { and, eq, gte, sql } from "drizzle-orm";
import { agents, heartbeatRuns, type Db } from "@paperclipai/db";
import { isAgentStatusInvokable, type IssueExecutionPolicy } from "@paperclipai/shared";
import { applyIssueExecutionPolicyTransition } from "../services/issue-execution-policy.js";

export const STRANDED_AUTO_POLICY_CAUSES = [
  "stranded_assigned_issue",
  "successful_run_missing_state",
] as const;
export type StrandedAutoPolicyCause = (typeof STRANDED_AUTO_POLICY_CAUSES)[number];

const STRANDED_AUTO_POLICY_CAUSE_SET: ReadonlySet<string> = new Set(STRANDED_AUTO_POLICY_CAUSES);

export function isStrandedAutoPolicyCause(cause: string | null | undefined): cause is StrandedAutoPolicyCause {
  return !!cause && STRANDED_AUTO_POLICY_CAUSE_SET.has(cause);
}

export const STRANDED_AUTO_POLICY_RETRY_SOURCE = "myrmidon.stranded_autopolicy_retry";

/**
 * Ties one retry wake to one specific (issue, successful source run) pair —
 * the exact event `escalateStrandedAssignedIssue` is resolving. The sweep,
 * the wake-queue module and direct heartbeat.ts callers can all reach
 * `escalateStrandedAssignedIssue` for the same stranded issue close together
 * with an identical stale `latestRun` snapshot; a caller-side existence
 * check against this key (see `findExistingStrandedAutoPolicyRetryWake` in
 * `server/src/services/recovery/service.ts`) lets a racing duplicate stand
 * down instead of queuing a second continuation wake for a disposition the
 * agent has already been asked for once. No new unique index backs this (no
 * migration): it mirrors the vendor's own un-indexed run-liveness-
 * continuation idempotency check (`run-liveness-continuations.ts`), which
 * this codebase already treats as sufficient for this class of race.
 */
export function buildStrandedAutoPolicyRetryIdempotencyKey(input: {
  issueId: string;
  sourceRunId: string;
}): string {
  return `${STRANDED_AUTO_POLICY_RETRY_SOURCE}:${input.issueId}:${input.sourceRunId}`;
}
export const STRANDED_AUTO_POLICY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const STRANDED_AUTO_POLICY_RETRIES_PER_DAY_ENV = "MYRMIDON_STRANDED_AUTO_RETRIES_PER_DAY";
export const STRANDED_AUTO_POLICY_DEFAULT_RETRIES_PER_DAY = 2;
export const STRANDED_AUTO_POLICY_ENABLED_ENV = "MYRMIDON_STRANDED_AUTOPOLICY_ENABLED";

/** Retries allowed per rolling 24h window; invalid or unset falls back to the default. */
export function readStrandedAutoRetriesPerDay(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[STRANDED_AUTO_POLICY_RETRIES_PER_DAY_ENV]?.trim();
  if (!raw) return STRANDED_AUTO_POLICY_DEFAULT_RETRIES_PER_DAY;
  if (!/^\d+$/.test(raw)) return STRANDED_AUTO_POLICY_DEFAULT_RETRIES_PER_DAY;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : STRANDED_AUTO_POLICY_DEFAULT_RETRIES_PER_DAY;
}

/**
 * Full kill switch: `false` (or `0`) restores 100% vendor board escalation
 * regardless of `MYRMIDON_STRANDED_AUTO_RETRIES_PER_DAY` or any agent's
 * configured manager. Defaults to enabled; unset or unrecognized values are
 * treated as enabled so a typo cannot silently disable the fix.
 */
export function readStrandedAutoPolicyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[STRANDED_AUTO_POLICY_ENABLED_ENV]?.trim().toLowerCase();
  return raw !== "false" && raw !== "0";
}

export type StrandedAutoPolicyDecision =
  | { kind: "retry"; attempt: number; maxAttemptsPerDay: number }
  | {
      kind: "reassign_to_manager";
      managerAgentId: string;
      attemptsInWindow: number;
      maxAttemptsPerDay: number;
    }
  | { kind: "vendor_default"; attemptsInWindow: number; maxAttemptsPerDay: number };

/**
 * Pure decision core. `attemptsInWindow` is how many auto-retries this issue
 * already used within the rolling window (see
 * `countStrandedAutoPolicyAttemptsInWindow`); calling this again after one
 * more retry lands sees an incremented count and naturally advances instead
 * of repeating — no separate idempotency flag is needed.
 */
export function decideStrandedAutoPolicy(input: {
  attemptsInWindow: number;
  maxAttemptsPerDay: number;
  managerAgentId: string | null;
  /**
   * The assignee is paused. Pausing is not stranding: an auto-retry wake to
   * a paused agent can only throw (paused is not invokable), and a manager
   * handoff would move the paused agent's work under review over something
   * that is not stuck. L4 therefore adds nothing here — the decision is the
   * vendor's own, unchanged handling of a non-invokable assignee. What that
   * handling leaves behind (a board card, `blocked`) is not decided here;
   * see `DIVERGENCE.md`.
   */
  assigneePaused?: boolean;
}): StrandedAutoPolicyDecision {
  if (input.assigneePaused) {
    return { kind: "vendor_default", attemptsInWindow: input.attemptsInWindow, maxAttemptsPerDay: input.maxAttemptsPerDay };
  }
  if (input.maxAttemptsPerDay > 0 && input.attemptsInWindow < input.maxAttemptsPerDay) {
    return { kind: "retry", attempt: input.attemptsInWindow + 1, maxAttemptsPerDay: input.maxAttemptsPerDay };
  }
  if (input.managerAgentId) {
    return {
      kind: "reassign_to_manager",
      managerAgentId: input.managerAgentId,
      attemptsInWindow: input.attemptsInWindow,
      maxAttemptsPerDay: input.maxAttemptsPerDay,
    };
  }
  return { kind: "vendor_default", attemptsInWindow: input.attemptsInWindow, maxAttemptsPerDay: input.maxAttemptsPerDay };
}

export interface StrandedAutoPolicyAssigneeRef {
  id: string;
  companyId: string;
  reportsTo: string | null;
}

export interface StrandedAutoPolicyManagerRef {
  id: string;
  companyId: string;
  status: string;
}

/** Direct-manager resolution only (`agents.reportsTo`), no ancestor walk. */
export function resolveActiveManagerAgentId(input: {
  assignee: StrandedAutoPolicyAssigneeRef;
  manager: StrandedAutoPolicyManagerRef | null;
}): string | null {
  if (!input.assignee.reportsTo || !input.manager) return null;
  if (input.manager.id !== input.assignee.reportsTo) return null;
  if (input.manager.companyId !== input.assignee.companyId) return null;
  return isAgentStatusInvokable(input.manager.status) ? input.manager.id : null;
}

export async function findActiveManagerAgentId(db: Db, assigneeAgentId: string): Promise<string | null> {
  const [assignee] = await db
    .select({ id: agents.id, companyId: agents.companyId, reportsTo: agents.reportsTo })
    .from(agents)
    .where(eq(agents.id, assigneeAgentId))
    .limit(1);
  if (!assignee?.reportsTo) return null;
  const [manager] = await db
    .select({ id: agents.id, companyId: agents.companyId, status: agents.status })
    .from(agents)
    .where(eq(agents.id, assignee.reportsTo))
    .limit(1);
  return resolveActiveManagerAgentId({ assignee, manager: manager ?? null });
}

/** Pure: counts rows already filtered to this issue/agent/source by the caller. */
export function countAttemptsSince(rows: Array<{ createdAt: Date }>, since: Date): number {
  return rows.filter((row) => row.createdAt.getTime() >= since.getTime()).length;
}

export async function countStrandedAutoPolicyAttemptsInWindow(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    agentId: string;
    now?: Date;
    windowMs?: number;
  },
): Promise<number> {
  const since = new Date((input.now ?? new Date()).getTime() - (input.windowMs ?? STRANDED_AUTO_POLICY_WINDOW_MS));
  const rows = await db
    .select({ createdAt: heartbeatRuns.createdAt })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
        sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${input.issueId}`,
        sql`${heartbeatRuns.contextSnapshot} ->> 'source' = ${STRANDED_AUTO_POLICY_RETRY_SOURCE}`,
        gte(heartbeatRuns.createdAt, since),
      ),
    );
  return countAttemptsSince(rows, since);
}

function causeLabel(cause: StrandedAutoPolicyCause): string {
  return cause === "successful_run_missing_state"
    ? "your last run on this issue ended successfully, but the issue is still `in_progress` with no recorded disposition"
    : "your last run on this issue made progress, but the issue still has no live next step";
}

export function buildStrandedAutoPolicyRetryInstruction(input: {
  cause: StrandedAutoPolicyCause;
  attempt: number;
  maxAttemptsPerDay: number;
}): string {
  return [
    `## Record a disposition (automatic retry ${input.attempt} of ${input.maxAttemptsPerDay} today)`,
    `Paperclip's automatic policy noticed that ${causeLabel(input.cause)}.`,
    "",
    "Record exactly one of the following before ending this run:",
    "1. `done` — the scope is complete.",
    "2. `in_review` with a real reviewer (a human owner or a pending approval/interaction).",
    "3. `blocked` with the blocking issue(s) or a clearly named unblock owner/action.",
    "4. `todo` with a comment naming the reason and what resumes the work.",
    "",
    `After ${input.maxAttemptsPerDay} such automatic retries within 24 hours without a disposition, this issue moves ` +
      "to your manager's review instead of staying with you.",
  ].join("\n");
}

/**
 * The retry wake's `enqueueStrandedIssueRecovery` call spreads this verbatim
 * into the queued run's `contextSnapshot` via `extraContext`. It must use the
 * exact field names `buildPaperclipWakePayload` (`server/src/services/
 * heartbeat.ts`) reads to derive `livenessContinuation` for the rendered
 * prompt — a bare `instruction` key is read nowhere and never reaches the
 * agent. Mirrors the vendor's own analogous feature
 * (`decideRunLivenessContinuation` in `server/src/services/recovery/
 * run-liveness-continuations.ts`), which sets the same field names.
 */
export function buildStrandedAutoPolicyRetryContext(input: {
  cause: StrandedAutoPolicyCause;
  attempt: number;
  maxAttemptsPerDay: number;
  sourceRunId: string;
}): Record<string, unknown> {
  return {
    livenessContinuationInstruction: buildStrandedAutoPolicyRetryInstruction({
      cause: input.cause,
      attempt: input.attempt,
      maxAttemptsPerDay: input.maxAttemptsPerDay,
    }),
    livenessContinuationState: input.cause,
    livenessContinuationAttempt: input.attempt,
    livenessContinuationMaxAttempts: input.maxAttemptsPerDay,
    livenessContinuationSourceRunId: input.sourceRunId,
  };
}

export function buildStrandedAutoPolicyManagerReviewComment(input: {
  cause: StrandedAutoPolicyCause;
  attemptsInWindow: number;
  maxAttemptsPerDay: number;
}): string {
  const attemptWord = input.attemptsInWindow === 1 ? "attempt" : "attempts";
  return [
    `Paperclip's automatic policy moved this issue to review: ${input.attemptsInWindow} automatic continuation ` +
      `${attemptWord} within 24 hours (cause \`${input.cause}\`) produced no final disposition ` +
      `(limit: ${input.maxAttemptsPerDay} per day).`,
    // myrmidon(L4): review finding — this used to say the assignment was
    // "unchanged" and would "resume once the review clears". Neither is
    // true: the manager is the issue's assignee for as long as the review is
    // pending, approving it closes the issue as done (this is a single-stage
    // policy — there is no further stage to resume into), and only
    // *requesting changes* sends it back to the original assignee.
    "The assignee's manager is now the reviewer and the issue's assignee while this is pending. Approving it " +
      "closes the issue as done; requesting changes sends it back to the original assignee to continue the work.",
  ].join("\n");
}

/**
 * True when the issue already carries an execution policy of any kind, a
 * monitor in its execution state, or an execution state that is not idle. In
 * every case the manager handoff must stand down to the vendor's own board
 * escalation.
 *
 * An execution policy is more than its review stages. `stages` may be empty
 * while the same policy still holds `authorizationPolicy` (the trust preset,
 * the low-trust boundary, the assignment policy), `reviewPreset`, `monitor` or
 * `maxReviewRounds` — the vendor keeps such a policy through
 * `normalizeIssueExecutionPolicy`, and the trust resolver and the assignment
 * authorization read those fields. `buildStrandedAutoPolicyManagerReviewPatch`
 * replaces the whole policy with a brand-new single-stage one, so on any
 * existing policy it would silently drop the trust boundary (the manager and
 * later the original assignee would then run under the standard preset) as
 * well as an owner's required approval stage.
 *
 * A non-idle execution state is a workflow already in flight: an earlier
 * handoff of this very module on a repeat stranding (its review-round counter
 * is what bounds agent/manager ping-pong before the vendor's own human
 * escalation), or a review/approval that was already started.
 *
 * An idle execution state may still hold a monitor. That happens after the
 * monitor fired or was cleared: the vendor drops the monitor from a policy
 * that has no stages, but the state keeps `{ status: "idle", monitor: {...} }`
 * with its history (`status`, `clearReason`, `clearedAt`). The handoff builds
 * its transition from an empty state, so the vendor would rebuild that
 * history from the issue's monitor columns and lose the recorded outcome (a
 * cleared monitor would read as triggered, or vanish). Any monitor in the
 * state therefore stands the handoff down as well.
 *
 * Nothing is "merged" on purpose: keeping the existing policy and only adding a
 * manager stage would still change who reviews and how the assignment moves
 * under a policy the owner set up; standing down is the conservative option.
 */
export function issueHasExistingExecutionWorkflow(issue: {
  executionPolicy?: unknown;
  executionState?: unknown;
}): boolean {
  if (issue.executionPolicy != null) return true;

  const state = issue.executionState;
  if (state && typeof state === "object") {
    const { status, monitor } = state as { status?: unknown; monitor?: unknown };
    if (typeof status === "string" && status !== "idle") return true;
    if (monitor != null) return true;
  }
  return false;
}

/**
 * True when `executionPolicy` already carries a review stage with
 * `managerAgentId` as an agent participant — the shape
 * `buildStrandedAutoPolicyManagerReviewPatch` below produces. Pure structural
 * check, deliberately tolerant of an unrelated or malformed
 * `Record<string, unknown>` (the DB column's declared type): anything that
 * doesn't look like our own review-stage shape is "no".
 */
export function issueExecutionPolicyHasManagerReviewStage(
  executionPolicy: unknown,
  managerAgentId: string,
): boolean {
  const rawStages =
    executionPolicy && typeof executionPolicy === "object"
      ? (executionPolicy as { stages?: unknown }).stages
      : undefined;
  const stages = Array.isArray(rawStages) ? rawStages : [];
  return stages.some((stage: unknown) => {
    if (!stage || typeof stage !== "object") return false;
    const typedStage = stage as { type?: unknown; participants?: unknown };
    if (typedStage.type !== "review") return false;
    const participants = Array.isArray(typedStage.participants) ? typedStage.participants : [];
    return participants.some((participant: unknown) => {
      if (!participant || typeof participant !== "object") return false;
      const typedParticipant = participant as { type?: unknown; agentId?: unknown };
      return typedParticipant.type === "agent" && typedParticipant.agentId === managerAgentId;
    });
  });
}

/**
 * Detects the one specific case where the reassign-to-manager transaction's
 * row-locked optimistic guard trips not because the handoff is unsafe, but
 * because a *racing caller already committed this exact handoff first*: the
 * row is `in_review`, the manager (not the original assignee) now owns it as
 * `assigneeAgentId` (see `applyIssueExecutionPolicyTransition`'s own review-
 * stage reassignment, which `buildStrandedAutoPolicyManagerReviewPatch`
 * relies on), and the manager is the review-stage participant. That caller
 * must stand down as a genuine no-op — return the winner's already-committed
 * row without repeating its side effects (comment/wake/activity log) — not
 * fall through to the vendor's board-escalation path, which would overwrite
 * a handoff that had already succeeded moments earlier.
 */
export function isStrandedAutoPolicyManagerHandoffAlreadyApplied(input: {
  current: { status: string; assigneeAgentId: string | null; executionPolicy: unknown };
  managerAgentId: string;
}): boolean {
  return (
    input.current.status === "in_review" &&
    input.current.assigneeAgentId === input.managerAgentId &&
    issueExecutionPolicyHasManagerReviewStage(input.current.executionPolicy, input.managerAgentId)
  );
}

/**
 * Builds the `in_review` patch that hands the issue to `managerAgentId` as a
 * single-stage reviewer, using the vendor's own execution-policy transition
 * (`applyIssueExecutionPolicyTransition`) so the result is a normal review
 * stage the rest of the product already understands.
 *
 * What each decision does (vendor semantics, pinned by DB tests): the manager
 * becomes the issue's assignee while the review is pending; *approving* the
 * only stage closes the issue as `done` with the manager still the assignee
 * (there is no further stage to return into); *requesting changes* sends it
 * back to the original assignee (the transition's `returnAssignee`) as
 * `in_progress` and counts a review round.
 *
 * The caller must not use this on an issue that already has an execution
 * policy or a non-idle execution state (`issueHasExistingExecutionWorkflow`):
 * the patch replaces the whole policy.
 */
export function buildStrandedAutoPolicyManagerReviewPatch(input: {
  issue: {
    status: string;
    assigneeAgentId: string | null;
    assigneeUserId: string | null;
    responsibleUserId?: string | null;
    createdByUserId?: string | null;
  };
  managerAgentId: string;
  cause: StrandedAutoPolicyCause;
}): Record<string, unknown> {
  const policy: IssueExecutionPolicy = {
    mode: "normal",
    commentRequired: false,
    stages: [
      {
        id: randomUUID(),
        type: "review",
        approvalsNeeded: 1,
        participants: [{ id: randomUUID(), type: "agent", agentId: input.managerAgentId, userId: null }],
      },
    ],
  };
  const transition = applyIssueExecutionPolicyTransition({
    issue: { ...input.issue, executionPolicy: null, executionState: null },
    policy,
    previousPolicy: null,
    requestedStatus: "in_review",
    requestedAssigneePatch: {},
    actor: { agentId: null, userId: null },
    reviewRequest: {
      instructions:
        `Automatic policy handoff (\`${input.cause}\`): the assignee used up its automatic continuation ` +
        "retries without recording a disposition. Approve only if the work is actually complete — that " +
        "closes the issue as done. Request changes to send it back to the original assignee with what " +
        "still needs to happen.",
    },
  });
  return { ...transition.patch, executionPolicy: policy };
}

export interface StrandedAutoPolicyManagerReviewWakeContext {
  wakeRole: "reviewer";
  stageId: string | null;
  stageType: string | null;
  currentParticipant: unknown;
  returnAssignee: unknown;
  reviewRequest: unknown;
  lastDecisionOutcome: unknown;
  allowedActions: string[];
}

/**
 * Mirrors the vendor's own `buildExecutionStageWakeContext` /
 * `buildExecutionStageWakeup` (`server/src/routes/issues.ts`) shape for a
 * pending review stage, built from the exact `executionState` this module's
 * own handoff persisted (the caller passes the freshly-updated issue row's
 * `executionState`, not a re-derivation) so it can never disagree with what
 * was actually written. Review finding: the manager's wake used to carry a
 * generic `issue_assigned` reason with no stage context at all, so the
 * agent's rendered prompt had neither a reviewer role nor the allowed
 * actions — the vendor's normal PATCH-triggered review wake always includes
 * both.
 */
export function buildStrandedAutoPolicyManagerReviewWakeContext(input: {
  executionState: Record<string, unknown>;
}): StrandedAutoPolicyManagerReviewWakeContext {
  const state = input.executionState;
  return {
    wakeRole: "reviewer",
    stageId: typeof state.currentStageId === "string" ? state.currentStageId : null,
    stageType: typeof state.currentStageType === "string" ? state.currentStageType : null,
    currentParticipant: state.currentParticipant ?? null,
    returnAssignee: state.returnAssignee ?? null,
    reviewRequest: state.reviewRequest ?? null,
    lastDecisionOutcome: state.lastDecisionOutcome ?? null,
    allowedActions: ["approve", "request_changes"],
  };
}
