import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, heartbeatRuns, issues } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import {
  RUN_STALL_ACTIVITY_ACTION,
  RUN_STALL_ERROR_CODE,
  RUN_STALL_FAILURE_REASON,
  RUN_STALL_WAKE_IDEMPOTENCY_PREFIX,
  RUN_STALL_WAKE_REASON,
} from "./constants.js";
import { classifyRunStall, progressAnchorAt, shouldReturnIssueToTodo, type RunProgressTimestamps } from "./policy.js";
import { readRunStallSettings, type RunStallSettings } from "./settings.js";

/**
 * One pass over the running runs of the instance: interrupt the ones whose
 * newest recorded progress is older than the threshold, put their task back to
 * `todo` and wake the assignee.
 *
 * Everything with a side effect is injected, so the rules above stay pure and
 * the wiring lives in index.ts next to the other scheduler sweeps. The sweep is
 * single-flight and interval-limited on its own; the scheduler queue it is
 * registered in is single-flight as well, which is the only reason a slow
 * adapter stop cannot stack up passes.
 */

/** Statuses a run can be in and still be stalled; only a live run is a candidate. */
const RUNNING_STATUS = "running" as const;
/** Wake statuses that already cover an issue, so this sweep must not add a second one. */
const COVERING_WAKE_STATUSES = ["queued", "deferred_issue_execution", "claimed"] as const;

export interface RunStallInterruptInput {
  runId: string;
  companyId: string;
  agentId: string;
  issueId: string | null;
  /** Age of the newest recorded progress at the moment of the interrupt. */
  silenceMs: number;
}

export interface RunStallSweepDeps {
  db: Db;
  /**
   * Stops the run through the heartbeat cancel path with
   * `errorCode: run_stalled` and `suppressImmediateRecovery: true`. Resolves
   * once the run row is terminal.
   */
  interruptRun: (input: RunStallInterruptInput) => Promise<void>;
  /** Moves one interrupted run's task back to `todo`; false when nothing changed. */
  returnIssueToTodo: (input: { issueId: string; companyId: string; runId: string }) => Promise<boolean>;
  /**
   * Wakes the assignee with the task bound (`payload.issueId` / context
   * `issueId`), so the resumed run may write to the task it was woken for.
   */
  wakeAssignee: (input: { agentId: string; issueId: string; runId: string; identifier: string | null }) => Promise<boolean>;
  /** Maintenance-mode gate: a run in an open window is not touched. */
  isRunUnderMaintenance: (runId: string) => Promise<boolean>;
  /** Optional activity log; absent in unit tests. */
  logActivity?: (input: {
    companyId: string;
    actorType: "system";
    actorId: string;
    agentId: string | null;
    runId: string | null;
    action: string;
    entityType: string;
    entityId: string;
    details: Record<string, unknown>;
  }) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

export interface RunStallSweepResult {
  /** Runs inspected after the SQL prefilter. */
  scanned: number;
  /** Runs interrupted by this pass. */
  interrupted: number;
  /** Tasks moved back to `todo`. */
  returnedToTodo: number;
  /** Assignees woken. */
  woken: number;
  /** Candidates whose recorded progress was still fresh (quiet but alive). */
  skippedActive: number;
  /** Candidates left alone because their agent is in a maintenance window. */
  skippedMaintenance: number;
  /** Candidates with no recorded timestamp at all: "cannot judge", left alone. */
  skippedUnknown: number;
  /** Runs whose interrupt or follow-up failed; the next pass retries them. */
  failed: number;
  runIds: string[];
}

function emptyResult(): RunStallSweepResult {
  return {
    scanned: 0,
    interrupted: 0,
    returnedToTodo: 0,
    woken: 0,
    skippedActive: 0,
    skippedMaintenance: 0,
    skippedUnknown: 0,
    failed: 0,
    runIds: [],
  };
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/**
 * The newest recorded progress of a run, read in one statement: the three
 * progress columns of the run row plus the newest appended run event. Used to
 * re-check a candidate immediately before it is interrupted, so progress that
 * landed between the scan and this read keeps the run alive.
 *
 * Exported for the module's own test, which proves exactly that re-read.
 */
export async function readRunProgress(db: Db, runId: string): Promise<RunProgressTimestamps | null> {
  const [row] = await db
    .select({
      lastOutputAt: heartbeatRuns.lastOutputAt,
      lastUsefulActionAt: heartbeatRuns.lastUsefulActionAt,
      processStartedAt: heartbeatRuns.processStartedAt,
      startedAt: heartbeatRuns.startedAt,
      lastEventAt: sql<unknown>`(
        select max(e.created_at)
        from heartbeat_run_events e
        where e.run_id = heartbeat_runs.id
      )`,
    })
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.status, RUNNING_STATUS)))
    .limit(1);
  if (!row) return null;
  return {
    lastOutputAt: toDate(row.lastOutputAt),
    lastUsefulActionAt: toDate(row.lastUsefulActionAt),
    lastEventAt: toDate(row.lastEventAt),
    processStartedAt: toDate(row.processStartedAt),
    startedAt: toDate(row.startedAt),
  };
}

