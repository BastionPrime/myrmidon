import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { agentWakeupRequests, agents, companies, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

/**
 * Idle pickup (IDLE-PICKUP, Myrmidon 1.3).
 *
 * A board that only wakes an agent on assignment leaves the agent idle
 * whenever a run finishes and another ready task is already assigned: on
 * 2026-09-29 the team sat idle for 3 hours with 19 todo tasks, and the
 * operator's only workaround was to reassign a task by hand. This module
 * makes the board wake the agent itself.
 *
 * Two triggers call `idlePickupForAgent`:
 *
 * - the release path: right after a run released its issue execution lock
 *   (`releaseIssueExecutionAndPromote`), for the agent that finished the run;
 * - the scheduler tick: every `MYRMIDON_IDLE_PICKUP_INTERVAL_SEC` seconds
 *   for every invokable agent (a safety net for missed releases, server
 *   restarts and reassignments).
 *
 * The wake is idempotent by construction, not by a stored dedup key: an issue
 * is only ever woken while it truly has no live run and no queued wake. Once
 * the wake lands a `queued`/`running`/`scheduled_retry` run, a later pass
 * (a racing pass, the next tick) sees the issue as no longer idle and leaves
 * it alone. The idempotency key handed to `enqueueWakeup` is for tracing
 * only; it is not a uniqueness constraint the database enforces for this
 * prefix.
 *
 * All the hard gates (agent invokability and therefore pause, maintenance
 * mode, run admission limits, per-agent concurrency, daily caps, budget
 * blocks, tree pause holds) are enforced by `enqueueWakeup` itself, so this
 * module reuses them instead of re-implementing them. Wakes over a limit
 * simply stay queued and the normal queued-run sweep starts them later.
 */

export const IDLE_PICKUP_INTERVAL_SEC_ENV = "MYRMIDON_IDLE_PICKUP_INTERVAL_SEC";
export const IDLE_PICKUP_ENABLED_ENV = "MYRMIDON_IDLE_PICKUP_ENABLED";
export const IDLE_WAKE_REASON = "idle_pickup";
export const IDLE_WAKE_IDEMPOTENCY_PREFIX = "idle_pickup";

/** Default: the sweep runs on every scheduler tick (about 30 s), like the other recovery passes. */
export const DEFAULT_IDLE_PICKUP_INTERVAL_SEC = 30;
export const MIN_IDLE_PICKUP_INTERVAL_SEC = 5;

const WAKEABLE_ISSUE_STATUSES = ["todo", "in_progress"] as const;
const LIVE_HEARTBEAT_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;

/** Interval in seconds; invalid or too-small values fall back to the default. */
export function readIdlePickupIntervalSec(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[IDLE_PICKUP_INTERVAL_SEC_ENV]?.trim();
  if (!raw) return DEFAULT_IDLE_PICKUP_INTERVAL_SEC;
  if (!/^\d+$/.test(raw)) return DEFAULT_IDLE_PICKUP_INTERVAL_SEC;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) return DEFAULT_IDLE_PICKUP_INTERVAL_SEC;
  return Math.max(MIN_IDLE_PICKUP_INTERVAL_SEC, value);
}

/**
 * The feature ships enabled (a defect fix per CONVENTIONS.md §8): an unset or
 * unrecognized value keeps it on. Only an explicit off value disables it.
 */
export function readIdlePickupEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[IDLE_PICKUP_ENABLED_ENV]?.trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

export interface IdlePickupIssueCandidate {
  id: string;
  identifier: string | null;
  priority: string | null;
  blockedTransitionAt: Date | null;
}

export interface IdlePickupDeps {
  db: Db;
  /** Existing wakeup admission path (heartbeat.ts); reuses every limit and gate. */
  enqueueWakeup: (
    agentId: string,
    opts: {
      source?: "automation";
      triggerDetail?: "system";
      reason?: string;
      idempotencyKey?: string;
      requestedByActorType?: "system";
      requestedByActorId?: string;
      contextSnapshot?: Record<string, unknown>;
    },
  ) => Promise<unknown>;
  /** Optional activity log for observability; absent in unit tests. */
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
}

export interface IdlePickupResult {
  /** Issues that received an idle-pickup wake. */
  woken: number;
  /** Ready issues skipped because a wake was already queued or a live run covers them. */
  alreadyActive: number;
  /** Wake attempts that returned null (suppressed by admission) or threw. */
  suppressed: number;
  /** Candidates that reached the loop after the SQL prefilter (blocked issues and containers are excluded there). */
  considered: number;
  issueIds: string[];
}

const IDLE_PICKUP_RESULT_ZERO: Omit<IdlePickupResult, "issueIds"> = {
  woken: 0,
  alreadyActive: 0,
  suppressed: 0,
  considered: 0,
};

/** A fresh zero result; a bare spread of IDLE_PICKUP_RESULT_ZERO would share the issueIds array across calls. */
function emptyIdlePickupResult(): IdlePickupResult {
  return { ...IDLE_PICKUP_RESULT_ZERO, issueIds: [] };
}

