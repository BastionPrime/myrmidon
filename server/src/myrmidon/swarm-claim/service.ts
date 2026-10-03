// server/src/myrmidon/swarm-claim/service.ts
//
// myrmidon(1.6-SWARM): the core claim service.
//
// What lives here: the agent-facing claim (take the top task of your role's
// queue behind a lease), the lease heartbeat (the run refreshes its own claim),
// and the release-with-wake (the finishing run frees the task and the next
// agent of the role is woken immediately — the acceptance window "an idle agent
// with a non-empty queue of its role cannot exist longer than one lease period"
// is exactly this plus the sweep).
//
// The per-agent ceiling and the P0 order are NOT re-implemented here: they are
// decisions of the shared contract (`@paperclipai/shared`) applied through
// `nextQueueTaskForAgent`, so the supervisor view and the core cannot disagree.
//
// The wake goes through the existing `enqueueWakeup` admission path (the same
// choice idle-pickup made): every limit, gate and pause rule applies without
// this module re-deriving any of them.

import { and, eq } from "drizzle-orm";
import { agents, issues, type Db } from "@paperclipai/db";
import {
  SWARM_CLAIM_CLAIMED_ACTION,
  SWARM_CLAIM_RELEASED_ACTION,
  SWARM_CLAIM_RELEASE_REASON_LEASE_EXPIRED,
  SWARM_CLAIM_RELEASE_REASON_RUN_FINISHED,
  SWARM_CLAIM_WAKE_IDEMPOTENCY_PREFIX,
  SWARM_CLAIM_WAKE_REASON,
  isSwarmClaimEnabledFor,
  resolveSwarmClaimSettings,
  type SwarmClaimLease,
  type SwarmClaimSettings,
  type SwarmQueueCandidate,
} from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { logActivity as logActivityService } from "../../services/activity-log.js";
import type { instanceSettingsService } from "../../services/instance-settings.js";
import {
  nextQueueTaskForAgent,
  planClaim,
  planLeaseHeartbeat,
  claimCovers,
} from "./domain.js";
import { listAgentsOfRole, listRoleQueue } from "./queue.js";
import {
  findLiveClaimForIssue,
  heartbeatClaim,
  insertClaim,
  listAgentLiveClaims,
  liveClaimsForIssues,
  releaseClaim,
  releaseClaimsForIssue,
} from "./store.js";
import type { swarmClaimSettingsService } from "./settings.js";

