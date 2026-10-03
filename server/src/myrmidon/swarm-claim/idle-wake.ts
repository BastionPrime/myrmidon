// server/src/myrmidon/swarm-claim/idle-wake.ts
//
// myrmidon(1.6.1 SWARM-IDLE-WAKE): the pure decision core of the idle pass.
//
// The fact of 03.10: three engineers sat idle while two ready unassigned tasks
// waited in the engineer queue. The lease sweep only wakes on a release; it
// never looks at "queue non-empty AND free agents exist". This module decides
// exactly that pair, without a database and without a clock of its own, so the
// verdict matrix (limit, P0, batch cap, paused, castes) is testable in unit
// tests and the sweep only executes what the policy decided.

import {
  orderSwarmQueueCandidates,
  swarmActiveTaskLimitReached,
  type SwarmClaimLease,
  type SwarmQueueCandidate,
} from "@paperclipai/shared";

/** One candidate wake target the sweep judged free. */
export interface SwarmIdleWakeTarget {
  agentId: string;
  /** The top queue task this agent's claim would take — the wake binds to it. */
  issueId: string;
  identifier: string | null;
  priority: string | null;
  role: string;
}

/** The idle read of one role, as the queue reads assemble it. */
export interface SwarmRoleIdleInput {
  role: string;
  /** The role's ready queue candidates, un-ordered (order applied here). */
  queue: readonly SwarmQueueCandidate[];
  /** Live (not released, un-expired) claims of the whole company. */
  liveClaims: readonly SwarmClaimLease[];
  /** The role's agents as the read reports them. */
  agents: readonly {
    id: string;
    activeClaims: number;
    /** Effective ceiling for this agent: caste override or the global one. */
    maxActiveTasks: number | null;
    status: string | null;
    /** True when a live heartbeat run (queued/running/scheduled_retry) covers the agent. */
    hasLiveRun: boolean;
  }[];
}

export interface SwarmIdleWakeOptions {
  /** Upper bound of agents woken by one pass — the ≤5 batch cap. */
  batchLimit: number;
  /** Time the pass runs at; lease liveness is judged against it. */
  now: Date;
  /**
   * myrmidon(1.6.1 SWARM-SETTINGS-UI): the P0 preemption setting. The idle
   * pass binds agents to the top task in the SAME order the claim path takes
   * it; with preemption off the queue is strictly oldest-first.
   */
  p0Preemption: boolean;
}

/** The number of wakes the pair "queue + free agents" needs right now. */
export function neededIdleWakes(input: SwarmRoleIdleInput): number {
  return freeAgentsOfRole(input).length;
}

/** The role's agents that may take one more task right now. */
export function freeAgentsOfRole(input: SwarmRoleIdleInput): SwarmRoleIdleInput["agents"][number][] {
  return input.agents.filter(
    (agent) =>
      agent.status !== "paused" &&
      agent.status !== "error" &&
      !agent.hasLiveRun &&
      !swarmActiveTaskLimitReached(agent.activeClaims, { maxActiveTasks: agent.maxActiveTasks }),
  );
}

/**
 * Decide one role's wake targets: the free agents, in the role's own agent
 * order, each bound to the top task the queue still offers — critical first,
 * oldest entry second (the same order a claim would take). One agent per
 * queue task: the second free agent gets the second task, not the first one's
 * double. The pass is capped by the batch limit.
 */
export function idleWakeTargetsForRole(
  input: SwarmRoleIdleInput,
  options: SwarmIdleWakeOptions,
): SwarmIdleWakeTarget[] {
  const claimed = new Set(
    input.liveClaims
      .filter((claim) => claim.releasedAt === null || claim.releasedAt === undefined)
      .map((claim) => claim.issueId),
  );
  const ordered = orderSwarmQueueCandidates(input.queue, {
    p0Preemption: options.p0Preemption,
  }).filter((candidate) => !claimed.has(candidate.issueId));
  const free = freeAgentsOfRole(input);
  const targets: SwarmIdleWakeTarget[] = [];
  for (let index = 0; index < free.length && index < ordered.length; index += 1) {
    const agent = free[index]!;
    const top = ordered[index]!;
    targets.push({
      agentId: agent.id,
      issueId: top.issueId,
      identifier: top.identifier ?? null,
      priority: top.priority ?? null,
      role: input.role,
    });
  }
  return targets.slice(0, Math.max(0, options.batchLimit));
}

/**
 * The wake idempotency key of one idle target. Fact-based, like idle-pickup:
 * the key is tracing only — the sweep checks a covering wake/claim before it
 * wakes, so a second pass on the same pair is a no-op by construction.
 */
export function idleWakeIdempotencyKey(target: Pick<SwarmIdleWakeTarget, "issueId">): string {
  return `swarm_idle_wake:${target.issueId}`;
}
