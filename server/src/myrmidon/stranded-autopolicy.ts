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
//     invokable. A system comment explains why.
//  3. No eligible manager — fall back to the vendor's own board escalation
//     unchanged (`vendor_default`).
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
}): StrandedAutoPolicyDecision {
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
    "The assignee's manager is now the reviewer; the source assignment is unchanged and resumes once the review clears.",
  ].join("\n");
}

/**
 * Builds the `in_review` patch that hands the issue to `managerAgentId` as a
 * single-stage reviewer, using the vendor's own execution-policy transition
 * (`applyIssueExecutionPolicyTransition`) so the result is a normal review
 * stage the rest of the product already understands: approving it returns
 * the issue to the original assignee (the transition's `returnAssignee`).
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
        "retries without recording a disposition. Approve to send the issue back to the original assignee, " +
        "or request changes / record a different disposition yourself.",
    },
  });
  return { ...transition.patch, executionPolicy: policy };
}