/** The wake admission path (heartbeat.ts) — reuses every limit and gate. */
export type SwarmClaimEnqueueWakeup = (
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

export interface SwarmClaimServicePorts {
  db: Db;
  /** Instance settings read (the general block holds `swarmClaim`). */
  settings: Pick<ReturnType<typeof instanceSettingsService>, "getGeneral">;
  /** Wake admission; absent in unit tests. */
  enqueueWakeup?: SwarmClaimEnqueueWakeup;
  /** Activity log; absent in unit tests. */
  logActivity?: (input: {
    companyId: string;
    actorType: string;
    actorId: string;
    agentId: string | null;
    runId: string | null;
    action: string;
    entityType: string;
    entityId: string;
    details: Record<string, unknown>;
  }) => Promise<void>;
  env?: Record<string, string | undefined>;
}

export interface SwarmClaimOutcome {
  /** The task taken, with its lease. Null when the agent may not take one. */
  claim: SwarmClaimLease | null;
  /** Why no claim happened: no queue, at the ceiling, or the pilot is off. */
  reason: "claimed" | "queue_empty" | "limit_reached" | "disabled";
}

/**
 * One agent takes the top task of its role's queue. The decision sequence is
 * the acceptance list of 1.6 in one function: pilot off → no claim; at the
 * per-agent ceiling → no claim; queue empty → no claim; otherwise the top task
 * in `orderSwarmQueueCandidates` order (a `critical` task is the top) behind a
 * lease of one TTL.
 */
export async function claimNextTaskForAgent(
  ports: SwarmClaimServicePorts,
  input: { companyId: string; agentId: string; runId?: string | null; now?: Date },
): Promise<SwarmClaimOutcome> {
  const now = input.now ?? new Date();
  const general = (await ports.settings.getGeneral()) as unknown as Record<string, unknown>;
  const { settings } = resolveSwarmClaimSettings({
    stored: general.swarmClaim,
    env: ports.env ?? process.env,
  });
  if (!settings.enabled) return { claim: null, reason: "disabled" };

  const agentRow = await ports.db
    .select({ id: agents.id, role: agents.role, companyId: agents.companyId })
    .from(agents)
    .where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)))
    .limit(1);
  const agent = agentRow[0];
  if (!agent) return { claim: null, reason: "queue_empty" };
  // 1.6.1 (SWARM-SETTINGS-UI): the pilot set. The master switch may be on
  // while this company or role is deliberately outside the pilot — then the
  // claim path answers the same "disabled" the off switch does, so an agent
  // outside the pilot keeps vendor behavior exactly.
  if (
    !isSwarmClaimEnabledFor(settings, {
      companyId: input.companyId,
      role: agent.role,
    })
  ) {
    return { claim: null, reason: "disabled" };
  }

  const [candidates, agentClaims, companyClaims] = await Promise.all([
    listRoleQueue(ports.db, input.companyId, agent.role),
    listAgentLiveClaims(ports.db, input.companyId, input.agentId),
    // The live claims of the whole company restrict the queue: a task another
    // agent holds is not in anyone's queue until its lease runs out.
    listRoleQueueCompanyClaims(ports.db, input.companyId),
  ]);
  const liveClaims = [...companyClaims, ...agentClaims];

  const next = nextQueueTaskForAgent({
    candidates,
    liveClaims,
    activeTasks: agentClaims.length,
    settings,
    now,
  });
  if (!next) {
    // Distinguish "nothing to take" from "not allowed to take".
    if (agentClaims.length > 0) {
      const bareQueue = nextQueueTaskForAgent({
        candidates,
        liveClaims,
        activeTasks: 0,
        settings,
        now,
      });
      if (bareQueue) return { claim: null, reason: "limit_reached" };
    }
    return { claim: null, reason: "queue_empty" };
  }

  const plan = planClaim({
    issueId: next.issueId,
    agentId: input.agentId,
    role: agent.role,
    runId: input.runId ?? null,
    now,
    settings,
  });
  const claim = await insertClaim(ports.db, {
    companyId: input.companyId,
    ...plan,
  });
  if (!claim) {
    // Another agent won the same task between the read and the write. The
    // correct answer is "nothing was taken": the caller retries on its next
    // wake, exactly as a losing bidder does.
    return { claim: null, reason: "queue_empty" };
  }

  await ports.logActivity?.({
    companyId: input.companyId,
    actorType: "system",
    actorId: "swarm_claim",
    agentId: input.agentId,
    runId: input.runId ?? null,
    action: SWARM_CLAIM_CLAIMED_ACTION,
    entityType: "issue",
    entityId: next.issueId,
    details: {
      identifier: next.identifier,
      priority: next.priority,
      role: agent.role,
      leaseTtlSec: settings.leaseTtlSec,
    },
  });
  return { claim, reason: "claimed" };
}

async function listRoleQueueCompanyClaims(db: Db, companyId: string): Promise<SwarmClaimLease[]> {
  const { listCompanyClaims } = await import("./store.js");
  const rows = await listCompanyClaims(db, companyId);
  return rows.map((row) => ({
    id: row.id,
    issueId: row.issueId,
    agentId: row.agentId,
    heartbeatAt: row.heartbeatAt,
    expiresAt: row.expiresAt,
    releasedAt: row.releasedAt,
  }));
}

/**
 * The run heartbeat refreshes its own claim: every `heartbeatAt` push moves the
 * expiry one TTL forward. A claim that was released (expired, supervisor) is
 * not resurrected — the run holding it lost the task, and the queue will hand
 * it to someone else.
 */