/**
 * The prefilter: running runs whose own recorded progress is already older than
 * the cutoff. The expression is the same anchor the policy uses, evaluated in
 * the database so one pass reads at most `pageSize` rows instead of every
 * running run.
 *
 * `startedAt is not null` is part of the predicate: a run claimed but not yet
 * started carries no timestamp this sweep may read, and "no timestamp" is
 * "cannot judge", never "stalled".
 */
function candidateRuns(db: Db, cutoffIso: string, pageSize: number) {
  const anchor = sql`greatest(
    coalesce(${heartbeatRuns.lastOutputAt}, to_timestamp(0)),
    coalesce(${heartbeatRuns.lastUsefulActionAt}, to_timestamp(0)),
    coalesce(${heartbeatRuns.processStartedAt}, ${heartbeatRuns.startedAt}, to_timestamp(0)),
    coalesce((
      select max(e.created_at)
      from heartbeat_run_events e
      where e.run_id = heartbeat_runs.id
    ), to_timestamp(0))
  )`;
  return db
    .select({
      id: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      agentId: heartbeatRuns.agentId,
      contextSnapshot: heartbeatRuns.contextSnapshot,
      lastOutputAt: heartbeatRuns.lastOutputAt,
      lastUsefulActionAt: heartbeatRuns.lastUsefulActionAt,
      processStartedAt: heartbeatRuns.processStartedAt,
      startedAt: heartbeatRuns.startedAt,
      anchorAt: sql<unknown>`${anchor}`,
    })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.status, RUNNING_STATUS),
        isNotNull(heartbeatRuns.startedAt),
        sql`${anchor} <= ${cutoffIso}::timestamptz`,
      ),
    )
    // Oldest progress first: with a page smaller than the backlog the stalest run
    // is always the one this pass handles.
    .orderBy(asc(sql`${anchor}`), asc(heartbeatRuns.createdAt))
    .limit(pageSize);
}

