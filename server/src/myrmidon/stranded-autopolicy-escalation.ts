// myrmidon(L4): escalation-side counterpart of stranded-autopolicy.ts.
//
// Why this file exists (L4-extract, plan 1.1.2 item 14): the L4 policy used
// to live as a ~370-line inline block inside the vendor file
// `server/src/services/recovery/service.ts` (the gate at the top of
// `escalateStrandedAssignedIssue` plus the retry and manager-review
// branches, a dozen `myrmidon(L4)` markers). Every weekly vendor merge
// therefore met a large hand-maintained conflict surface in a hot file, and
// each touch of that block risked vendor behavior for everyone. This module
// is the fork's own territory: the policy's escalation logic now lives
// here, and the vendor file keeps only the single call site (plus the small
// idempotency-key plumbing the retry branch's caller needs) that hands over
// and either receives the resolved issue row (the policy handled it) or a
// `handled: false` meaning "not handled — continue with the vendor path
// below".
//
// What moved here, verbatim in behavior:
//  - the L4 gate (cause in scope, last run `succeeded`, `in_progress`,
//    assignee present, not plugin-managed, policy enabled);
//  - the auto-retry branch: idempotency-key duplicate detection, the
//    guarded `enqueueStrandedIssueRecovery` call, the activity-log row;
//  - the manager-review branch: the row-locked optimistic-guard
//    transaction with `issueHasExistingExecutionWorkflow` /
//    `isStrandedAutoPolicyManagerHandoffAlreadyApplied`, the explanatory
//    comment, the reviewer wake with `executionStage` context, and the
//    activity-log row.
//
// One deliberate behavior addition (same plan item, "blocked by children"
// rule): when the cause is `successful_run_missing_state` and the issue has
// visible open children (not done/cancelled), the policy does NOT retry-wake
// the assignee or hand the issue to a manager. A parent whose last
// successful run delegated work to children is waiting, not stranded: the
// children's own lifecycle (and the vendor's blockers-resolved wake when
// they close) is the live next step, and nagging the parent for a
// "disposition" it cannot validly record produces exactly the red cards
// this policy exists to prevent. Instead the issue is moved to `blocked`
// with the open children recorded as `blockedByIssueIds` (merged with any
// existing unresolved blockers) — the same "waiting on dependencies"
// disposition the vendor's `resolveContinuationWaitingOnReview` and
// `reconcileSourceScopedRecoveryActions` already produce, so the parent
// resumes automatically when the children finish. The vendor path is left
// untouched for every other cause (a plain `stranded_assigned_issue`
// parent without children is still just stranded).
//
// The vendor's own semantics are preserved exactly:
//  - a duplicate retry wake or a racing already-applied manager handoff
//    stands down as a no-op and returns the current row;
//  - a paused assignee yields `vendor_default` (see stranded-autopolicy.ts);
//  - all throws are guarded exactly as before, so no L4 path can abort the
//    `reconcileStrandedAssignedIssues` sweep tick;
//  - the module is instantiated once per `recoveryService` instance with
//    injected dependencies, so it holds no global state and the vendor file
//    never needs to import anything but this entry point.