function issuePriorityRank(priority: string | null | undefined): number {
  switch (priority) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    case "low":
      return 3;
    default:
      return 4;
  }
}

/**
 * SQL prefilter for one agent's idle-pickup candidates: assigned
 * `todo`/`in_progress`, visible, agent-assigned (not user-assigned), not a
 * chat conversation, no unresolved `blocks` relation, no open child issue.
 * The remaining checks (live run, queued wake) need per-issue lookups and
 * run in the loop in `idlePickupForAgent`.
 */
function idlePickupCandidateRows(db: Db, companyId: string, agentId: string) {
  return db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      priority: issues.priority,
      blockedTransitionAt: issues.blockedTransitionAt,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.assigneeAgentId, agentId),
        isNull(issues.assigneeUserId),
        isNull(issues.hiddenAt),
        isNull(issues.conversationAgentId),
        inArray(issues.status, [...WAKEABLE_ISSUE_STATUSES]),
        // Not blocked by an unresolved blocker: no `blocks` edge whose blocker
        // is anything other than `done`. This mirrors the board's readiness
        // rule (only a done blocker resolves its dependent): an open blocker
        // and a cancelled blocker both suppress the wake — for a cancelled
        // blocker an operator must remove or replace the relation explicitly.
        // A done blocker whose execution workspace has not finalized yet is
        // the one gap this prefilter accepts; the vendor's
        // `issue_blockers_resolved` path re-fires the wake when the
        // finalization lands, so that window closes itself.
        sql`not exists (
          select 1
          from issue_relations ir
            join issues blocker on blocker.id = ir.issue_id and blocker.company_id = ${issues.companyId}
          where ir.company_id = ${issues.companyId}
            and ir.related_issue_id = ${issues.id}
            and ir.type = 'blocks'
            and blocker.status <> 'done'
        )`,
        // Not a container: an issue with an open child is a plan container,
        // and the children are the real work, not the parent.
        sql`not exists (
          select 1
          from issues child
          where child.company_id = ${issues.companyId}
            and child.parent_id = ${issues.id}
            and child.status not in ('done', 'cancelled')
        )`,
      ),
    )
    .orderBy(asc(issues.createdAt))
    .limit(200);
}

/**
 * Wakes the agent's highest-priority ready issue when the agent has no live
 * run for it and no wake already in flight. One wake per pass: the next pass
 * (the next tick, or the next release) picks the next issue once this one has
 * a live run, so an agent with several ready tasks does not start them all at
 * once. Returns the outcome counts; the caller decides whether to log them.
 */
