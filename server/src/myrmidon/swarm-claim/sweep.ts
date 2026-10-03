// server/src/myrmidon/swarm-claim/sweep.ts
//
// myrmidon(1.6-SWARM): the expired-lease sweep.
//
// This pass is what makes the acceptance criterion true: "an idle agent with a
// non-empty queue of its role cannot exist longer than one lease period". A
// lease that ran out stops covering its task, so the task is back in the
// queue — but nothing has *told* anyone that. The sweep releases the expired
// rows (making the return durable, not just implicit) and wakes the next agent
// of the task's role, on a cadence (default 30 s) far shorter than the lease
// TTL (default 15 minutes).
//
// It also releases claims whose task left the queue (closed or moved on): a
// `done` task must not occupy an agent's ceiling until its lease runs out.
//
// myrmidon(1.6.1 SWARM-IDLE-WAKE): the third pass. Releasing a lease was the
// only wake trigger; a task that was never claimed (created unassigned, or
// reassigned away) woke no one, and the free agents of the role sat idle next
// to a non-empty queue (the 03.10 fact: two ready tasks, three idle
// engineers, zero wakes). The idle pass pairs "role with a non-empty ready
// queue" with "free agents of the role" (no live claim, under the ceiling,
// not paused, no live run) and wakes the missing number, batches of at most
// MYRMIDON_SWARM_IDLE_WAKE_BATCH (default 5), each wake bound to the top task
// of the queue in claim order (critical first, oldest second). The claim
// itself still happens on the woken run's checkout — this pass only delivers
// the wake; every admission gate (pause, maintenance, limits, budget) stays
// inside enqueueWakeup.
//
// Modelled on leases-stale-sweep.ts: one bounded page per pass, one release
// per row with the reason recorded, a best-effort wake, a failure leaves the
// row for the next pass.

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { companies, agentWakeupRequests, issues, issueClaims, type Db } from "@paperclipai/db";
import {
  SWARM_CLAIM_QUEUE_ISSUE_STATUSES,
  SWARM_CLAIM_RELEASE_REASON_ISSUE_CLOSED,
  SWARM_CLAIM_RELEASE_REASON_LEASE_EXPIRED,
  SWARM_CLAIM_RELEASED_ACTION,
  SWARM_CLAIM_WAKE_REASON,
  isSwarmLeaseExpired,
  isSwarmClaimEnabledFor,
  resolveSwarmClaimSettings,
  type CompanyCaste,
  type SwarmClaimSettings,
} from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { wakeNextAgentForIssueRole, type SwarmClaimServicePorts } from "./service.js";
import { listClaimsOnNonQueueIssues, listExpiredClaims, releaseClaim } from "./store.js";
import { listIdleRolePairs, liveClaimCountsByAgent } from "./idle-queue.js";
import { idleWakeTargetsForRole, idleWakeIdempotencyKey, type SwarmRoleIdleInput } from "./idle-wake.js";

/** The sweep inspects at most this many claims per pass. */
export const SWARM_CLAIM_SWEEP_PAGE_SIZE = 50;

/** myrmidon(1.6.1 SWARM-IDLE-WAKE): how many agents one idle pass may wake. */
export const SWARM_IDLE_WAKE_BATCH_ENV = "MYRMIDON_SWARM_IDLE_WAKE_BATCH";
export const DEFAULT_SWARM_IDLE_WAKE_BATCH = 5;
export const MIN_SWARM_IDLE_WAKE_BATCH = 1;
export const MAX_SWARM_IDLE_WAKE_BATCH = 25;

/**
 * The idle-wake batch cap. A numeric env value in range wins; anything else
 * (unset, non-numeric, out of range) falls back to the default of 5.
 */
export function readSwarmIdleWakeBatch(env: Record<string, string | undefined>): number {
  const raw = env[SWARM_IDLE_WAKE_BATCH_ENV]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_SWARM_IDLE_WAKE_BATCH;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return DEFAULT_SWARM_IDLE_WAKE_BATCH;
  return Math.min(Math.max(value, MIN_SWARM_IDLE_WAKE_BATCH), MAX_SWARM_IDLE_WAKE_BATCH);
}

export interface SwarmClaimSweepResult {
  inspected: number;
  /** Expired leases released this pass. */
  expiredReleased: number;
  /** Leases released because their task left the queue. */
  closedReleased: number;
  /** Release attempts that threw; the row stays for the next pass. */
  failed: number;
  /** Agents woken to re-take released work. */
  woken: number;
  /** myrmidon(1.6.1 SWARM-IDLE-WAKE): free agents woken on a non-empty queue. */
  idleWoken: number;
  /** Roles with a non-empty ready queue the idle pass examined. */
  idleRoles: number;
  /** Free agents seen at a non-empty queue (the supervisor's zero metric). */
  idleFreeAgents: number;
}

