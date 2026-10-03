// myrmidon(STALE-BLOCK): the stale-block watchdog sweep.
//
// A blocked task holds its assignee hostage to a reason: a blocker task, a
// date, or a gate/event. Two of those reasons die silently today: a CANCELLED
// blocker never fires `issue_blockers_resolved` (routes/issues.ts), and a due
// date or a withdrawn gate has no wake path at all. The task then sits in
// `blocked` forever with a dead reason.
//
// One pass on the scheduler tick: read the blocked tasks, judge each reason
// through the pure policy, and for a task whose reasons are ALL dead:
// remove the dead blocked-by edges, put the task back to `in_progress`, and
// leave one system comment naming the reason. A task with one live reason is
// left untouched (its block is real). Every write goes through the existing
// issue service (`addComment` / `update` with `blockedByIssueIds`), never a
// hand-rolled UPDATE, and the lead/operator signal is the existing
// `blocker_attention` attention-feed source computed on the fly.

import { and, asc, eq, inArray } from "drizzle-orm";
import {
  issueRelations,
  issues,
  type Db,
} from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { publishActivity, type ActivityPublication } from "../../services/activity-log.js";
import type { IssuePostCommitAction } from "../../services/issues.js";
import { readReasonRef } from "./reason.js";
import {
  collectStaleBlockReasons,
  describeStaleBlockReason,
  judgeStaleBlockReason,
  type StaleBlockReason,
  type StaleBlockReasonDeadWhy,
} from "./policy.js";
import { readStaleBlockSettings, type StaleBlockSettings } from "./settings.js";
import { recordStaleBlockSignal, type StaleBlockSignal } from "./attention.js";

export const STALE_BLOCK_SWEEP_PAGE_SIZE = 50;
export const STALE_BLOCK_ACTIVITY_ACTOR = "stale_block_sweep";
export const STALE_BLOCK_ACTIVITY_ACTION = "myrmidon.stale_block.unblocked";

/** The one system comment a sweep-written unblock leaves. Neutral, no internal identifiers. */
export function buildStaleBlockComment(input: {
  identifier: string | null;
  reasons: Array<{ label: string | null; why: StaleBlockReasonDeadWhy }>;
  at: Date;
}): string {
  const described = input.reasons
    .map((reason) => `${reason.label ?? "the reason"}: ${describeStaleBlockReason(reason.why)}`)
    .join("; ");
  return `Stale block removed (${described}); task returned to in_progress by the periodic stale-block sweep at ${input.at.toISOString()}.`;
}

/**
 * The service layer is loaded lazily: this module sits in the server entry
 * point's static import graph, and some vendor startup suites replace the
 * service barrel with partial mocks; importing the issue service eagerly
 * would pull its table reads into that graph and fail those suites at import
 * time (same reason as task-pr-sync/sweep.ts).
 */
let staleBlockServices: Promise<{
  issueService: typeof import("../../services/issues.js").issueService;
  executeIssuePostCommitActions: typeof import("../../services/issues.js").executeIssuePostCommitActions;
}> | null = null;

function loadStaleBlockServices() {
  staleBlockServices ??= import("../../services/issues.js").then((module) => ({
    issueService: module.issueService,
    executeIssuePostCommitActions: module.executeIssuePostCommitActions,
  }));
  return staleBlockServices;
}

export interface StaleBlockSweepDeps {
  db: Db;
  /** Reads whether an event/gate key is still set for the company; injected so tests never touch gates. */
  isEventStillSet: (companyId: string, eventKey: string) => Promise<boolean>;
  /** Maintenance gate; defaults to the instance-wide check when provided by the wiring. */
  isUnderMaintenance?: (db: Db) => Promise<boolean>;
  logActivity?: (input: {
    companyId: string;
    actorType: "system";
    actorId: string;
    action: string;
    entityType: string;
    entityId: string;
    issueId: string;
    details: Record<string, unknown>;
  }) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

export interface StaleBlockSweepResult {
  /** Blocked tasks selected by the candidate query. */
  scanned: number;
  /** Tasks unblocked by this pass. */
  unblocked: number;
  /** Tasks left blocked (a live reason held). */
  skippedLive: number;
  /** Tasks left alone: no recognizable reason, or the row vanished. */
  skippedUnknown: number;
  /** Tasks whose unblock failed; the next pass retries them. */
  failed: number;
  /** True when the pass was skipped before scanning (disabled or interval). */
  skippedPass: boolean;
}

const EMPTY_RESULT: StaleBlockSweepResult = {
  scanned: 0,
  unblocked: 0,
  skippedLive: 0,
  skippedUnknown: 0,
  failed: 0,
  skippedPass: false,
};

type BlockedRow = {
  id: string;
  companyId: string;
  identifier: string | null;
  title: string;
  unblockDescriptor: unknown;
};

async function blockedCandidates(db: Db, pageSize: number): Promise<BlockedRow[]> {
  return db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      identifier: issues.identifier,
      title: issues.title,
      unblockDescriptor: issues.unblockDescriptor,
    })
    .from(issues)
    .where(eq(issues.status, "blocked"))
    .orderBy(asc(issues.updatedAt), asc(issues.id))
    .limit(pageSize);
}

