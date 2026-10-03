// server/src/myrmidon/swarm-claim/domain.ts
//
// myrmidon(1.6-SWARM): the pure part of the per-role task queues.
//
// Everything that is a decision about *which* task an agent should take, and
// *whether* a lease still covers its task, lives here with no database and no
// clock of its own: the caller passes `now`, the store passes rows. That keeps
// the two acceptance criteria of 1.6 ("a critical task preempts the queue",
// "an expired lease returns the task to the queue") testable without a database,
// and it leaves one file that both the core and the supervisor view read, so
// the two cannot disagree about what "the top of the queue" is.

import {
  isSwarmLeaseExpired,
  isSwarmLeaseLive,
  orderSwarmQueueCandidates,
  swarmActiveTaskLimitReached,
  swarmLeaseExpiresAt,
  swarmPriorityRank,
  type SwarmClaimLease,
  type SwarmClaimSettings,
  type SwarmQueueCandidate,
} from "@paperclipai/shared";

export {
  isSwarmLeaseExpired,
  isSwarmLeaseLive,
  orderSwarmQueueCandidates,
  swarmActiveTaskLimitReached,
  swarmLeaseExpiresAt,
  swarmPriorityRank,
};
export type { SwarmClaimLease, SwarmQueueCandidate };

/**
 * The live lease of one task, or null. A task may not have two live claims: the
 * queue refuses to hand out a task whose live lease exists, and a re-claim after
 * an expiry is written as a release of the old row plus a new claim, so this
 * picks the newest live row when a race left more than one.
 */
export function pickLiveClaim(
  claims: readonly SwarmClaimLease[],
  now: Date = new Date(),
): SwarmClaimLease | null {
  const live = claims.filter((claim) => isSwarmLeaseLive(claim, now));
  if (live.length === 0) return null;
  return live.reduce((newest, claim) => (claimedAtMs(claim) >= claimedAtMs(newest) ? claim : newest));
}

function claimedAtMs(claim: SwarmClaimLease): number {
  const raw = (claim as { claimedAt?: Date | number | string | null }).claimedAt ?? null;
  if (raw === null) return 0;
  if (raw instanceof Date) return raw.getTime();
  if (typeof raw === "number") return raw;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Issues that carry a live claim — the set the queue must not hand out again. */
export function liveClaimIssueIds(
  claims: readonly SwarmClaimLease[],
  now: Date = new Date(),
): Set<string> {
  return new Set(claims.filter((claim) => isSwarmLeaseLive(claim, now)).map((claim) => claim.issueId));
}

/**
 * One agent's queue: the role's candidate tasks minus the ones a live claim
 * already covers, in queue order. `heldIssueIds` is the agent's *own* live
 * claims and is excluded for the same reason — a second claim on work the agent
 * already holds would spend its ceiling twice on one task.
 */
export function selectQueueForAgent(input: {
  candidates: readonly SwarmQueueCandidate[];
  liveClaims: readonly SwarmClaimLease[];
  now?: Date;
}): SwarmQueueCandidate[] {
  const now = input.now ?? new Date();
  const covered = liveClaimIssueIds(input.liveClaims, now);
  return orderSwarmQueueCandidates(input.candidates).filter(
    (candidate) => !covered.has(candidate.issueId),
  );
}

/**
 * The one task an agent should take now, or null when it may not take any:
 * nothing in the queue, the agent is already at its ceiling, or the pilot is
 * off. The ceiling is checked before the queue is walked, so a capped agent
 * never even looks like it is about to take work.
 */
export function nextQueueTaskForAgent(input: {
  candidates: readonly SwarmQueueCandidate[];
  liveClaims: readonly SwarmClaimLease[];
  activeTasks: number;
  settings: Pick<SwarmClaimSettings, "maxActiveTasks" | "enabled">;
  now?: Date;
}): SwarmQueueCandidate | null {
  if (!input.settings.enabled) return null;
  if (swarmActiveTaskLimitReached(input.activeTasks, input.settings)) return null;
  const queue = selectQueueForAgent({
    candidates: input.candidates,
    liveClaims: input.liveClaims,
    now: input.now,
  });
  return queue[0] ?? null;
}

/** A claim the store should write; the expiry is already stamped. */
export interface SwarmClaimPlan {
  issueId: string;
  agentId: string;
  role: string | null;
  runId: string | null;
  claimedAt: Date;
  heartbeatAt: Date;
  expiresAt: Date;
}

/**
 * The row to write when an agent takes a task. The expiry is always exactly one
 * TTL ahead of the same `now` the claim is stamped with, so a claim taken at
 * the top of a pass and refreshed at the bottom cannot land outside the window.
 */
export function planClaim(input: {
  issueId: string;
  agentId: string;
  role: string | null;
  runId: string | null;
  now: Date;
  settings: Pick<SwarmClaimSettings, "leaseTtlSec">;
}): SwarmClaimPlan {
  return {
    issueId: input.issueId,
    agentId: input.agentId,
    role: input.role,
    runId: input.runId,
    claimedAt: input.now,
    heartbeatAt: input.now,
    expiresAt: swarmLeaseExpiresAt(input.now, input.settings),
  };
}

/** Whether the lease still covers its task at `now` — the read the sweep and the wake paths make. */
export function claimCovers(claim: SwarmClaimLease | null, now: Date = new Date()): boolean {
  return claim !== null && isSwarmLeaseLive(claim, now);
}

/**
 * The lease refresh a heartbeat performs: push `expiresAt` one TTL past `now`
 * and stamp `heartbeatAt`. Returns null for a lease that is already released —
 * a heartbeat must not resurrect a released row.
 */
export function planLeaseHeartbeat(input: {
  claim: SwarmClaimLease;
  now: Date;
  settings: Pick<SwarmClaimSettings, "leaseTtlSec">;
}): { heartbeatAt: Date; expiresAt: Date } | null {
  if (input.claim.releasedAt !== null && input.claim.releasedAt !== undefined) return null;
  return {
    heartbeatAt: input.now,
    expiresAt: swarmLeaseExpiresAt(input.now, input.settings),
  };
}

/**
 * True when the issue's own state makes its claim pointless: the task left the
 * queue (not `todo` any more) or it was closed. The sweep releases such claims
 * rather than waiting out the TTL, so a task that reached `done` does not keep
 * an agent's ceiling occupied until its lease runs out.
 */
export function claimShouldReleaseForIssue(input: {
  issueStatus: string | null;
  queueStatuses?: readonly string[];
}): boolean {
  const queueStatuses = input.queueStatuses ?? ["todo"];
  if (input.issueStatus === null) return false;
  return !queueStatuses.includes(input.issueStatus);
}