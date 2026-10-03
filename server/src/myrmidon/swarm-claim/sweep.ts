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
// Modelled on leases-stale-sweep.ts: one bounded page per pass, one release
// per row with the reason recorded, a best-effort wake, a failure leaves the
// row for the next pass.

import {
  SWARM_CLAIM_QUEUE_ISSUE_STATUSES,
  SWARM_CLAIM_RELEASE_REASON_ISSUE_CLOSED,
  SWARM_CLAIM_RELEASE_REASON_LEASE_EXPIRED,
  SWARM_CLAIM_RELEASED_ACTION,
  isSwarmLeaseExpired,
  resolveSwarmClaimSettings,
} from "@paperclipai/shared";
import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { wakeNextAgentForIssueRole, type SwarmClaimServicePorts } from "./service.js";
import { listClaimsOnNonQueueIssues, listExpiredClaims, releaseClaim } from "./store.js";

/** The sweep inspects at most this many claims per pass. */
export const SWARM_CLAIM_SWEEP_PAGE_SIZE = 50;

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