export async function idlePickupForAgent(
  deps: IdlePickupDeps,
  agent: { id: string; companyId: string },
  options: { excludeIssueId?: string | null } = {},
): Promise<IdlePickupResult> {
  const env = deps.env ?? process.env;
  if (!readIdlePickupEnabled(env)) return emptyIdlePickupResult();

  const [candidates, liveRuns] = await Promise.all([
    idlePickupCandidateRows(deps.db, agent.companyId, agent.id),
    deps.db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, agent.companyId),
          eq(heartbeatRuns.agentId, agent.id),
          inArray(heartbeatRuns.status, [...LIVE_HEARTBEAT_RUN_STATUSES]),
        ),
      ),
  ]);

  const result: IdlePickupResult = { ...emptyIdlePickupResult(), considered: candidates.length };
  if (candidates.length === 0) return result;

  const liveIssueIds = new Set(
    liveRuns
      .map((run) => readNonEmptyString(run.contextSnapshot?.issueId))
      .filter((id): id is string => Boolean(id)),
  );

  // Highest priority first, oldest blocked-transition breaks ties: the same
  // order the queued-run start path uses for one agent's runs.
  const ordered = [...candidates].sort((left, right) => {
    const leftRank = issuePriorityRank(left.priority);
    const rightRank = issuePriorityRank(right.priority);
    if (leftRank !== rightRank) return leftRank - rightRank;
    return (left.blockedTransitionAt?.getTime() ?? 0) - (right.blockedTransitionAt?.getTime() ?? 0);
  });

  for (const candidate of ordered) {
    // The release path passes the issue whose execution was just released:
    // that issue is the agent's PAST work, not the next one. Waking it again
    // turns finish → wake → run → finish into a loop that never settles (the
    // vendor fixtures keep a finished issue in a wakeable status). Even when
    // the issue is legitimately still open (a run that ended without closing
    // it), one more immediate wake is exactly the runaway this guard stops;
    // the periodic sweep re-evaluates it on its own cadence with the
    // just-released exclusion no longer applying.
    if (options.excludeIssueId && candidate.id === options.excludeIssueId) {
      result.alreadyActive += 1;
      continue;
    }
    if (liveIssueIds.has(candidate.id)) {
      result.alreadyActive += 1;
      continue;
    }
    // A wake already covers this issue in any non-terminal status (queued,
    // deferred_issue_execution, claimed — not only "queued"): the admission
    // path owns it; a second wake would only coalesce into the first anyway.
    const coveringWake = await deps.db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, agent.companyId),
          eq(agentWakeupRequests.agentId, agent.id),
          inArray(agentWakeupRequests.status, [
            "queued",
            "deferred_issue_execution",
            "claimed",
          ]),
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${candidate.id}`,
        ),
      )
      .limit(1)
      .then((rows) => Boolean(rows[0]));
    if (coveringWake) {
      result.alreadyActive += 1;
      continue;
    }

    const idempotencyKey = `${IDLE_WAKE_IDEMPOTENCY_PREFIX}:${candidate.id}`;
    try {
      const wake = await deps.enqueueWakeup(agent.id, {
        source: "automation",
        triggerDetail: "system",
        reason: IDLE_WAKE_REASON,
        idempotencyKey,
        requestedByActorType: "system",
        requestedByActorId: "idle_pickup",
        contextSnapshot: {
          issueId: candidate.id,
          taskKey: candidate.id,
          source: "idle_pickup",
        },
      });
      if (!wake) {
        // enqueueWakeup returns null for normal deferred/skipped paths (a
        // paused agent, admission limits, suppressed scheduling): the gates
        // did their job, this is not an error. The next tick retries.
        result.suppressed += 1;
        continue;
      }
      result.woken += 1;
      result.issueIds.push(candidate.id);
      await deps.logActivity?.({
        companyId: agent.companyId,
        actorType: "system",
        actorId: "idle_pickup",
        agentId: agent.id,
        runId: null,
        action: "issue.idle_pickup_wake_emitted",
        entityType: "issue",
        entityId: candidate.id,
        details: {
          identifier: candidate.identifier,
          priority: candidate.priority,
          idempotencyKey,
        },
      });
      return result;
    } catch (err) {
      // Best-effort: one issue that a concurrent wake, coalescing or an
      // execution blocker rejects is not a reason to fail the others.
      result.suppressed += 1;
      logger.warn(
        { err, agentId: agent.id, issueId: candidate.id },
        "idle-pickup wake failed for a ready assigned issue",
      );
      continue;
    }
  }
  return result;
}

/**
 * The scheduler-tick pass: runs `idlePickupForAgent` for every invokable,
 * non-paused agent of every active company, at most once per
 * `MYRMIDON_IDLE_PICKUP_INTERVAL_SEC` seconds. The tick handler owns the
 * actual timer; this function only remembers when the last pass ran so the
 * caller can skip ticks inside the interval.
 */
export interface IdlePickupSweeper {
  sweep(now?: Date): Promise<{ agentsChecked: number } & IdlePickupResult>;
  resetForTest(): void;
}

export interface IdlePickupSweeperDeps extends IdlePickupDeps {
  /** Invokability check for one agent (evaluateAgentInvokabilityFromDb): false for a paused agent. */
  isAgentInvokable: (agent: {
    id: string;
    companyId: string;
    name: string;
    reportsTo: string | null;
    status: string;
  }) => Promise<boolean>;
  /** Maintenance-mode gate (myrmidon R3): agents in a window are not woken. */
  isAgentUnderMaintenance: (agentId: string) => Promise<boolean>;
}

export function createIdlePickupSweeper(deps: IdlePickupSweeperDeps): IdlePickupSweeper {
  let lastSweepAtMs = 0;
  return {
    resetForTest() {
      lastSweepAtMs = 0;
    },
    async sweep(now = new Date()) {
      const env = deps.env ?? process.env;
      const intervalMs = readIdlePickupIntervalSec(env) * 1000;
      if (!readIdlePickupEnabled(env)) return { agentsChecked: 0, ...emptyIdlePickupResult() };
      if (now.getTime() - lastSweepAtMs < intervalMs) {
        return { agentsChecked: 0, ...emptyIdlePickupResult() };
      }
      lastSweepAtMs = now.getTime();

      const rows = await deps.db
        .select({
          id: agents.id,
          companyId: agents.companyId,
          name: agents.name,
          reportsTo: agents.reportsTo,
          status: agents.status,
        })
        .from(agents)
        .innerJoin(companies, eq(companies.id, agents.companyId))
        .where(eq(companies.status, "active"));

      const totals: IdlePickupResult = emptyIdlePickupResult();
      let agentsChecked = 0;
      for (const agent of rows) {
        // Invokability covers pause, termination and a broken reporting
        // chain; the maintenance gate covers the maintenance window. A wake
        // for a paused agent would be skipped by enqueueWakeup anyway, but
        // skipping earlier keeps the sweep off the admission path.
        if (!(await deps.isAgentInvokable(agent))) continue;
        if (await deps.isAgentUnderMaintenance(agent.id)) continue;
        agentsChecked += 1;
        const perAgent = await idlePickupForAgent(deps, agent);
        totals.woken += perAgent.woken;
        totals.alreadyActive += perAgent.alreadyActive;
        totals.suppressed += perAgent.suppressed;
        totals.issueIds.push(...perAgent.issueIds);
      }
      if (totals.woken > 0) {
        logger.warn(
          { woken: totals.woken, issueIds: totals.issueIds, agentsChecked },
          "idle pickup woke ready assigned issues",
        );
      }
      return { agentsChecked, ...totals };
    },
  };
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  return value;
}