export async function refreshLeaseForRun(
  ports: SwarmClaimServicePorts,
  input: { companyId: string; agentId: string; issueId: string; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const general = (await ports.settings.getGeneral()) as unknown as Record<string, unknown>;
  const { settings } = resolveSwarmClaimSettings({
    stored: general.swarmClaim,
    env: ports.env ?? process.env,
  });
  if (!settings.enabled) return false;

  const claim = await findLiveClaimForIssue(ports.db, input.issueId);
  if (!claim || claim.agentId !== input.agentId) return false;
  const refresh = planLeaseHeartbeat({ claim, now, settings });
  if (!refresh) return false;
  return heartbeatClaim(ports.db, { claimId: claim.id, ...refresh });
}

/**
 * Release the task a run was holding and wake the next agent of the role. The
 * release path of the run lifecycle calls this; the sweep calls the same
 * release through its own path. Returns the released claim ids.
 */
export async function releaseTaskAndWakeNext(
  ports: SwarmClaimServicePorts,
  input: {
    companyId: string;
    issueId: string;
    reason?: string;
    runId?: string | null;
    now?: Date;
  },
): Promise<string[]> {
  const now = input.now ?? new Date();
  const reason = input.reason ?? SWARM_CLAIM_RELEASE_REASON_RUN_FINISHED;
  const released = await releaseClaimsForIssue(ports.db, { issueId: input.issueId, reason, now });
  if (released.length === 0) return [];

  await ports.logActivity?.({
    companyId: input.companyId,
    actorType: "system",
    actorId: "swarm_claim",
    agentId: null,
    runId: input.runId ?? null,
    action: SWARM_CLAIM_RELEASED_ACTION,
    entityType: "issue",
    entityId: input.issueId,
    details: { reason, releasedClaimIds: released },
  });

  await wakeNextAgentForIssueRole(ports, {
    companyId: input.companyId,
    issueId: input.issueId,
    excludeAgentId: null,
    idempotencySuffix: reason,
    now,
  }).catch((err) =>
    logger.warn({ err, issueId: input.issueId }, "swarm claim wake of the next agent failed"),
  );
  return released;
}

/**
 * Wake one agent of the role the released task belongs to, so the task does not
 * wait for the periodic sweep to be picked up. The wake is best-effort: the
 * admission path may defer it, and the sweep remains the safety net.
 */
export async function wakeNextAgentForIssueRole(
  ports: SwarmClaimServicePorts,
  input: {
    companyId: string;
    issueId: string;
    excludeAgentId: string | null;
    idempotencySuffix?: string;
    now?: Date;
  },
): Promise<boolean> {
  if (!ports.enqueueWakeup) return false;
  const issueRow = await ports.db
    .select({ id: issues.id, assigneeAgentId: issues.assigneeAgentId })
    .from(issues)
    .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
    .limit(1);
  const issue = issueRow[0];
  if (!issue) return false;

  let role: string | null = null;
  if (issue.assigneeAgentId) {
    const agentRow = await ports.db
      .select({ role: agents.role })
      .from(agents)
      .where(eq(agents.id, issue.assigneeAgentId))
      .limit(1);
    role = agentRow[0]?.role ?? null;
  }
  if (!role) {
    // An unassigned task has no role of its own; every role may take it. Wake
    // the first invokable agent of the company (the admission path checks the
    // rest) — the sweep re-offers the task to every role on its next pass.
    const anyAgent = await ports.db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.companyId, input.companyId))
      .limit(2);
    const target = anyAgent.find((row) => row.id !== input.excludeAgentId);
    if (!target) return false;
    return enqueueSwarmWake(ports, target.id, input);
  }

  const roleAgents = await listAgentsOfRole(ports.db, input.companyId, role);
  const target = roleAgents.find((row) => row.id !== input.excludeAgentId);
  if (!target) return false;
  return enqueueSwarmWake(ports, target.id, input);
}

async function enqueueSwarmWake(
  ports: SwarmClaimServicePorts,
  agentId: string,
  input: { issueId: string; idempotencySuffix?: string },
): Promise<boolean> {
  const key = `${SWARM_CLAIM_WAKE_IDEMPOTENCY_PREFIX}:${input.issueId}${
    input.idempotencySuffix ? `:${input.idempotencySuffix}` : ""
  }`;
  const wake = await ports.enqueueWakeup!(agentId, {
    source: "automation",
    triggerDetail: "system",
    reason: SWARM_CLAIM_WAKE_REASON,
    idempotencyKey: key,
    requestedByActorType: "system",
    requestedByActorId: "swarm_claim",
    contextSnapshot: { issueId: input.issueId, source: "swarm_claim" },
  });
  return Boolean(wake);
}

/** Convenience for the routes: the pilot settings service instance. */
export function swarmClaimService(db: Db, ports: SwarmClaimServicePorts) {
  return {
    claimNextTaskForAgent: (input: Parameters<typeof claimNextTaskForAgent>[1]) =>
      claimNextTaskForAgent(ports, input),
    refreshLeaseForRun: (input: Parameters<typeof refreshLeaseForRun>[1]) =>
      refreshLeaseForRun(ports, input),
    releaseTaskAndWakeNext: (input: Parameters<typeof releaseTaskAndWakeNext>[1]) =>
      releaseTaskAndWakeNext(ports, input),
    settings: ports.settings,
  };
}

export type SwarmClaimServiceHandle = ReturnType<typeof swarmClaimService>;

export { releaseClaim, SWARM_CLAIM_RELEASE_REASON_LEASE_EXPIRED };