// myrmidon(1.6-SWARM-CLAIM-B): the supervisor read port over the swarm claim
// machinery.
//
// Part B is strictly a reader here: it aggregates per-role queues, live and
// expired claims and per-agent load. The claim table itself (`issue_claims`)
// and every write to it belong to part A (`server/src/myrmidon/swarm-claim/`);
// when part A's module is not present this port reports `enabled: false` and
// the surface answers 503 instead of guessing.
//
// The queue shape mirrors `listRoleQueue`/`orderSwarmQueueCandidates` from part
// A (priority critical first, then high, medium, low; older blockedTransitionAt
// first) so the supervisor sees exactly the order agents claim from. The
// ordering is re-implemented locally (pure ranking of the rows the port
// fetched) because importing part A's domain module would make this file fail
// to compile before part A lands; the ranking itself is a frozen contract.

import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { readSwarmSupervisorSettings } from "./settings.js";

/** Wake reason part A assigns to queue-driven wakes; informational in the view. */
export const SWARM_CLAIM_QUEUE_WAKE_REASON = "swarm_claim_queue";

export interface SwarmQueueCandidateRow {
  issueId: string;
  identifier: string | null;
  title: string;
  priority: string;
  projectId: string | null;
  createdAt: string;
  blockedTransitionAt: string | null;
}

export interface SwarmClaimLeaseRow {
  claimId: string;
  issueId: string;
  identifier: string | null;
  title: string;
  priority: string;
  agentId: string;
  agentName: string;
  claimedAt: string;
  expiresAt: string;
  heartbeatAt: string | null;
  expired: boolean;
  secondsToExpiry: number;
}

export interface SwarmIdleAgentRow {
  agentId: string;
  name: string;
  activeClaims: number;
  atLimit: boolean;
}

export interface SwarmRoleOverview {
  role: string;
  queue: SwarmQueueCandidateRow[];
  claims: SwarmClaimLeaseRow[];
  idleAgents: SwarmIdleAgentRow[];
}

export interface SwarmSupervisorOverview {
  enabled: boolean;
  generatedAt: string;
  leaseTtlSec: number | null;
  maxActiveTasksPerAgent: number | null;
  totals: {
    queued: number;
    activeClaims: number;
    expiredClaims: number;
    agentsWithClaims: number;
    idleAgentsWithQueue: number;
  };
  roles: SwarmRoleOverview[];
  topQueue: {
    issueId: string;
    identifier: string | null;
    title: string;
    priority: string;
    role: string;
    projectId: string | null;
    createdAt: string;
  }[];
}

/**
 * Minimal shape of one `issue_claims` row as this module reads it. Defined
 * locally (not imported from part A) so the module compiles before part A
 * merges; the column names are part A's frozen contract.
 */
interface ClaimRow {
  claim_id: string;
  issue_id: string;
  agent_id: string;
  claimed_at: Date | string;
  expires_at: Date | string;
  heartbeat_at: Date | string | null;
  released_at: Date | string | null;
}

interface QueueRow {
  issue_id: string;
  identifier: string | null;
  title: string;
  priority: string;
  project_id: string | null;
  created_at: Date | string;
  blocked_transition_at: Date | string | null;
  /** Read when present: the role filter of the queue is the assignee's role. */
  assignee_agent_id?: string | null;
}

interface AgentRow {
  agent_id: string;
  agent_name: string;
  role: string;
  status: string;
}

/** The DB read port, overridable in unit tests with an in-memory fake. */
export interface SwarmSupervisorReadPort {
  /** Whether part A's claim machinery is present and switched on. */
  claimEnabled(): Promise<boolean>;
  /** Part A's effective lease TTL in seconds, when known. */
  leaseTtlSec(): Promise<number | null>;
  /** Part A's effective per-agent limit of active tasks, when known. */
  maxActiveTasksPerAgent(): Promise<number | null>;
  /** Claim rows of the company (live + released history rows included). */
  listClaimRows(companyId: string): Promise<ClaimRow[]>;
  /** Queued candidates per issue id (todo, ready, not claimed right now). */
  listQueueRows(companyId: string): Promise<QueueRow[]>;
  /** Agents of the company that could ever hold a claim. */
  listAgents(companyId: string): Promise<AgentRow[]>;
  /** Live run statuses per agent id, for the idle heuristic. */
  liveRunAgentIds(companyId: string): Promise<Set<string>>;
}

const PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function priorityRank(priority: string): number {
  const rank = PRIORITY_RANK[priority?.toLowerCase?.() ?? ""];
  return rank === undefined ? PRIORITY_RANK.medium : rank;
}

function toDate(value: Date | string | null): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toIso(value: Date | string | null): string | null {
  const date = toDate(value);
  return date ? date.toISOString() : null;
}

/**
 * Order queue candidates the way part A's core orders them: P0 first, then
 * priority, then the oldest blockedTransitionAt, then creation order. The
 * supervisor's "top of queue" must be the same task the next claim would take.
 */
export function orderQueueCandidates(
  rows: SwarmQueueCandidateRow[],
): SwarmQueueCandidateRow[] {
  return [...rows].sort((a, b) => {
    const byPriority = priorityRank(a.priority) - priorityRank(b.priority);
    if (byPriority !== 0) return byPriority;
    const aBlocked = a.blockedTransitionAt ? Date.parse(a.blockedTransitionAt) : Number.POSITIVE_INFINITY;
    const bBlocked = b.blockedTransitionAt ? Date.parse(b.blockedTransitionAt) : Number.POSITIVE_INFINITY;
    if (aBlocked !== bBlocked) return aBlocked - bBlocked;
    return Date.parse(a.createdAt) - Date.parse(b.createdAt);
  });
}

