// myrmidon(1.6-SWARM-CLAIM-B): the supervisor's rebalance action.
//
// One action: release a live lease so the task returns to its role queue and
// the next agent of that role is woken immediately. The claim table and the
// release path belong to part A (`server/src/myrmidon/swarm-claim/`): when
// part A's `releaseClaim` is importable it is used (it also writes the
// `issue.swarm_claim.released` activity); otherwise the port falls back to a
// direct `UPDATE issue_claims SET released_at` and this module writes its own
// audit record. Part B never re-assigns an issue by hand — the queue decides.

import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { SWARM_CLAIM_QUEUE_WAKE_REASON, type SwarmSupervisorReadPort } from "./view.js";
import { createSwarmSupervisorDbPort } from "./view.js";

export const SUPERVISOR_RELEASE_REASON = "supervisor_rebalance";
export const SWARM_CLAIM_SUPERVISOR_RELEASE_ACTION = "issue.swarm_claim_supervisor_release";

export interface SwarmReleaseLeaseResult {
  released: boolean;
  claimId: string;
  issueId: string | null;
  wokenAgentId: string | null;
  reason: string;
}

export class ClaimNotFoundError extends Error {
  constructor(claimId: string) {
    super(`claim ${claimId} not found`);
    this.name = "ClaimNotFoundError";
  }
}

export class ClaimNotLiveError extends Error {
  readonly code = "claim_not_live";
  constructor(claimId: string) {
    super(`claim ${claimId} is not live`);
    this.name = "ClaimNotLiveError";
  }
}

export interface SwarmRebalanceDeps {
  port: SwarmSupervisorReadPort;
  /** Board wake admission path; every limit and gate is enforced inside it. */
  enqueueWakeup: (
    agentId: string,
    opts: {
      source?: "automation";
      triggerDetail?: "system";
      reason?: string;
      idempotencyKey?: string;
      contextSnapshot?: Record<string, unknown>;
    },
  ) => Promise<unknown>;
  /** Optional activity log; absent in unit tests. */
  logActivity?: (input: {
    companyId: string;
    actorType: "user" | "system";
    actorId: string;
    agentId: string | null;
    runId: null;
    action: string;
    entityType: string;
    entityId: string;
    details: Record<string, unknown>;
  }) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  now(): Date;
}

function toDate(value: Date | string | null): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Release a live lease and wake the next agent of the role. Throws
 * `ClaimNotFoundError` / `ClaimNotLiveError` for the 404/409 cases; returns
 * `released: false` only when part A's release path declined the release.
 */
export async function releaseLeaseForRebalance(
  deps: SwarmRebalanceDeps,
  companyId: string,
  claimId: string,
  reasonInput?: string,
  actor?: { actorType?: "user" | "agent" | "system"; actorId?: string | null },
): Promise<SwarmReleaseLeaseResult> {
  const reason = reasonInput?.trim() ? reasonInput.trim() : SUPERVISOR_RELEASE_REASON;
  const nowMs = deps.now().getTime();

  const claimRows = await deps.port.listClaimRows(companyId);
  const claim = claimRows.find((row) => row.claim_id === claimId);
  if (!claim) throw new ClaimNotFoundError(claimId);
  if (toDate(claim.released_at) !== null) throw new ClaimNotLiveError(claimId);
  const expiresAt = toDate(claim.expires_at);
  if (expiresAt && expiresAt.getTime() < nowMs) throw new ClaimNotLiveError(claimId);

  const [agents, liveRunAgents, ttlCap] = await Promise.all([
    deps.port.listAgents(companyId),
    deps.port.liveRunAgentIds(companyId),
    deps.port.maxActiveTasksPerAgent(),
  ]);
  const holder = agents.find((agent) => agent.agent_id === claim.agent_id) ?? null;
  const role = holder?.role ?? "general";

  // Count the holder's remaining live claims (excluding the one being
  // released) to know whether the role still needs a wake.
  const activeByAgent = new Map<string, number>();
  for (const row of claimRows) {
    if (toDate(row.released_at) !== null) continue;
    if (row.claim_id === claimId) continue;
    activeByAgent.set(row.agent_id, (activeByAgent.get(row.agent_id) ?? 0) + 1);
  }

  const released = await releaseThroughPort(deps, companyId, claimId, reason, deps.now());
  if (!released) {
    // Part A's release path declined (for example the claim was released
    // concurrently); report it without a wake.
    return { released: false, claimId, issueId: claim.issue_id, wokenAgentId: null, reason };
  }

  // Wake the next agent of the role: idle (no live run), under the cap, not
  // the holder that just lost the lease. All admission gates (pause,
  // maintenance, limits, concurrency, budget) are enforced by enqueueWakeup
  // itself; if no agent qualifies the periodic claim sweep still returns the
  // task to circulation.
  let wokenAgentId: string | null = null;
  const cap = typeof ttlCap === "number" && ttlCap > 0 ? ttlCap : null;
  const candidates = agents
    .filter((agent) => agent.role === role)
    .filter((agent) => agent.agent_id !== claim.agent_id)
    .filter((agent) => agent.status !== "paused" && agent.status !== "error")
    .filter((agent) => !liveRunAgents.has(agent.agent_id))
    .filter((agent) => cap === null || (activeByAgent.get(agent.agent_id) ?? 0) < cap)
    .sort((a, b) => (activeByAgent.get(a.agent_id) ?? 0) - (activeByAgent.get(b.agent_id) ?? 0));
  const wakeTarget = candidates[0];
  if (wakeTarget) {
    try {
      await deps.enqueueWakeup(wakeTarget.agent_id, {
        source: "automation",
        triggerDetail: "system",
        reason: SWARM_CLAIM_QUEUE_WAKE_REASON,
        idempotencyKey: `swarm_claim_rebalance:${claimId}`,
        contextSnapshot: { issueId: claim.issue_id },
      });
      wokenAgentId = wakeTarget.agent_id;
    } catch {
      // The wake is best-effort: the periodic claim sweep is the safety net.
      wokenAgentId = null;
    }
  }

  if (deps.logActivity) {
    try {
      await deps.logActivity({
        companyId,
        actorType: actor?.actorType === "agent" ? "agent" : actor?.actorType === "system" ? "system" : "user",
        actorId: actor?.actorId ?? "board",
        agentId: claim.agent_id,
        runId: null,
        action: SWARM_CLAIM_SUPERVISOR_RELEASE_ACTION,
        entityType: "issue",
        entityId: claim.issue_id,
        details: {
          claimId,
          reason,
          wokenAgentId,
          via: "supervisor_rebalance",
        },
      });
    } catch {
      // Audit is best-effort; the release already happened.
    }
  }

  return { released: true, claimId, issueId: claim.issue_id, wokenAgentId, reason };
}