/** The sweeper runtime, created once per server process (see index.ts). */
export interface SwarmClaimSweeper {
  sweep(now?: Date): Promise<SwarmClaimSweepResult>;
  resetForTest(): void;
}

export interface SwarmClaimSweeperDeps extends SwarmClaimServicePorts {
  /** Minimal spacing between two passes; the scheduler ticks more often. */
  intervalMs: number;
}

export function createSwarmClaimSweeper(deps: SwarmClaimSweeperDeps): SwarmClaimSweeper {
  let lastSweepAtMs = 0;
  return {
    resetForTest() {
      lastSweepAtMs = 0;
    },
    async sweep(now = new Date()) {
      const result: SwarmClaimSweepResult = {
        inspected: 0,
        expiredReleased: 0,
        closedReleased: 0,
        failed: 0,
        woken: 0,
        idleWoken: 0,
        idleRoles: 0,
        idleFreeAgents: 0,
      };
      const general = (await deps.settings.getGeneral()) as unknown as Record<string, unknown>;
      const { settings } = resolveSwarmClaimSettings({
        stored: general.swarmClaim,
        env: deps.env ?? process.env,
      });

      // 1.6.1 (SWARM-SETTINGS-UI): the interval is live. The constructed
      // `intervalMs` stays the floor (the scheduler ticks at least that often);
      // a longer stored interval spreads the passes further apart without a
      // restart, exactly like the other pilot parameters.
      const liveIntervalMs = Math.max(
        deps.intervalMs,
        settings.sweepIntervalSec * 1000,
      );
      if (now.getTime() - lastSweepAtMs < liveIntervalMs) return result;
      lastSweepAtMs = now.getTime();

      // 1.6.1 (SWARM-SETTINGS-UI): a disable leaves live leases behind — the
      // runs holding them will finish on their own, but the leases must not
      // outlive the feature. When the pilot is off (or an env override turned
      // it off after claims existed), release every live claim whose task is
      // still in the queue, with the reason recorded, then stop. This is the
      // "выключение действует сразу, текущие аренды освобождаются корректно"
      // half of the acceptance criteria; the still-queued task needs no wake
      // because vendor assignment behavior takes over.
      if (!settings.enabled) {
        if (await swarmClaimTableReachable(deps.db)) {
          const released = await releaseAllLiveClaims(deps, now, "disabled");
          result.closedReleased += released.released;
          result.failed += released.failed;
        }
        return result;
      }

      const expiredRows = await listExpiredClaims(deps.db, null, now, SWARM_CLAIM_SWEEP_PAGE_SIZE);
      const closedRows = await listClaimsOnNonQueueIssues(
        deps.db,
        null,
        [...SWARM_CLAIM_QUEUE_ISSUE_STATUSES],
        SWARM_CLAIM_SWEEP_PAGE_SIZE,
      );

      for (const row of expiredRows) {
        result.inspected += 1;
        const lease = {
          id: row.id,
          issueId: row.issueId,
          agentId: row.agentId,
          heartbeatAt: row.heartbeatAt,
          expiresAt: row.expiresAt,
          releasedAt: row.releasedAt,
        };
        if (!isSwarmLeaseExpired(lease, now)) continue;
        try {
          const released = await releaseClaim(deps.db, {
            claimId: row.id,
            reason: SWARM_CLAIM_RELEASE_REASON_LEASE_EXPIRED,
            now,
          });
          if (!released) continue;
          result.expiredReleased += 1;
          await deps.logActivity?.({
            companyId: row.companyId,
            actorType: "system",
            actorId: "swarm_claim_sweep",
            agentId: row.agentId,
            runId: row.runId,
            action: SWARM_CLAIM_RELEASED_ACTION,
            entityType: "issue",
            entityId: row.issueId,
            details: { reason: SWARM_CLAIM_RELEASE_REASON_LEASE_EXPIRED, claimId: row.id },
          });
          // Best-effort wake: the queue itself still holds the task even when
          // the wake is deferred, and the next pass tries again.
          const woke = await wakeNextAgentForIssueRole(deps, {
            companyId: row.companyId,
            issueId: row.issueId,
            excludeAgentId: row.agentId,
            idempotencySuffix: "sweep",
            now,
          }).catch(() => false);
          if (woke) result.woken += 1;
        } catch {
          result.failed += 1;
          logger.warn(
            { claimId: row.id, issueId: row.issueId },
            "swarm claim sweep release failed; the row stays for the next pass",
          );
        }
      }

      for (const row of closedRows) {
        result.inspected += 1;
        try {
          const released = await releaseClaim(deps.db, {
            claimId: row.id,
            reason: SWARM_CLAIM_RELEASE_REASON_ISSUE_CLOSED,
            now,
          });
          if (released) result.closedReleased += 1;
        } catch {
          result.failed += 1;
        }
      }

      // myrmidon(1.6.1 SWARM-IDLE-WAKE): the idle pass. Runs after the
      // release passes so this tick's releases are already back in the queue
      // the pair read sees. One company at a time, bounded by the batch cap.
      try {
        const idle = await sweepIdleWakes(deps, { settings, now, result });
        if (idle.idleWoken > 0) {
          logger.warn(
            {
              idleWoken: idle.idleWoken,
              idleRoles: idle.idleRoles,
              idleFreeAgents: idle.idleFreeAgents,
            },
            "swarm idle wake pass woke free agents on a non-empty role queue",
          );
        }
      } catch {
        // CONSTANT errorKind only (the exception can carry a credential).
        logger.warn(
          { errorKind: "swarm_idle_wake_failed" },
          "swarm idle wake pass failed; the next tick retries",
        );
      }
      return result;
    },
  };
}