async function blockedByEdgesFor(db: Db, companyId: string, issueId: string): Promise<string[]> {
  const rows = await db
    .select({ blockerIssueId: issueRelations.issueId })
    .from(issueRelations)
    .where(
      and(
        eq(issueRelations.companyId, companyId),
        eq(issueRelations.relatedIssueId, issueId),
        eq(issueRelations.type, "blocks"),
      ),
    );
  return rows.map((row) => row.blockerIssueId);
}

/** Statuses of the given blocker ids in the company; a verified-gone row maps to `null`. */
async function blockerStatusMap(
  db: Db,
  companyId: string,
  blockerIssueIds: readonly string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(blockerIssueIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: issues.id, status: issues.status })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), inArray(issues.id, ids)));
  return new Map(rows.map((row) => [row.id, row.status]));
}

/**
 * One dead-reason verdict plus the label the comment uses. Pure outcome of
 * `judgeStaleBlockReason` plus the identity facts the caller already read.
 */
interface DeadReason {
  reason: StaleBlockReason;
  why: StaleBlockReasonDeadWhy;
  /** Human label: the blocker's identifier, the event key, or the ISO date. */
  label: string | null;
}

async function judgeReasons(input: {
  db: Db;
  deps: StaleBlockSweepDeps;
  row: BlockedRow;
  now: Date;
}): Promise<{ reasons: StaleBlockReason[]; dead: DeadReason[]; liveCount: number }> {
  const { db, deps, row, now } = input;
  const reasonRef = readReasonRef(row.unblockDescriptor);
  const blockedByIssueIds = await blockedByEdgesFor(db, row.companyId, row.id);
  const reasons = collectStaleBlockReasons({ reasonRef, blockedByIssueIds });

  const issueIds = reasons
    .map((reason) => (reason.kind === "issue" ? reason.issueId : null))
    .filter((value): value is string => value !== null);
  const statuses = await blockerStatusMap(db, row.companyId, issueIds);

  const dead: DeadReason[] = [];
  let liveCount = 0;
  const labelByIdentifier = new Map<string, string | null>([[row.id, row.identifier]]);
  for (const reason of reasons) {
    const facts = {
      blockerStatus: reason.kind === "issue" && reason.issueId !== null
        ? (statuses.has(reason.issueId) ? statuses.get(reason.issueId)! : null)
        : null,
      eventStillSet: reason.kind === "event" && reason.eventKey !== null
        ? await deps.isEventStillSet(row.companyId, reason.eventKey)
        : false,
      now,
    };
    const verdict = judgeStaleBlockReason(reason, facts);
    if (verdict.kind === "live") {
      liveCount += 1;
      continue;
    }
    dead.push({
      reason,
      why: verdict.why,
      label: reason.kind === "issue"
        ? reason.issueId
        : reason.kind === "event"
          ? reason.eventKey
          : reason.dueAt,
    });
  }
  void labelByIdentifier;
  return { reasons, dead, liveCount };
}