/**
 * Prefer part A's `releaseClaim` (it owns the semantics and its activity
 * record); fall back to the direct UPDATE on the shared claim table.
 */
async function releaseThroughPort(
  deps: SwarmRebalanceDeps,
  companyId: string,
  claimId: string,
  reason: string,
  now: Date,
): Promise<boolean> {
  const release = await resolvePartARelease();
  if (release) {
    try {
      const db = (deps.port as { db?: Db }).db;
      if (db) return await release(db, { claimId, reason, now });
    } catch {
      // fall through to the direct path
    }
  }
  return deps.port.releaseClaim(companyId, claimId, reason, now);
}

interface PartAReleaseClaim {
  (db: Db, input: { claimId: string; reason: string; now?: Date; releasedStatus?: string }): Promise<boolean>;
}

/** Part A's store module path; a non-literal specifier so this compiles first. */
const PART_A_STORE_MODULE = "../swarm-claim/store.js";

async function resolvePartARelease(): Promise<PartAReleaseClaim | null> {
  try {
    const specifier = PART_A_STORE_MODULE;
    const mod = (await import(specifier)) as Record<string, unknown>;
    const candidate = mod["releaseClaim"];
    return typeof candidate === "function" ? (candidate as PartAReleaseClaim) : null;
  } catch {
    return null;
  }
}

/**
 * Extend the shared read port with the release write. The db implementation
 * prefers part A's function (see releaseThroughPort) and otherwise performs
 * the additive UPDATE itself.
 */
export interface SwarmSupervisorReleasePort extends SwarmSupervisorReadPort {
  releaseClaim(companyId: string, claimId: string, reason: string, now: Date): Promise<boolean>;
}

export function createSwarmSupervisorReleasePort(
  db: Db,
  env: NodeJS.ProcessEnv = process.env,
): SwarmSupervisorReleasePort {
  const base = createSwarmSupervisorDbPort(db, env);
  return {
    ...base,
    async releaseClaim(companyId, claimId, reason, now) {
      const releasedAt = new Date(now).toISOString();
      // The fallback keeps part A's release-history invariant: the reason is
      // written next to releasedAt, so the supervisor view can tell a
      // supervisor release from an expired lease. Once part A's store is
      // importable (after its merge) this whole fallback goes away and the
      // dynamic `releaseClaim` import becomes the only release path.
      const releasedReason = reason || SUPERVISOR_RELEASE_REASON;
      const rows = await db.execute(sql`
        UPDATE issue_claims
        SET released_at = ${releasedAt}, released_reason = ${releasedReason}
        WHERE company_id = ${companyId}
          AND id = ${claimId}
          AND released_at IS NULL
        RETURNING id
      `);
      return Array.isArray(rows) && rows.length > 0;
    },
  };
}