export function swarmSupervisorView(
  port: SwarmSupervisorReadPort,
  env: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date(),
) {
  const settings = readSwarmSupervisorSettings(env);

  async function overview(companyId: string): Promise<SwarmSupervisorOverview> {
    const generatedAt = new Date(now()).toISOString();
    const enabled = await port.claimEnabled();
    if (!enabled) {
      return {
        enabled: false,
        generatedAt,
        leaseTtlSec: null,
        maxActiveTasksPerAgent: null,
        totals: { queued: 0, activeClaims: 0, expiredClaims: 0, agentsWithClaims: 0, idleAgentsWithQueue: 0 },
        roles: [],
        topQueue: [],
      };
    }
    const [ttl, maxActive, claimRows, queueRows, agents, liveRunAgents] = await Promise.all([
      port.leaseTtlSec(),
      port.maxActiveTasksPerAgent(),
      port.listClaimRows(companyId),
      port.listQueueRows(companyId),
      port.listAgents(companyId),
      port.liveRunAgentIds(companyId),
    ]);

    const nowMs = now().getTime();
    const agentById = new Map(agents.map((agent) => [agent.agent_id, agent]));
    const issueTitleById = new Map(queueRows.map((row) => [row.issue_id, row]));

    const liveClaims = claimRows.filter(
      (row) => toDate(row.released_at) === null && toDate(row.claim_id) !== undefined && row.claim_id,
    );
    const leaseByIssue = new Map<string, ClaimRow>();
    for (const claim of liveClaims) {
      if (toDate(claim.released_at) !== null) continue;
      const existing = leaseByIssue.get(claim.issue_id);
      if (!existing || Date.parse(String(claim.claimed_at)) > Date.parse(String(existing.claimed_at))) {
        leaseByIssue.set(claim.issue_id, claim);
      }
    }

    const claimedIssueIds = new Set(leaseByIssue.keys());
    const activeCountByAgent = new Map<string, number>();
    const expiredCountByAgent = new Map<string, number>();
    for (const claim of leaseByIssue.values()) {
      activeCountByAgent.set(claim.agent_id, (activeCountByAgent.get(claim.agent_id) ?? 0) + 1);
      if (Date.parse(String(claim.expires_at)) < nowMs) {
        expiredCountByAgent.set(claim.agent_id, (expiredCountByAgent.get(claim.agent_id) ?? 0) + 1);
      }
    }

    // Queued candidates are todo rows without a live lease; they are grouped
    // by the role of the agent expected to claim them (the role queue).
    const queueByRole = new Map<string, SwarmQueueCandidateRow[]>();
    const issueQueueRow = (row: QueueRow): SwarmQueueCandidateRow => ({
      issueId: row.issue_id,
      identifier: row.identifier,
      title: row.title,
      priority: row.priority,
      projectId: row.project_id,
      createdAt: toIso(row.created_at) ?? new Date(0).toISOString(),
      blockedTransitionAt: toIso(row.blocked_transition_at),
    });

    const unclaimedRows = queueRows.filter((row) => !claimedIssueIds.has(row.issue_id));
    for (const row of unclaimedRows) {
      const issue = issueQueueRow(row);
      const roles = issueRoles(row, agentById);
      for (const role of roles) {
        const list = queueByRole.get(role) ?? [];
        if (list.length < settings.taskMax) {
          list.push(issue);
        }
        queueByRole.set(role, list);
      }
    }

    const leaseRowsByRole = new Map<string, SwarmClaimLeaseRow[]>();
    for (const claim of leaseByIssue.values()) {
      const agent = agentById.get(claim.agent_id);
      const role = agent?.role ?? "general";
      const queueMeta = issueTitleById.get(claim.issue_id);
      const expiresMs = Date.parse(String(claim.expires_at));
      const lease: SwarmClaimLeaseRow = {
        claimId: claim.claim_id,
        issueId: claim.issue_id,
        identifier: queueMeta?.identifier ?? null,
        title: queueMeta?.title ?? claim.issue_id,
        priority: queueMeta?.priority ?? "medium",
        agentId: claim.agent_id,
        agentName: agent?.agent_name ?? claim.agent_id,
        claimedAt: toIso(claim.claimed_at) ?? new Date(0).toISOString(),
        expiresAt: Number.isNaN(expiresMs)
          ? new Date(0).toISOString()
          : new Date(expiresMs).toISOString(),
        heartbeatAt: toIso(claim.heartbeat_at),
        expired: !Number.isNaN(expiresMs) && expiresMs < nowMs,
        secondsToExpiry: Number.isNaN(expiresMs)
          ? 0
          : Math.round((expiresMs - nowMs) / 1000),
      };
      const list = leaseRowsByRole.get(role) ?? [];
      list.push(lease);
      leaseRowsByRole.set(role, list);
    }

    const cap = typeof maxActive === "number" && maxActive > 0 ? maxActive : null;
    const roles: SwarmRoleOverview[] = [];
    for (const [role, queue] of queueByRole) {
      const ordered = orderQueueCandidates(queue).slice(0, settings.taskMax);
      const claims = leaseRowsByRole.get(role) ?? [];
      const idleAgents: SwarmIdleAgentRow[] = agents
        .filter((agent) => agent.role === role)
        .filter((agent) => agent.status !== "paused" && agent.status !== "error")
        .filter((agent) => !liveRunAgents.has(agent.agent_id))
        .map((agent) => ({
          agentId: agent.agent_id,
          name: agent.agent_name,
          activeClaims: activeCountByAgent.get(agent.agent_id) ?? 0,
          atLimit: cap === null ? false : (activeCountByAgent.get(agent.agent_id) ?? 0) >= cap,
        }));
      roles.push({ role, queue: ordered, claims, idleAgents });
    }
    for (const [role, claims] of leaseRowsByRole) {
      if (!roles.some((entry) => entry.role === role)) {
        roles.push({ role, queue: [], claims, idleAgents: [] });
      }
    }
    roles.sort((a, b) => a.role.localeCompare(b.role));

    const totals = {
      queued: roles.reduce((sum, entry) => sum + entry.queue.length, 0),
      activeClaims: [...leaseByIssue.values()].length,
      expiredClaims: [...leaseByIssue.values()].filter(
        (claim) => Date.parse(String(claim.expires_at)) < nowMs,
      ).length,
      agentsWithClaims: new Set([...leaseByIssue.values()].map((claim) => claim.agent_id)).size,
      idleAgentsWithQueue: roles.reduce(
        (sum, entry) => sum + (entry.queue.length > 0 ? entry.idleAgents.length : 0),
        0,
      ),
    };

    const topQueue = roles
      .flatMap((entry) =>
        entry.queue.map((issue) => ({
          issueId: issue.issueId,
          identifier: issue.identifier,
          title: issue.title,
          priority: issue.priority,
          role: entry.role,
          projectId: issue.projectId,
          createdAt: issue.createdAt,
        })),
      )
      .slice(0, settings.taskMax);

    return {
      enabled: true,
      generatedAt,
      leaseTtlSec: ttl,
      maxActiveTasksPerAgent: maxActive,
      totals,
      roles,
      topQueue,
    };
  }

  return { overview };
}