function contextIssueId(contextSnapshot: Record<string, unknown> | null | undefined): string | null {
  const value = contextSnapshot?.issueId ?? contextSnapshot?.taskId;
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** True when the issue already has a live run or a queued wake; a second wake would only coalesce. */
async function issueAlreadyCovered(db: Db, companyId: string, agentId: string, issueId: string): Promise<boolean> {
  const [run] = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.agentId, agentId),
        inArray(heartbeatRuns.status, [...COVERING_WAKE_STATUSES, RUNNING_STATUS]),
        sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
      ),
    )
    .limit(1);
  if (run) return true;
  const [wake] = await db
    .select({ id: agentWakeupRequests.id })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, companyId),
        eq(agentWakeupRequests.agentId, agentId),
        inArray(agentWakeupRequests.status, [...COVERING_WAKE_STATUSES]),
        sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}`,
      ),
    )
    .limit(1);
  return Boolean(wake);
}

export interface RunStallSweep {
  /** One pass. Concurrent calls share the in-flight pass instead of stacking a second scan. */
  sweep(options?: { now?: Date; force?: boolean }): Promise<RunStallSweepResult>;
  resetForTest(): void;
  settings(): RunStallSettings;
}

export function createRunStallSweep(deps: RunStallSweepDeps): RunStallSweep {
  let lastSweepAtMs = 0;
  let inFlight: Promise<RunStallSweepResult> | null = null;

  async function runPass(now: Date, settings: RunStallSettings): Promise<RunStallSweepResult> {
    const cutoff = new Date(now.getTime() - settings.thresholdMs);
    const candidates = await candidateRuns(deps.db, cutoff.toISOString(), settings.pageSize);
    const result = emptyResult();
    result.scanned = candidates.length;

    for (const candidate of candidates) {
      try {
        // Re-read immediately before acting: progress recorded a moment ago (or a
        // run that finished on its own) must not be interrupted on stale evidence.
        const progress = await readRunProgress(deps.db, candidate.id);
        if (!progress) continue; // gone or no longer running: nothing to do
        const classification = classifyRunStall({ run: progress, now, thresholdMs: settings.thresholdMs });
        if (classification === "unknown") {
          result.skippedUnknown += 1;
          continue;
        }
        if (classification === "active") {
          result.skippedActive += 1;
          continue;
        }
        if (await deps.isRunUnderMaintenance(candidate.id)) {
          result.skippedMaintenance += 1;
          continue;
        }

        // Re-read once more, right before the interrupt: the maintenance gate
        // reads the database too, so progress recorded while this pass worked
        // through its candidates must still keep the run alive. This is the
        // narrowest window the sweep can offer without locking the run row.
        const confirmed = await readRunProgress(deps.db, candidate.id);
        if (!confirmed) continue;
        const confirmedClassification = classifyRunStall({
          run: confirmed,
          now,
          thresholdMs: settings.thresholdMs,
        });
        if (confirmedClassification !== "stalled") {
          if (confirmedClassification === "unknown") result.skippedUnknown += 1;
          else result.skippedActive += 1;
          continue;
        }

        const anchor = progressAnchorAt(confirmed);
        const issueId = contextIssueId(candidate.contextSnapshot);
        await deps.interruptRun({
          runId: candidate.id,
          companyId: candidate.companyId,
          agentId: candidate.agentId,
          issueId,
          silenceMs: anchor ? Math.max(0, now.getTime() - anchor.getTime()) : 0,
        });
        result.interrupted += 1;
        result.runIds.push(candidate.id);

        let returnedToTodo = false;
        let woken = false;
        if (issueId) {
          const [issue] = await deps.db
            .select({
              id: issues.id,
              identifier: issues.identifier,
              status: issues.status,
              assigneeAgentId: issues.assigneeAgentId,
              executionState: issues.executionState,
            })
            .from(issues)
            .where(and(eq(issues.companyId, candidate.companyId), eq(issues.id, issueId)))
            .limit(1);
          if (issue && shouldReturnIssueToTodo({ status: issue.status, executionState: issue.executionState })) {
            returnedToTodo = await deps.returnIssueToTodo({
              issueId: issue.id,
              companyId: candidate.companyId,
              runId: candidate.id,
            });
            if (returnedToTodo) result.returnedToTodo += 1;
          }
          // The interrupt released the task's execution lock, so the next pass of
          // the wake path may pick it up. Issue the wake here as well: the whole
          // point of the interrupt is that the work resumes without an operator.
          if (issue?.assigneeAgentId && !(await issueAlreadyCovered(deps.db, candidate.companyId, issue.assigneeAgentId, issue.id))) {
            woken = await deps.wakeAssignee({
              agentId: issue.assigneeAgentId,
              issueId: issue.id,
              runId: candidate.id,
              identifier: issue.identifier ?? null,
            });
            if (woken) result.woken += 1;
          }
        }

        await deps.logActivity?.({
          companyId: candidate.companyId,
          actorType: "system",
          actorId: "run_stall",
          agentId: candidate.agentId,
          runId: candidate.id,
          action: RUN_STALL_ACTIVITY_ACTION,
          entityType: "heartbeat_run",
          entityId: candidate.id,
          details: {
            issueId,
            silenceMs: anchor ? Math.max(0, now.getTime() - anchor.getTime()) : null,
            thresholdMs: settings.thresholdMs,
            failureReason: RUN_STALL_FAILURE_REASON,
            errorCode: RUN_STALL_ERROR_CODE,
            returnedToTodo,
            woken,
          },
        });
      } catch (err) {
        // One run that refuses to stop (a racing finalization, a missing process
        // handle) must not abort the pass; the next one retries it.
        result.failed += 1;
        logger.warn({ err, runId: candidate.id }, "run stall interrupt failed");
      }
    }

    if (result.interrupted > 0) {
      logger.warn(
        {
          interrupted: result.interrupted,
          returnedToTodo: result.returnedToTodo,
          woken: result.woken,
          runIds: result.runIds,
        },
        "run stall sweep interrupted runs with no recorded progress",
      );
    }
    return result;
  }

  return {
    settings() {
      return readRunStallSettings(deps.env ?? process.env);
    },
    resetForTest() {
      lastSweepAtMs = 0;
      inFlight = null;
    },
    async sweep(options = {}) {
      const settings = this.settings();
      if (!settings.enabled) return emptyResult();
      const now = options.now ?? deps.now?.() ?? new Date();
      if (inFlight) return inFlight;
      if (!options.force && now.getTime() - lastSweepAtMs < settings.checkIntervalMs) {
        return emptyResult();
      }
      lastSweepAtMs = now.getTime();
      inFlight = runPass(now, settings).finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}