export function createStaleBlockSweep(deps: StaleBlockSweepDeps) {
  const now = deps.now ?? (() => new Date());
  let lastSweepAtMs = 0;
  let inFlight: Promise<StaleBlockSweepResult> | null = null;

  async function unblock(row: BlockedRow, dead: DeadReason[], at: Date): Promise<boolean> {
    const services = await loadStaleBlockServices();
    const publications: ActivityPublication[] = [];
    const actions: IssuePostCommitAction[] = [];
    const svc = services.issueService(deps.db);
    const body = buildStaleBlockComment({
      identifier: row.identifier,
      reasons: dead.map((reason) => ({ label: reason.label, why: reason.why })),
      at,
    });

    const done = await deps.db.transaction(async (tx) => {
      const locked = await tx
        .select({
          id: issues.id,
          companyId: issues.companyId,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          unblockDescriptor: issues.unblockDescriptor,
        })
        .from(issues)
        .where(and(eq(issues.id, row.id), eq(issues.companyId, row.companyId)))
        .for("update")
        .then((rows) => rows[0] ?? null);
      // A task that stopped being blocked (a person resolved it between the
      // scan and this lock) is not ours anymore.
      if (!locked || locked.status !== "blocked") return false;

      // Re-judge under the lock on fresh reads, so a blocker that closed and
      // re-opened, or a due date that got moved, is respected.
      const rejudged = await judgeReasons({ db: tx as unknown as Db, deps, row: locked, now: at });
      if (rejudged.liveCount > 0 || rejudged.dead.length === 0) return false;

      const txSvc = services.issueService(tx as unknown as Db);
      const remaining = await blockedByEdgesFor(tx as unknown as Db, locked.companyId, locked.id);
      const deadIds = new Set(
        rejudged.dead
          .map((reason) => (reason.reason.kind === "issue" ? reason.reason.issueId : null))
          .filter((value): value is string => value !== null),
      );
      // Remove exactly the dead blocked-by edges; a live edge (if any survived
      // re-judging) keeps the task blocked and this pass steps away.
      const kept = remaining.filter((blockerIssueId) => !deadIds.has(blockerIssueId));
      if (kept.length > 0 && rejudged.liveCount > 0) return false;
      const comment = await txSvc.addComment(locked.id, body, { runId: null }, { authorType: "system" }, tx);
      const updated = await txSvc.update(
        locked.id,
        {
          status: "in_progress",
          blockedByIssueIds: kept,
        },
        tx,
        publications,
        actions,
      );
      if (!updated) return false;
      await deps.logActivity?.({
        companyId: locked.companyId,
        actorType: "system",
        actorId: STALE_BLOCK_ACTIVITY_ACTOR,
        action: STALE_BLOCK_ACTIVITY_ACTION,
        entityType: "issue",
        entityId: locked.id,
        issueId: locked.id,
        details: {
          identifier: locked.identifier ?? null,
          previousStatus: "blocked",
          deadReasons: rejudged.dead.map((reason) => ({
            kind: reason.reason.kind,
            ref: reason.reason.issueId ?? reason.reason.eventKey ?? reason.reason.dueAt ?? null,
            why: reason.why,
          })),
          commentId: comment.id,
        },
      });
      void svc;
      return true;
    });
    if (!done) return false;
    for (const publication of publications) publishActivity(publication);
    await services.executeIssuePostCommitActions(deps.db, actions);
    // myrmidon(STALE-BLOCK): the lead/operator signal — one attention-feed card
    // per lifted block, read on the fly from the signal registry (no store).
    const signal: StaleBlockSignal = {
      issueId: row.id,
      companyId: row.companyId,
      identifier: row.identifier,
      title: row.title,
      reasonTexts: dead.map((reason) => describeStaleBlockReason(reason.why)),
      liftedAt: at.toISOString(),
    };
    recordStaleBlockSignal(signal, at);
    return true;
  }

  async function runPass(settings: StaleBlockSettings, at: Date): Promise<StaleBlockSweepResult> {
    const rows = await blockedCandidates(deps.db, settings.pageSize);
    const result: StaleBlockSweepResult = { ...EMPTY_RESULT, scanned: rows.length };
    if (rows.length === 0) return result;

    for (const row of rows) {
      try {
        if (deps.isUnderMaintenance && await deps.isUnderMaintenance(deps.db)) {
          result.skippedUnknown += 1;
          continue;
        }
        const judged = await judgeReasons({ db: deps.db, deps, row, now: at });
        if (judged.reasons.length === 0) {
          // No recognizable reason at all: part A will make one mandatory;
          // until then this sweep does not guess.
          result.skippedUnknown += 1;
          continue;
        }
        if (judged.liveCount > 0) {
          result.skippedLive += 1;
          continue;
        }
        const done = await unblock(row, judged.dead, at);
        if (done) {
          result.unblocked += 1;
          logger.warn(
            { issueId: row.id, identifier: row.identifier, dead: judged.dead.length },
            "stale block sweep removed a dead block and returned the task to in_progress",
          );
        } else {
          result.skippedLive += 1;
        }
      } catch {
        // Log a constant errorKind only: the exception can carry a credential
        // in its message, code, cause or stack. The task stays blocked for a
        // later tick.
        result.failed += 1;
        logger.warn(
          { errorKind: "sweep_failed", issueId: row.id },
          "stale block sweep failed for one task",
        );
      }
    }
    return result;
  }

  return {
    settings(): StaleBlockSettings {
      return readStaleBlockSettings(deps.env ?? process.env);
    },
    resetForTest(): void {
      lastSweepAtMs = 0;
      inFlight = null;
    },
    async sweep(options?: { force?: boolean; at?: Date }): Promise<StaleBlockSweepResult> {
      const settings = this.settings();
      if (!settings.enabled) return { ...EMPTY_RESULT, skippedPass: true };
      const at = options?.at ?? now();
      if (inFlight) return inFlight;
      if (!options?.force && at.getTime() - lastSweepAtMs < settings.intervalMs) {
        return { ...EMPTY_RESULT, skippedPass: true };
      }
      lastSweepAtMs = at.getTime();
      inFlight = runPass(settings, at).finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}

export type StaleBlockSweep = ReturnType<typeof createStaleBlockSweep>;