import { and, eq } from "drizzle-orm";
import type { agents, Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import type {
  IssueCommentAuthorType,
  IssueCommentPresentation,
  IssueCommentMetadata,
} from "@paperclipai/shared";
import {
  isPluginManagedIssueLifecycle,
  SUCCESSFUL_RUN_MISSING_STATE_REASON,
} from "../services/recovery/successful-run-handoff.js";
import { logger } from "../middleware/logger.js";
import type { LogActivityInput } from "../services/activity-log.js";
import {
  buildStrandedAutoPolicyManagerReviewComment,
  buildStrandedAutoPolicyManagerReviewPatch,
  buildStrandedAutoPolicyManagerReviewWakeContext,
  buildStrandedAutoPolicyRetryContext,
  buildStrandedAutoPolicyRetryIdempotencyKey,
  countStrandedAutoPolicyAttemptsInWindow,
  decideStrandedAutoPolicy,
  findActiveManagerAgentId,
  isStrandedAutoPolicyCause,
  isStrandedAutoPolicyManagerHandoffAlreadyApplied,
  issueHasExistingExecutionWorkflow,
  readStrandedAutoPolicyEnabled,
  readStrandedAutoRetriesPerDay,
  STRANDED_AUTO_POLICY_RETRY_SOURCE,
  type StrandedAutoPolicyCause,
} from "./stranded-autopolicy.js";

/** Short structural type of the vendor `issues` row this module works on. */
type IssueRow = typeof issues.$inferSelect;

export interface StrandedAutopolicyDeps {
  /** Vendor `issueService(db)` — update/addComment, transaction-aware. */
  issuesSvc: {
    update: (
      id: string,
      data: Partial<typeof issues.$inferInsert> & Record<string, unknown>,
      dbOrTx?: unknown,
    ) => Promise<IssueRow | null>;
    addComment: (
      issueId: string,
      body: string,
      actor: {
        agentId?: string;
        userId?: string;
        runId?: string | null;
        onBehalfOfUserId?: string | null;
      },
      options?: {
        authorType?: IssueCommentAuthorType | null;
        presentation?: IssueCommentPresentation | null;
        metadata?: IssueCommentMetadata | null;
      },
      dbOrTx?: unknown,
    ) => Promise<unknown>;
  };
  /** Vendor `recoveryService` wake enqueue — throws on non-invokable agents. */
  enqueueWakeup: (
    agentId: string,
    opts?: {
      source?: "timer" | "assignment" | "on_demand" | "automation";
      triggerDetail?: "manual" | "ping" | "callback" | "system";
      reason?: string | null;
      payload?: Record<string, unknown> | null;
      idempotencyKey?: string | null;
      requestedByActorType?: "user" | "agent" | "system";
      requestedByActorId?: string | null;
      contextSnapshot?: Record<string, unknown>;
    },
  ) => Promise<unknown>;
  /** `recoveryService`'s own guarded recovery-queue enqueue. */
  enqueueStrandedIssueRecovery: (input: {
    issueId: string;
    agentId: string;
    reason: "issue_assignment_recovery" | "issue_continuation_needed" | string;
    retryReason: "assignment_recovery" | "issue_continuation_needed" | string;
    source: string;
    retryOfRunId?: string | null;
    extraContext?: Record<string, unknown>;
    idempotencyKey?: string | null;
  }) => Promise<unknown>;
  /** `recoveryService`'s idempotency pre-check over wakeup requests. */
  findExistingStrandedAutoPolicyRetryWake: (input: {
    companyId: string;
    idempotencyKey: string;
  }) => Promise<{ id: string } | null>;
  /** `recoveryService`'s agent lookup (`select().from(agents)`). */
  getAgent: (agentId: string) => Promise<typeof agents.$inferSelect | null>;
  /** Open (visible, not done/cancelled) children of the issue. */
  openChildIssues: (issue: IssueRow) => Promise<Array<{ id: string; identifier: string | null }>>;
  /** Unresolved first-class blocker ids already on the issue. */
  existingUnresolvedBlockerIssueIds: (
    companyId: string,
    issueId: string,
  ) => Promise<string[]>;
  /** Vendor activity log writer. */
  logActivity: (db: Db, input: LogActivityInput) => Promise<unknown>;
  /** Vendor notice-metadata/presentation helpers (recovery/service.ts). */
  recoveryNoticeMetadata: (input: {
    cause: string;
    latestRun: { id: string; status: string } | null;
    previousStatus: string;
    recoveryOwner?: { id: string; name: string } | null;
  }) => IssueCommentMetadata;
  compactRecoveryPresentation: (title: string) => IssueCommentPresentation;
  /** Vendor recovery-context annotator (`status-only-context.ts`). */
  withRecoveryContext: (
    context: Record<string, unknown>,
    trust: "normal_model",
  ) => Record<string, unknown>;
}

export type StrandedAutopolicyOutcome =
  | { handled: true; issue: IssueRow; action: "retry" | "reassign_to_manager" | "blocked_by_children" }
  | { handled: false };

export function strandedAutopolicyEscalation(db: Db, deps: StrandedAutopolicyDeps) {
  const {
    issuesSvc,
    enqueueWakeup,
    enqueueStrandedIssueRecovery,
    findExistingStrandedAutoPolicyRetryWake,
    getAgent,
    openChildIssues,
    existingUnresolvedBlockerIssueIds,
    logActivity,
    recoveryNoticeMetadata,
    compactRecoveryPresentation,
    withRecoveryContext,
  } = deps;

  async function blockedByChildren(input: {
    issue: IssueRow;
    children: Array<{ id: string; identifier: string | null }>;
    latestRun: { id: string; status: string };
  }): Promise<IssueRow | null> {
    const blockerIds = await existingUnresolvedBlockerIssueIds(
      input.issue.companyId,
      input.issue.id,
    );
    const updated = await issuesSvc.update(input.issue.id, {
      status: "blocked",
      blockedByIssueIds: [
        ...new Set([
          ...blockerIds,
          ...input.children.map((child) => child.id),
        ]),
      ],
    });
    if (!updated) return null;
    const childLinks = input.children
      .map((child) => {
        if (!child.identifier) return child.id;
        const prefix = child.identifier.split("-")[0] || "PAP";
        return `[${child.identifier}](/${prefix}/issues/${child.identifier})`;
      })
      .join(", ");
    await issuesSvc.addComment(
      input.issue.id,
      [
        `This task is waiting on ${childLinks} to finish. It will continue automatically when that work is done.`,
        "",
        "A previous run completed successfully, but the scope is not finished: the remaining work lives in the child issues listed above. " +
          "The task was moved to `blocked` on those children instead of being flagged as stuck, so it resumes when they close.",
      ].join("\n"),
      {},
      {
        authorType: "system",
        presentation: compactRecoveryPresentation("Recovery: waiting on child issues — moved to blocked"),
        metadata: recoveryNoticeMetadata({
          cause: SUCCESSFUL_RUN_MISSING_STATE_REASON,
          latestRun: input.latestRun,
          previousStatus: input.issue.status,
        }),
      },
    );
    await logActivity(db, {
      companyId: input.issue.companyId,
      actorType: "system",
      actorId: "system",
      agentId: null,
      runId: input.latestRun.id,
      action: "issue.updated",
      entityType: "issue",
      entityId: input.issue.id,
      details: {
        identifier: input.issue.identifier,
        status: "blocked",
        previousStatus: input.issue.status,
        source: "recovery.stranded_autopolicy_blocked_by_children",
        blockedByIssueIds: input.children.map((child) => child.id),
      },
    });
    return updated;
  }

  /**
   * The single L4 entry point the vendor file calls. Returns `handled: false`
   * for every case the policy does not own (cause out of scope, failed run,
   * paused assignee, no manager, guards tripped) so the caller continues
   * with the vendor's own escalation below, exactly as before the extract.
   */
  async function run(input: {
    issue: IssueRow;
    previousStatus: string;
    latestRun: { id: string; agentId: string; status: string } | null;
    recoveryCause: string;
  }): Promise<StrandedAutopolicyOutcome> {
    const { issue, latestRun } = input;
    const recoveryCause = input.recoveryCause;

    if (
      !readStrandedAutoPolicyEnabled() ||
      latestRun?.status !== "succeeded" ||
      !isStrandedAutoPolicyCause(recoveryCause) ||
      (input.previousStatus !== "in_progress" && issue.status !== "in_progress") ||
      !issue.assigneeAgentId ||
      isPluginManagedIssueLifecycle(issue)
    ) {
      return { handled: false };
    }
    // Narrowed by isStrandedAutoPolicyCause above.
    const cause: StrandedAutoPolicyCause = recoveryCause;

    // "Blocked by children": a successful run that delegated the remaining
    // work to open child issues is a dependency wait, not a missing
    // disposition. Only `successful_run_missing_state` (the handoff
    // exhaust path) qualifies — `stranded_assigned_issue` stays on the
    // vendor path (see module header).
    if (recoveryCause === SUCCESSFUL_RUN_MISSING_STATE_REASON) {
      const children = await openChildIssues(issue);
      if (children.length > 0) {
        const updated = await blockedByChildren({ issue, children, latestRun });
        if (updated) {
          return { handled: true, issue: updated, action: "blocked_by_children" };
        }
        return { handled: false };
      }
    }

    const assigneeAgentId = issue.assigneeAgentId;
    const maxAttemptsPerDay = readStrandedAutoRetriesPerDay();
    const [attemptsInWindow, managerAgentId, assigneeAgent] = await Promise.all([
      countStrandedAutoPolicyAttemptsInWindow(db, {
        companyId: issue.companyId,
        issueId: issue.id,
        agentId: assigneeAgentId,
      }),
      findActiveManagerAgentId(db, assigneeAgentId),
      getAgent(assigneeAgentId),
    ]);

    const assigneePaused =
      assigneeAgent?.companyId === issue.companyId && assigneeAgent.status === "paused";
    const autoPolicyDecision = decideStrandedAutoPolicy({
      attemptsInWindow,
      maxAttemptsPerDay,
      managerAgentId,
      assigneePaused,
    });

    if (autoPolicyDecision.kind === "retry") {
      const retryIdempotencyKey = buildStrandedAutoPolicyRetryIdempotencyKey({
        issueId: issue.id,
        sourceRunId: latestRun.id,
      });
      // Typed `{ id: string } | null` explicitly (not the injected
      // helper's own return type): same reasoning as before the extract —
      // `rows[0] ?? null` collapses to non-null under this project's TS
      // settings, which would reject the `= null` reset below.
      let existingRetryWake: { id: string } | null = null;
      try {
        existingRetryWake = await findExistingStrandedAutoPolicyRetryWake({
          companyId: issue.companyId,
          idempotencyKey: retryIdempotencyKey,
        });
      } catch {
        existingRetryWake = null;
      }
      if (existingRetryWake) {
        // A racing caller already queued this exact continuation wake —
        // stand down as a genuine no-op (returns the issue row so the
        // sweep records it, not as a fall-through to board escalation).
        return { handled: true, issue, action: "retry" };
      }
      let queued: unknown = null;
      try {
        queued = await enqueueStrandedIssueRecovery({
          issueId: issue.id,
          agentId: assigneeAgentId,
          reason: "issue_continuation_needed",
          retryReason: "issue_continuation_needed",
          source: STRANDED_AUTO_POLICY_RETRY_SOURCE,
          retryOfRunId: latestRun.id,
          idempotencyKey: retryIdempotencyKey,
          extraContext: buildStrandedAutoPolicyRetryContext({
            cause,
            attempt: autoPolicyDecision.attempt,
            maxAttemptsPerDay: autoPolicyDecision.maxAttemptsPerDay,
            sourceRunId: latestRun.id,
          }),
        });
      } catch {
        queued = null;
      }
      if (queued) {
        await logActivity(db, {
          companyId: issue.companyId,
          actorType: "system",
          actorId: "system",
          agentId: null,
          runId: latestRun.id,
          action: "issue.stranded_autopolicy_retried",
          entityType: "issue",
          entityId: issue.id,
          details: {
            identifier: issue.identifier,
            recoveryCause,
            attempt: autoPolicyDecision.attempt,
            maxAttemptsPerDay: autoPolicyDecision.maxAttemptsPerDay,
          },
        });
        return { handled: true, issue, action: "retry" };
      }
      // The guarded enqueue genuinely declined — fall through to the
      // vendor's own board escalation below, same as before the extract.
      return { handled: false };
    }

    if (autoPolicyDecision.kind === "reassign_to_manager") {
      // The vendor's `issuesSvc.update` throws (not a falsy return) when the
      // issue's assignee is locked; the row lock serializes concurrent
      // handoffs and lets a racing caller that already committed this exact
      // handoff stand down as a no-op instead of repeating its side effects.
      let updated: IssueRow | null = null;
      let alreadyHandedOffByRacingCaller: IssueRow | null = null;
      if (!issue.conversationAgentId) {
        const patch = buildStrandedAutoPolicyManagerReviewPatch({
          issue,
          managerAgentId: autoPolicyDecision.managerAgentId,
          cause,
        });
        try {
          const result = await db.transaction(async (tx) => {
            // Row lock: serializes concurrent manager handoffs for this
            // issue; see the module header. The `current` row is read under
            // the lock, so a policy installed in the narrow window since
            // this function's own read is still caught below.
            const [current] = await tx
              .select()
              .from(issues)
              .where(
                and(
                  eq(issues.id, issue.id),
                  eq(issues.companyId, issue.companyId),
                ),
              )
              .for("update")
              .limit(1);
            if (!current) {
              return { outcome: "blocked" as const };
            }
            if (
              current.status === issue.status &&
              current.assigneeAgentId === issue.assigneeAgentId
            ) {
              if (issueHasExistingExecutionWorkflow(current)) {
                return { outcome: "blocked" as const };
              }
              const applied = await issuesSvc.update(
                issue.id,
                patch as Partial<typeof issues.$inferInsert>,
                tx,
              );
              return applied
                ? { outcome: "applied" as const, issue: applied }
                : { outcome: "blocked" as const };
            }
            if (
              isStrandedAutoPolicyManagerHandoffAlreadyApplied({
                current: {
                  status: current.status,
                  assigneeAgentId: current.assigneeAgentId,
                  executionPolicy: current.executionPolicy,
                },
                managerAgentId: autoPolicyDecision.managerAgentId,
              })
            ) {
              return { outcome: "already_applied" as const, issue: current };
            }
            return { outcome: "blocked" as const };
          });
          if (result.outcome === "applied") {
            updated = result.issue;
          } else if (result.outcome === "already_applied") {
            alreadyHandedOffByRacingCaller = result.issue;
          }
        } catch {
          updated = null;
        }
      }
      if (alreadyHandedOffByRacingCaller) {
        return { handled: true, issue: alreadyHandedOffByRacingCaller, action: "reassign_to_manager" };
      }
      if (updated) {
        const managerAgent = await getAgent(autoPolicyDecision.managerAgentId);
        await issuesSvc.addComment(
          issue.id,
          buildStrandedAutoPolicyManagerReviewComment({
            cause,
            attemptsInWindow: autoPolicyDecision.attemptsInWindow,
            maxAttemptsPerDay: autoPolicyDecision.maxAttemptsPerDay,
          }),
          {},
          {
            authorType: "system",
            presentation: compactRecoveryPresentation("Handed to manager for review"),
            metadata: recoveryNoticeMetadata({
              cause: recoveryCause,
              latestRun,
              previousStatus: input.previousStatus,
              recoveryOwner: managerAgent
                ? { id: managerAgent.id, name: managerAgent.name }
                : null,
            }),
          },
        );
        // The manager-review wake mirrors the vendor's PATCH-triggered
        // review wake (executionStage context, reviewer role, allowed
        // actions); a failed wake degrades — the committed handoff must
        // not be undone, and the sweep tick must not abort.
        const managerReviewExecutionStage = buildStrandedAutoPolicyManagerReviewWakeContext({
          executionState: updated.executionState ?? {},
        });
        try {
          await enqueueWakeup(autoPolicyDecision.managerAgentId, {
            source: "assignment",
            triggerDetail: "system",
            reason: "execution_review_requested",
            payload: withRecoveryContext(
              {
                issueId: issue.id,
                mutation: "myrmidon_stranded_autopolicy_manager_review",
                executionStage: managerReviewExecutionStage,
              },
              "normal_model",
            ),
            requestedByActorType: "system",
            requestedByActorId: null,
            contextSnapshot: withRecoveryContext(
              {
                issueId: issue.id,
                taskId: issue.id,
                wakeReason: "execution_review_requested",
                source: "myrmidon.stranded_autopolicy_manager_review",
                executionStage: managerReviewExecutionStage,
              },
              "normal_model",
            ),
          });
        } catch (error) {
          // Deliberately logged-and-swallowed: see the comment above.
          logger.warn(
            {
              issueId: issue.id,
              managerAgentId: autoPolicyDecision.managerAgentId,
              error: error instanceof Error ? error.message : String(error),
            },
            "myrmidon(L4): stranded auto-policy manager-review wake failed after the handoff was already committed",
          );
        }
        await logActivity(db, {
          companyId: issue.companyId,
          actorType: "system",
          actorId: "system",
          agentId: null,
          runId: latestRun.id,
          action: "issue.stranded_autopolicy_reassigned_to_manager",
          entityType: "issue",
          entityId: issue.id,
          details: {
            identifier: issue.identifier,
            recoveryCause,
            managerAgentId: autoPolicyDecision.managerAgentId,
            attemptsInWindow: autoPolicyDecision.attemptsInWindow,
            maxAttemptsPerDay: autoPolicyDecision.maxAttemptsPerDay,
          },
        });
        return { handled: true, issue: updated, action: "reassign_to_manager" };
      }
      // The update genuinely could not apply — fall through to the vendor
      // path below, same as before the extract.
      return { handled: false };
    }

    // `vendor_default` (paused assignee, no manager, guards tripped).
    return { handled: false };
  }

  return { run };
}