/**
 * 1.6.1 (SWARM-SETTINGS-UI): true when the claim table can be read at all —
 * the disable path probes it the same cheap way the supervisor view does, so
 * an instance without the table (part A never merged) skips the release pass.
 */
async function swarmClaimTableReachable(db: Db): Promise<boolean> {
  const { swarmClaimTableReady } = await import("./store.js");
  return swarmClaimTableReady(db);
}

/** The release reason written when a disable frees a live lease. */
export const SWARM_CLAIM_RELEASE_REASON_DISABLED = "pilot_disabled";

/**
 * 1.6.1 (SWARM-SETTINGS-UI): release every live claim, one bounded page per
 * pass. Bounded on purpose: a huge claim table empties over a few passes of
 * the sweep instead of one long transaction, and each release is its own row
 * write with its own activity entry, exactly like the expiry path.
 */
async function releaseAllLiveClaims(
  deps: SwarmClaimSweeperDeps,
  now: Date,
  _why: string,
): Promise<{ released: number; failed: number }> {
  const { listAllLiveClaims, releaseClaim } = await import("./store.js");
  let released = 0;
  let failed = 0;
  const rows = await listAllLiveClaims(deps.db, SWARM_CLAIM_SWEEP_PAGE_SIZE);
  for (const row of rows) {
    try {
      const ok = await releaseClaim(deps.db, {
        claimId: row.id,
        reason: SWARM_CLAIM_RELEASE_REASON_DISABLED,
        now,
      });
      if (!ok) continue;
      released += 1;
      await deps.logActivity?.({
        companyId: row.companyId,
        actorType: "system",
        actorId: "swarm_claim_sweep",
        agentId: row.agentId,
        runId: row.runId,
        action: SWARM_CLAIM_RELEASED_ACTION,
        entityType: "issue",
        entityId: row.issueId,
        details: { reason: SWARM_CLAIM_RELEASE_REASON_DISABLED, claimId: row.id },
      });
    } catch {
      failed += 1;
    }
  }
  return { released, failed };
}

/** The companies the idle pass visits: active ones only, bounded page. */
export async function listActiveCompanies(db: Db, limit = 50): Promise<string[]> {
  const rows = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.status, "active"))
    .limit(limit);
  return rows.map((row) => row.id);
}

