// Task PR sync sweep.
//
// One pass on the scheduler tick: find the tasks whose work products include a
// pull request, refresh each PR's state through the existing GitHub resolver, and
// act on the pure policy's decision:
//
//   - `settle_done`        — close the task `done` with a single neutral comment
//                            (PR refs, merge sha, timestamp) and an activity row,
//                            dissolving the task's execution workflow through the
//                            same `issueService.update` path the operator's manual
//                            PATCH uses.
//   - `return_to_assignee` — a PR was closed without merging: put the task back
//                            to `in_progress` with a comment, unless a newer
//                            comment already answered the closure.
//
// Everything with a side effect on the board goes through the existing services,
// so no SQL is hand-rolled. The GitHub call is injected (`resolvePullRequestDetails`)
// so tests run against a fake and never touch the network. Idempotency: a settled
// task is `done`, so the candidate query never revisits it, and the merge sha is
// recorded on the work product (`metadata.lastMergedSha`) so a re-run that somehow
// sees the same merge does not comment twice.

import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  approvals,
  issueApprovals,
  issueComments,
  issueThreadInteractions,
  issueWorkProducts,
  issues,
  type Db,
} from "@paperclipai/db";
import type { IssueWorkProduct } from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { logActivity, publishActivity, type ActivityPublication } from "../../services/activity-log.js";
import type { IssuePostCommitAction } from "../../services/issues.js";
import type {
  PullRequestMergeDetails,
  PullRequestMergeDetailsResolver,
} from "../../services/github-pull-request-merge.js";
import { isInstanceUnderMaintenance } from "../maintenance/gate.js";
import {
  decideTaskPrSync,
  effectivePullRequestState,
  readLastMergedSha,
  readPullRequestMetadata,
  taskPrReference,
  type TaskPrSyncDecision,
  type TaskPrSyncFacts,
  type TaskPrSyncPrFact,
} from "./policy.js";
import { readTaskPrSyncSettings, type TaskPrSyncSettings } from "./settings.js";

/**
 * The service layer is loaded lazily. This module sits in the server entry
 * point's static import graph, and some vendor startup suites replace
 * `@paperclipai/db` and the service barrel with partial mocks; importing the
 * issue and work-product services eagerly would pull their table reads into
 * that graph and fail those suites at import time. The modules are cached by the
 * runtime after the first pass, so the cost is one dynamic import per process.
 */
let taskPrSyncServices: Promise<{
  issueService: typeof import("../../services/issues.js").issueService;
  executeIssuePostCommitActions: typeof import("../../services/issues.js").executeIssuePostCommitActions;
  workProductService: typeof import("../../services/work-products.js").workProductService;
  extractGitHubPullRequestReferences: typeof import("../../services/github-pull-request-merge.js").extractGitHubPullRequestReferences;
}> | null = null;

function loadTaskPrSyncServices() {
  taskPrSyncServices ??= (async () => {
    const [issuesModule, workProductsModule, githubModule] = await Promise.all([
      import("../../services/issues.js"),
      import("../../services/work-products.js"),
      import("../../services/github-pull-request-merge.js"),
    ]);
    return {
      issueService: issuesModule.issueService,
      executeIssuePostCommitActions: issuesModule.executeIssuePostCommitActions,
      workProductService: workProductsModule.workProductService,
      extractGitHubPullRequestReferences: githubModule.extractGitHubPullRequestReferences,
    };
  })();
  return taskPrSyncServices;
}

/** Statuses the sweep may rewrite; a task in any other status is not a candidate. */
const CANDIDATE_ISSUE_STATUSES = ["in_progress", "in_review"] as const;
const TERMINAL_ISSUE_STATUSES: ReadonlySet<string> = new Set(["done", "cancelled"]);
const ACTIVE_REVIEW_APPROVAL_STATUSES = ["pending", "revision_requested"] as const;

export const TASK_PR_SYNC_ACTIVITY_ACTOR = "task_pr_sync";
export const TASK_PR_SYNC_SETTLED_ACTION = "myrmidon.task_pr_sync.settled";
export const TASK_PR_SYNC_RETURNED_ACTION = "myrmidon.task_pr_sync.returned";