/**
 * Which role queues an unclaimed todo row belongs to. The queue is role-
 * scoped by the issue's assignee (part A's role filter): an assigned todo
 * queues for the assignee's role; an unassigned todo is attributed to no
 * role queue — the supervisor reports only queues it can attribute, it never
 * invents an assignment.
 */
function issueRoles(row: QueueRow, agentById: Map<string, AgentRow>): string[] {
  const assigneeId = row.assignee_agent_id;
  if (!assigneeId) return [];
  const agent = agentById.get(assigneeId);
  return agent ? [agent.role] : [];
}

/**
 * Build the read port over the live database. The claim table belongs to part
 * A; this port reads it with raw SQL so this module never imports part A's
 * schema module (it may not exist yet on this branch).
 */
export function createSwarmSupervisorDbPort(db: Db, env: NodeJS.ProcessEnv = process.env): SwarmSupervisorReadPort {
  return {
    async claimEnabled() {
      return readClaimEnabled(db, env);
    },
    async leaseTtlSec() {
      return readClaimSettingNumber(db, env, "MYRMIDON_SWARM_LEASE_TTL_SEC");
    },
    async maxActiveTasksPerAgent() {
      return readClaimSettingNumber(db, env, "MYRMIDON_SWARM_MAX_ACTIVE_TASKS");
    },
    async listClaimRows(companyId) {
      const rows = await db.execute(sql`
        SELECT id AS claim_id, issue_id, agent_id, claimed_at, expires_at, heartbeat_at, released_at
        FROM issue_claims
        WHERE company_id = ${companyId}
      `);
      return (Array.isArray(rows) ? rows : []) as unknown as ClaimRow[];
    },
    async listQueueRows(companyId) {
      const rows = await db.execute(sql`
        SELECT id AS issue_id, identifier, title, priority, project_id, created_at, blocked_transition_at, assignee_agent_id
        FROM issues
        WHERE company_id = ${companyId}
          AND status = 'todo'
        ORDER BY created_at ASC
      `);
      return (Array.isArray(rows) ? rows : []) as unknown as QueueRow[];
    },
    async listAgents(companyId) {
      const rows = await db.execute(sql`
        SELECT id AS agent_id, name AS agent_name, role, status
        FROM agents
        WHERE company_id = ${companyId}
      `);
      return (Array.isArray(rows) ? rows : []) as unknown as AgentRow[];
    },
    async liveRunAgentIds(companyId) {
      const rows = await db.execute(sql`
        SELECT DISTINCT agent_id
        FROM heartbeat_runs
        WHERE company_id = ${companyId}
          AND status IN ('queued', 'running', 'scheduled_retry')
      `);
      const ids = (Array.isArray(rows) ? rows : []) as unknown as { agent_id: string }[];
      return new Set(ids.map((row) => row.agent_id));
    },
  };
}

/** True when part A's claim module + table are present and the flag is on. */
async function readClaimEnabled(db: Db, env: NodeJS.ProcessEnv): Promise<boolean> {
  const raw = env.MYRMIDON_SWARM_CLAIM_ENABLED?.trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "off" || raw === "no") return false;
  try {
    const rows = await db.execute(sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'issue_claims'
      ) AS table_exists
    `);
    const first = Array.isArray(rows) ? rows[0] : null;
    return Boolean(
      first &&
        typeof first === "object" &&
        (first as Record<string, unknown>).table_exists === true,
    );
  } catch {
    // The table belongs to part A; a database without it simply has no claims.
    return false;
  }
}

async function readClaimSettingNumber(
  db: Db,
  env: NodeJS.ProcessEnv,
  envName: string,
): Promise<number | null> {
  const raw = env[envName]?.trim();
  if (raw && /^\d+$/.test(raw)) {
    const value = Number(raw);
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  try {
    const rows = await db.execute(sql`
      SELECT (general->'swarmClaim') AS swarm
      FROM instance_settings
      WHERE general ? 'swarmClaim'
      LIMIT 1
    `);
    const first = Array.isArray(rows) ? rows[0] : null;
    if (first && typeof first === "object") {
      const swarm = (first as Record<string, unknown>).swarm;
      const ttl = swarm && typeof swarm === "object" ? (swarm as Record<string, unknown>)[envName] : null;
      if (typeof ttl === "number" && Number.isSafeInteger(ttl) && ttl > 0) return ttl;
    }
  } catch {
    // Optional metadata; absence is not an error.
  }
  return null;
}