async function sweepIdleWakes(
  deps: SwarmClaimServicePorts & { db: Db },
  input: {
    settings: Pick<
      SwarmClaimSettings,
      | "enabled"
      | "enabledCompanyIds"
      | "enabledRoles"
      | "maxActiveTasks"
      | "p0Preemption"
    >;
    now: Date;
    result: SwarmClaimSweepResult;
  },
): Promise<SwarmClaimSweepResult> {
  const { result } = input;
  const env = (deps as { env?: Record<string, string | undefined> }).env ?? process.env;
  const batch = readSwarmIdleWakeBatch(env);
  const companyIds = await listActiveCompanies(deps.db);
  const liveCompanyClaims = await Promise.all(
    companyIds.map((companyId) => liveClaimCountsByAgent(deps.db, companyId)),
  );
  const claimCounts = new Map<string, number>();
  for (const counts of liveCompanyClaims) {
    for (const [agentId, count] of counts) claimCounts.set(agentId, count);
  }

  for (const companyId of companyIds) {
    const pairs = await listIdleRolePairs(deps.db, companyId);
    // myrmidon(1.6.1 SWARM-IDLE-WAKE): the pilot gate. A role outside the
    // pilot set (or a company outside the pilot company list) must not be
    // woken: its claim answers `disabled`, the run ends with nothing, and the
    // next tick would wake it again — an endless wake loop the ticket forbids
    // ("лид и ревьюеры в очередь разработки не входят").
    const pilotPairs = pairs.filter((pair) =>
      isSwarmClaimEnabledFor(input.settings, { companyId, role: pair.role }),
    );
    // myrmidon(1.6.1 CUSTOM-CASTES B): the same caste directory the claim gate
    // reads. `swarmEligible=false` castes never enter the idle pool; a
    // caste-set ceiling overrides the global one for that agent only.
    const casteByRole = deps.castes
      ? new Map((await deps.castes(companyId)).map((entry) => [entry.key, entry]))
      : new Map<string, CompanyCaste>();
    for (const pair of pilotPairs) {
      const caste = casteByRole.get(pair.role);
      if (caste && !caste.swarmEligible) continue;
      const effectiveMaxActiveTasks =
        caste?.maxActiveTasks != null ? caste.maxActiveTasks : input.settings.maxActiveTasks;
      const roleInput: SwarmRoleIdleInput = {
        role: pair.role,
        queue: pair.queue,
        liveClaims: [], // claim coverage of the queue is checked per target below
        agents: pair.agents.map((agent) => ({
          id: agent.id,
          activeClaims: claimCounts.get(agent.id) ?? 0,
          maxActiveTasks: effectiveMaxActiveTasks,
          status: agent.status,
          hasLiveRun: agent.hasLiveRun,
        })),
      };
      const targets = idleWakeTargetsForRole(roleInput, {
        batchLimit: batch,
        now: input.now,
        p0Preemption: input.settings.p0Preemption,
      });
      result.idleRoles += 1;
      result.idleFreeAgents += targets.length;
      for (const target of targets) {
        // A live claim or a queued/claimed wake already covers the task: the
        // admission path owns it; the next pass re-evaluates. This is the
        // fact-based idempotency (the key is tracing only, like idle-pickup).
        const covered = await issueHasLiveClaimOrWake(deps.db, companyId, target);
        if (covered) {
          result.idleFreeAgents -= 1;
          continue;
        }
        try {
          const woke = await enqueueIdleWake(deps, companyId, target);
          if (woke) result.idleWoken += 1;
        } catch {
          // Best-effort per target: one failure does not fail the pass.
          logger.warn(
            { agentId: target.agentId, issueId: target.issueId },
            "swarm idle wake target failed; the next pass retries",
          );
        }
      }
    }
  }
  return result;
}

/** True when a live claim or a pending wake already covers the task. */
export async function issueHasLiveClaimOrWake(
  db: Db,
  companyId: string,
  target: { issueId: string; agentId: string },
): Promise<boolean> {
  const claimRow = await db
    .select({ id: issueClaims.id })
    .from(issueClaims)
    .where(and(eq(issueClaims.issueId, target.issueId), isNull(issueClaims.releasedAt)))
    .limit(1);
  if (claimRow.length > 0) return true;
  const wakeRow = await db
    .select({ id: agentWakeupRequests.id })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, companyId),
        inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution", "claimed"]),
        sql`${agentWakeupRequests.payload} ->> 'issueId' = ${target.issueId}`,
      ),
    )
    .limit(1);
  if (wakeRow.length > 0) return true;
  // The task may already be in progress under another agent since the queue
  // read — re-read its status; anything outside the queue statuses is covered.
  const statusRow = await db
    .select({ status: issues.status })
    .from(issues)
    .where(and(eq(issues.id, target.issueId), eq(issues.companyId, companyId)))
    .limit(1);
  const status = statusRow[0]?.status;
  if (status && !([...SWARM_CLAIM_QUEUE_ISSUE_STATUSES] as readonly string[]).includes(status)) {
    return true;
  }
  return false;
}

async function enqueueIdleWake(
  deps: SwarmClaimServicePorts,
  companyId: string,
  target: { agentId: string; issueId: string; identifier: string | null; priority: string | null; role: string },
): Promise<boolean> {
  if (!deps.enqueueWakeup) return false;
  const wake = await deps.enqueueWakeup(target.agentId, {
    source: "automation",
    triggerDetail: "system",
    reason: SWARM_CLAIM_WAKE_REASON,
    idempotencyKey: idleWakeIdempotencyKey(target),
    requestedByActorType: "system",
    requestedByActorId: "swarm_idle_wake",
    contextSnapshot: {
      issueId: target.issueId,
      taskId: target.issueId,
      taskKey: target.issueId,
      source: "swarm_idle_wake",
      wakeReason: SWARM_CLAIM_WAKE_REASON,
      queueRole: target.role,
    },
  });
  return Boolean(wake);
}