/** A resolved PR fact plus the bookkeeping the sweep needs but the policy does not. */
export interface TaskPrSyncResolvedPr extends TaskPrSyncPrFact {
  /** The sha the work product already recorded, if a previous settle wrote one. */
  recordedSha: string | null;
  /** The work product's `updatedAt` as read, before this pass refreshed it. */
  recordedUpdatedAt: Date;
}

/** The one neutral comment a settle writes. No board identifiers beyond the PR reference. */
export function buildSettleComment(input: {
  prRefs: string[];
  shas: string[];
  at: Date;
}): string {
  const refs = input.prRefs.length > 0 ? input.prRefs.join(", ") : "the delivering pull request";
  const shaText = input.shas.length > 0 ? input.shas.join(", ") : "merge commit unknown";
  return `Delivered: PR ${refs} merged (${shaText}); task closed by the periodic PR sync at ${input.at.toISOString()}.`;
}

/** The one neutral comment a return writes. */
export function buildReturnComment(input: {
  prRefs: string[];
  at: Date;
}): string {
  const refs = input.prRefs.length > 0 ? input.prRefs.join(", ") : "the delivering pull request";
  return `Delivery pending: PR ${refs} was closed without merging; task returned to the assignee at ${input.at.toISOString()}.`;
}

export interface TaskPrSyncSweepDeps {
  db: Db;
  /** The existing company-scoped GitHub resolver; injected so tests never use the network. */
  resolvePullRequestDetails: PullRequestMergeDetailsResolver;
  /** Maintenance gate; defaults to the instance-wide check. */
  isUnderMaintenance?: (db: Db) => Promise<boolean>;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

export interface TaskPrSyncSweepResult {
  /** Tasks selected by the batched candidate query. */
  scanned: number;
  /** Tasks closed by this pass. */
  settled: number;
  /** Tasks sent back to the assignee. */
  returned: number;
  /** Tasks the policy left alone. */
  skipped: number;
  /** Tasks whose merge was already recorded, so no second comment was written. */
  deduped: number;
  /** Tasks whose GitHub resolve or action failed; the next pass retries them. */
  failed: number;
  /** True when the pass was skipped before scanning (disabled, maintenance, or interval). */
  skippedPass: boolean;
}

const EMPTY_RESULT: TaskPrSyncSweepResult = {
  scanned: 0,
  settled: 0,
  returned: 0,
  skipped: 0,
  deduped: 0,
  failed: 0,
  skippedPass: false,
};

function readMonitorNextCheckAt(policy: unknown): string | null {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return null;
  const monitor = (policy as Record<string, unknown>).monitor;
  if (!monitor || typeof monitor !== "object" || Array.isArray(monitor)) return null;
  const nextCheckAt = (monitor as Record<string, unknown>).nextCheckAt;
  return typeof nextCheckAt === "string" ? nextCheckAt : null;
}

/** Map the resolver's answer to the state the policy understands. */
export function resolvedPullRequestState(
  details: PullRequestMergeDetails,
): "open" | "draft" | "merged" | "closed" | undefined {
  if (details.workProductState) return details.workProductState;
  if (details.state === "merged") return "merged";
  if (details.state === "open") return "open";
  return undefined;
}

/**
 * An explicit, still-open post-deploy gate holds the task: a pending review card,
 * a pending approval, or a monitor scheduled for the future. Any of them means a
 * person still has a decision to make after the merge, so the sweep defers the
 * settle instead of closing under them.
 */
export async function hasOpenPostDeployGate(
  db: Db,
  issue: { id: string; executionPolicy: unknown },
  now: Date,
): Promise<boolean> {
  const nextCheckAt = readMonitorNextCheckAt(issue.executionPolicy);
  if (nextCheckAt && Date.parse(nextCheckAt) > now.getTime()) return true;

  const pendingInteraction = await db
    .select({ id: issueThreadInteractions.id })
    .from(issueThreadInteractions)
    .where(
      and(
        eq(issueThreadInteractions.issueId, issue.id),
        eq(issueThreadInteractions.status, "pending"),
      ),
    )
    .limit(1);
  if (pendingInteraction.length > 0) return true;

  const pendingApproval = await db
    .select({ id: approvals.id })
    .from(issueApprovals)
    .innerJoin(approvals, eq(approvals.id, issueApprovals.approvalId))
    .where(
      and(
        eq(issueApprovals.issueId, issue.id),
        inArray(approvals.status, [...ACTIVE_REVIEW_APPROVAL_STATUSES]),
      ),
    )
    .limit(1);
  return pendingApproval.length > 0;
}

export function createTaskPrSyncSweep(deps: TaskPrSyncSweepDeps) {
  const now = deps.now ?? (() => new Date());
  let lastRunAt = 0;
  let inFlight = false;
  let workProductsPromise: Promise<ReturnType<
    typeof import("../../services/work-products.js").workProductService
  >> | null = null;
  const workProducts = () => {
    workProductsPromise ??= loadTaskPrSyncServices().then((services) => services.workProductService(deps.db));
    return workProductsPromise;
  };

  async function referenceFor(product: IssueWorkProduct) {
    const { extractGitHubPullRequestReferences } = await loadTaskPrSyncServices();
    const { repo, number } = readPullRequestMetadata(product);
    const references = extractGitHubPullRequestReferences([
      product.url,
      repo && number ? `${repo}#${number}` : null,
    ]);
    return references[0] ?? null;
  }

  async function resolvePrFacts(
    issue: { id: string; companyId: string },
    products: IssueWorkProduct[],
  ): Promise<TaskPrSyncResolvedPr[]> {
    const facts: TaskPrSyncResolvedPr[] = [];
    const productsService = products.length > 0 ? await workProducts() : null;
    for (const product of products) {
      const { repo, number } = readPullRequestMetadata(product);
      const reference = await referenceFor(product);
      let details: PullRequestMergeDetails | null = null;
      if (reference) {
        try {
          details = await deps.resolvePullRequestDetails(issue.companyId, reference);
        } catch {
          // A resolver failure is not a merge; the policy sees `unknown` and waits.
          details = null;
        }
      }
      const resolvedState = details ? resolvedPullRequestState(details) : undefined;
      const state = effectivePullRequestState({ storedStatus: product.status, resolvedState });
      facts.push({
        workProductId: product.id,
        state,
        repo: repo ?? (reference ? `${reference.owner}/${reference.repo}` : null),
        number: number ?? reference?.number ?? null,
        mergedSha: details?.headSha ?? null,
        recordedSha: readLastMergedSha(product),
        recordedUpdatedAt: product.updatedAt,
      });
      // Refresh the stored row when the resolver moved its state, so the existing
      // work-products surface reflects GitHub without a separate reader.
      if (productsService && resolvedState && resolvedState !== product.status) {
        try {
          await productsService.update(product.id, {
            status: resolvedState,
            metadata: {
              ...(product.metadata ?? {}),
              state: resolvedState,
              draft: resolvedState === "draft",
            },
          });
        } catch {
          // Bookkeeping only; the policy still acts on the fresh facts.
        }
      }
    }
    return facts;
  }

  async function latestCommentAt(issueId: string): Promise<Date | null> {
    const row = await deps.db
      .select({ createdAt: issueComments.createdAt })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId))
      .orderBy(desc(issueComments.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return row?.createdAt ?? null;
  }

  async function settleIssue(
    issue: { id: string; companyId: string },
    decision: Extract<TaskPrSyncDecision, { kind: "settle_done" }>,
    prFacts: TaskPrSyncResolvedPr[],
    at: Date,
  ): Promise<boolean> {
    const shas = prFacts
      .filter((pr) => pr.state === "merged" && pr.mergedSha)
      .map((pr) => pr.mergedSha as string);
    const body = buildSettleComment({ prRefs: decision.prRefs, shas, at });
    const services = await loadTaskPrSyncServices();
    const publications: ActivityPublication[] = [];
    const actions: IssuePostCommitAction[] = [];
    const settled = await deps.db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const locked = await tx
        .select()
        .from(issues)
        .where(eq(issues.id, issue.id))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!locked) return false;
      if (TERMINAL_ISSUE_STATUSES.has(locked.status)) return false;
      const svc = services.issueService(txDb);
      const comment = await svc.addComment(locked.id, body, { runId: null }, { authorType: "system" }, tx);
      // The settle mirrors the board's manual PATCH: status `done` and the task's
      // execution workflow dissolved (pending stages and runtime state cleared)
      // through the issue service, never by hand-written SQL.
      const updated = await svc.update(
        locked.id,
        { status: "done", executionState: null, executionPolicy: null },
        tx,
        publications,
        actions,
      );
      if (!updated) return false;
      await logActivity(txDb, {
        companyId: locked.companyId,
        actorType: "system",
        actorId: TASK_PR_SYNC_ACTIVITY_ACTOR,
        action: TASK_PR_SYNC_SETTLED_ACTION,
        entityType: "issue",
        entityId: locked.id,
        issueId: locked.id,
        details: {
          identifier: locked.identifier ?? null,
          previousStatus: locked.status,
          prRefs: decision.prRefs,
          mergeShas: shas,
          commentId: comment.id,
        },
      });
      return true;
    });
    if (!settled) return false;
    for (const publication of publications) publishActivity(publication);
    await services.executeIssuePostCommitActions(deps.db, actions);
    // Record the merge sha on each merged work product so a re-run that somehow
    // sees the same merge does not comment a second time.
    const productsService = await workProducts();
    for (const pr of prFacts) {
      if (pr.state !== "merged" || !pr.mergedSha) continue;
      const product = await productsService.getById(pr.workProductId);
      if (!product) continue;
      await productsService
        .update(pr.workProductId, {
          metadata: { ...(product.metadata ?? {}), lastMergedSha: pr.mergedSha },
        })
        .catch(() => undefined);
    }
    return true;
  }

  async function returnIssueToAssignee(
    issue: { id: string; companyId: string },
    decision: Extract<TaskPrSyncDecision, { kind: "return_to_assignee" }>,
    at: Date,
  ): Promise<boolean> {
    const body = buildReturnComment({ prRefs: decision.closedPrRefs, at });
    const services = await loadTaskPrSyncServices();
    const publications: ActivityPublication[] = [];
    const actions: IssuePostCommitAction[] = [];
    const returned = await deps.db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const locked = await tx
        .select()
        .from(issues)
        .where(eq(issues.id, issue.id))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!locked) return false;
      if (TERMINAL_ISSUE_STATUSES.has(locked.status)) return false;
      const svc = services.issueService(txDb);
      const comment = await svc.addComment(locked.id, body, { runId: null }, { authorType: "system" }, tx);
      const updated = await svc.update(locked.id, { status: "in_progress" }, tx, publications, actions);
      if (!updated) return false;
      await logActivity(txDb, {
        companyId: locked.companyId,
        actorType: "system",
        actorId: TASK_PR_SYNC_ACTIVITY_ACTOR,
        action: TASK_PR_SYNC_RETURNED_ACTION,
        entityType: "issue",
        entityId: locked.id,
        issueId: locked.id,
        details: {
          identifier: locked.identifier ?? null,
          previousStatus: locked.status,
          prRefs: decision.closedPrRefs,
          commentId: comment.id,
        },
      });
      return true;
    });
    if (!returned) return false;
    for (const publication of publications) publishActivity(publication);
    await services.executeIssuePostCommitActions(deps.db, actions);
    return true;
  }

  return {
    /** Runs one pass. Options exist for tests; production reads settings and the clock. */
    sweep: async (opts?: {
      now?: Date;
      settings?: TaskPrSyncSettings;
      /** Bypass the interval gate (tests call the pass directly). */
      force?: boolean;
      batchMax?: number;
    }): Promise<TaskPrSyncSweepResult> => {
      const settings = opts?.settings ?? readTaskPrSyncSettings(deps.env ?? process.env);
      if (!settings.enabled) return { ...EMPTY_RESULT, skippedPass: true };
      const at = opts?.now ?? now();
      if (!opts?.force && at.getTime() - lastRunAt < settings.pollMs) {
        return { ...EMPTY_RESULT, skippedPass: true };
      }
      if (inFlight) return { ...EMPTY_RESULT, skippedPass: true };
      const isUnderMaintenance = deps.isUnderMaintenance ?? ((db: Db) => isInstanceUnderMaintenance(db));
      if (await isUnderMaintenance(deps.db)) return { ...EMPTY_RESULT, skippedPass: true };

      inFlight = true;
      const result: TaskPrSyncSweepResult = { ...EMPTY_RESULT };
      try {
        const batchMax = Math.max(1, opts?.batchMax ?? settings.batchMax);
        const candidates = await deps.db
          .selectDistinct({ id: issues.id, updatedAt: issues.updatedAt })
          .from(issues)
          .innerJoin(
            issueWorkProducts,
            and(eq(issueWorkProducts.issueId, issues.id), eq(issueWorkProducts.type, "pull_request")),
          )
          .where(inArray(issues.status, [...CANDIDATE_ISSUE_STATUSES]))
          .orderBy(asc(issues.updatedAt))
          .limit(batchMax);
        const issueIds = candidates.map((row) => row.id);
        if (issueIds.length === 0) {
          lastRunAt = at.getTime();
          return result;
        }

        const issueRows = await deps.db.select().from(issues).where(inArray(issues.id, issueIds));
        const productRows = await deps.db
          .select()
          .from(issueWorkProducts)
          .where(
            and(
              inArray(issueWorkProducts.issueId, issueIds),
              eq(issueWorkProducts.type, "pull_request"),
            ),
          );
        const productsByIssue = new Map<string, IssueWorkProduct[]>();
        for (const row of productRows) {
          const list = productsByIssue.get(row.issueId) ?? [];
          list.push(row as unknown as IssueWorkProduct);
          productsByIssue.set(row.issueId, list);
        }

        for (const issue of issueRows) {
          result.scanned += 1;
          try {
            const products = productsByIssue.get(issue.id) ?? [];
            const prFacts = await resolvePrFacts(issue, products);
            const openGate = await hasOpenPostDeployGate(
              deps.db,
              { id: issue.id, executionPolicy: issue.executionPolicy },
              at,
            );
            const policyFacts: TaskPrSyncFacts = {
              issueStatus: issue.status,
              prs: prFacts,
              openPostDeployGate: openGate,
            };
            const decision = decideTaskPrSync(policyFacts);

            if (decision.kind === "noop") {
              result.skipped += 1;
              continue;
            }

            if (decision.kind === "return_to_assignee") {
              // Skip when a newer comment already answered the closure. The
              // closure time is when the closed PR product was last written
              // (before this pass refreshed it), since the resolver reports state
              // but not a timestamp.
              const closureAt = prFacts
                .filter((pr) => pr.state === "closed")
                .reduce<Date | null>(
                  (latest, pr) => (!latest || pr.recordedUpdatedAt > latest ? pr.recordedUpdatedAt : latest),
                  null,
                );
              const commentAt = await latestCommentAt(issue.id);
              if (closureAt && commentAt && commentAt.getTime() > closureAt.getTime()) {
                result.skipped += 1;
                continue;
              }
              if (settings.settleDisabled) {
                result.skipped += 1;
                continue;
              }
              const returned = await returnIssueToAssignee(issue, decision, at);
              if (returned) result.returned += 1;
              else result.skipped += 1;
              continue;
            }

            // settle_done: dedup by the merge sha already recorded on the products.
            const merged = prFacts.filter((pr) => pr.state === "merged");
            const alreadyRecorded =
              merged.length > 0 &&
              merged.every((pr) => pr.mergedSha !== null && pr.recordedSha === pr.mergedSha);
            if (alreadyRecorded) {
              result.deduped += 1;
              continue;
            }
            if (settings.settleDisabled) {
              result.skipped += 1;
              continue;
            }
            const settled = await settleIssue(issue, decision, prFacts, at);
            if (settled) result.settled += 1;
            else result.skipped += 1;
          } catch (err) {
            result.failed += 1;
            // Constant errorKind only: an exception message can carry a credential.
            logger.warn(
              { errorKind: "task_pr_sync_issue_failed", issueId: issue.id },
              "task PR sync failed for one task",
            );
          }
        }
        lastRunAt = at.getTime();
        return result;
      } finally {
        inFlight = false;
      }
    },
  };
}