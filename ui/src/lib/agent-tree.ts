import type { Agent } from "@paperclipai/shared";

// myrmidon(AGENTS-TREE): pure hierarchy helpers for the agents tree views
// (sidebar + roster page + UI 2.0 shell). The data already carries
// `reportsTo`; this module turns the flat list into a forest with:
//   - cycle protection (a `reportsTo` cycle can never loop the builder);
//   - orphans (`reportsTo` pointing at a missing agent, or agents on a
//     `reportsTo` cycle) gathered into a dedicated "No manager" group;
//   - sibling ordering that surfaces leadership roles first, then names.

export interface AgentTreeNode {
  agent: Agent;
  children: AgentTreeNode[];
  depth: number;
  /** Number of agents in the whole subtree below (and excluding) this node. */
  descendantCount: number;
  /** True when the subtree (incl. this node) contains an agent with an error status. */
  hasError: boolean;
  /** Number of agents in the subtree (incl. this node) that are running. */
  runningCount: number;
}

export interface AgentForest {
  /** Rooted trees: agents with no manager (`reportsTo: null`), children nested below. */
  roots: AgentTreeNode[];
  /** Orphan trees: agents whose manager id does not resolve, or `reportsTo` cycle members (one cycle-representative per cycle). */
  orphans: AgentTreeNode[];
}

const ROLE_SORT_PRIORITY: Record<string, number> = {
  ceo: 0,
  cto: 1,
  cfo: 2,
  cmo: 3,
};

function rolePriority(agent: Agent): number {
  const role = typeof agent.role === "string" ? agent.role.toLowerCase() : "";
  return ROLE_SORT_PRIORITY[role] ?? Number.MAX_SAFE_INTEGER;
}

function compareSiblings(left: Agent, right: Agent): number {
  const priorityDiff = rolePriority(left) - rolePriority(right);
  if (priorityDiff !== 0) return priorityDiff;
  return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
}

const ERROR_STATUSES = new Set(["error", "failed"]);
const RUNNING_STATUSES = new Set(["running"]);

/**
 * Build the agents forest from a flat list.
 *
 * Hard guarantees:
 * - every input agent appears exactly once in the output (roots or orphans,
 *   including their subtrees) — a cycle or dangling `reportsTo` can never
 *   drop or duplicate an agent;
 * - termination: a `reportsTo` cycle is broken at one representative node
 *   (first in input order); the other cycle members keep their in-cycle
 *   manager and render inside that representative's subtree;
 * - children always stay with their manager, whatever group the manager
 *   lands in (so an orphan's team stays under the orphan).
 */
export function buildAgentForest(agents: Agent[]): AgentForest {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));

  // Orphan root candidates: agents whose `reportsTo` does not resolve to a
  // known agent (dangling), plus one representative per `reportsTo` cycle.
  const orphanIds = new Set<string>();
  for (const agent of agents) {
    if (agent.reportsTo != null && !byId.has(agent.reportsTo)) {
      orphanIds.add(agent.id);
    }
  }

  // Cycle detection: walk up from every agent; a walk that returns to the
  // starting agent means the whole walked path is one cycle. The first
  // member (input order) becomes the cycle representative — the orphan
  // root where the cycle is cut; the rest keep their manager.
  const cycleHandled = new Set<string>();
  for (const agent of agents) {
    if (orphanIds.has(agent.id) || cycleHandled.has(agent.id)) continue;
    const seen = new Set<string>([agent.id]);
    let cursor = agent.reportsTo;
    let onCycle = false;
    while (cursor != null && byId.has(cursor)) {
      if (cursor === agent.id) {
        onCycle = true;
        break;
      }
      if (seen.has(cursor)) break; // a different cycle — its own rep handles it
      seen.add(cursor);
      cursor = byId.get(cursor)?.reportsTo ?? null;
    }
    if (!onCycle) continue;
    const loop = Array.from(seen);
    if (loop.some((id) => cycleHandled.has(id))) {
      cycleHandled.add(agent.id); // already represented by an earlier member
      continue;
    }
    orphanIds.add(agent.id); // representative: the cycle is cut here
    for (const id of loop) cycleHandled.add(id);
  }

  // Effective parent: orphans and manager-less agents are roots; everyone
  // else attaches to their (existing) manager — including children of
  // orphans and non-representative cycle members.
  const childrenOf = new Map<string, Agent[]>();
  const trueRoots: Agent[] = [];
  const orphanRoots: Agent[] = [];
  for (const agent of agents) {
    const isOrphanRoot = orphanIds.has(agent.id);
    const parentId = isOrphanRoot ? null : agent.reportsTo;
    if (parentId == null) {
      (isOrphanRoot ? orphanRoots : trueRoots).push(agent);
      continue;
    }
    const siblings = childrenOf.get(parentId) ?? [];
    siblings.push(agent);
    childrenOf.set(parentId, siblings);
  }

  const buildNode = (agent: Agent, depth: number): AgentTreeNode => {
    const siblings = (childrenOf.get(agent.id) ?? []).slice().sort(compareSiblings);
    const children = siblings.map((child) => buildNode(child, depth + 1));
    let descendantCount = 0;
    let hasError = ERROR_STATUSES.has(agent.status);
    let runningCount = RUNNING_STATUSES.has(agent.status) ? 1 : 0;
    for (const child of children) {
      descendantCount += 1 + child.descendantCount;
      if (child.hasError) hasError = true;
      runningCount += child.runningCount;
    }
    return { agent, children, depth, descendantCount, hasError, runningCount };
  };

  const roots = trueRoots.slice().sort(compareSiblings).map((agent) => buildNode(agent, 0));
  const orphans = orphanRoots.slice().sort(compareSiblings).map((agent) => buildNode(agent, 0));

  // Invariant: the forest accounts for every input agent exactly once.
  // Unreachable by construction, but a data bug must never hide agents —
  // fall back to an all-roots forest instead.
  const countNodes = (nodes: AgentTreeNode[]): number =>
    nodes.reduce((sum, node) => sum + 1 + countNodes(node.children), 0);
  if (countNodes(roots) + countNodes(orphans) !== agents.length) {
    return {
      roots: agents.slice().sort(compareSiblings).map((agent) => buildNode(agent, 0)),
      orphans: [],
    };
  }

  return { roots, orphans };
}

/** Depth-first flatten of the forest (collapsed nodes are the caller's concern). */
export function flattenAgentForest(forest: AgentForest): AgentTreeNode[] {
  const out: AgentTreeNode[] = [];
  const walk = (nodes: AgentTreeNode[]) => {
    for (const node of nodes) {
      out.push(node);
      walk(node.children);
    }
  };
  walk(forest.roots);
  walk(forest.orphans);
  return out;
}

/** Agent ids that must be expanded so every name match is visible in the tree. */
export function expandedIdsForSearch(forest: AgentForest, needle: string): Set<string> {
  const query = needle.trim().toLowerCase();
  if (query.length === 0) return new Set();
  const expanded = new Set<string>();
  const matches = (agent: Agent) => agent.name.toLowerCase().includes(query);
  const walk = (nodes: AgentTreeNode[]): boolean => {
    let anyMatch = false;
    for (const node of nodes) {
      const selfMatch = matches(node.agent);
      const childMatch = walk(node.children);
      if (selfMatch || childMatch) {
        anyMatch = true;
        if (node.children.length > 0) expanded.add(node.agent.id);
      }
    }
    return anyMatch;
  };
  walk(forest.roots);
  walk(forest.orphans);
  return expanded;
}

// ---------------------------------------------------------------------------
// Persisted collapse state (per company + user, same scheme as agent-order).
// ---------------------------------------------------------------------------

const AGENT_TREE_COLLAPSED_STORAGE_PREFIX = "paperclip.agentTreeCollapsed";
const ANONYMOUS_USER_ID = "anonymous";

export function getAgentTreeCollapsedStorageKey(
  companyId: string,
  userId: string | null | undefined,
): string {
  const resolved = userId && userId.trim().length > 0 ? userId.trim() : ANONYMOUS_USER_ID;
  return `${AGENT_TREE_COLLAPSED_STORAGE_PREFIX}:${companyId}:${resolved}`;
}

/**
 * Read the persisted set of *collapsed* agent node ids. Storage keeps only
 * collapsed ids (the default is "first level expanded"), so a growing roster
 * costs nothing and new managers start expanded.
 */
export function readAgentTreeCollapsed(storageKey: string): Set<string> {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.filter((item): item is string => typeof item === "string" && item.length > 0),
    );
  } catch {
    return new Set();
  }
}

export function writeAgentTreeCollapsed(
  storageKey: string,
  collapsed: Iterable<string>,
): Set<string> {
  const normalized = new Set(
    Array.from(collapsed).filter((id) => typeof id === "string" && id.length > 0),
  );
  try {
    localStorage.setItem(storageKey, JSON.stringify(Array.from(normalized)));
  } catch {
    // Ignore storage write failures in restricted browser contexts.
  }
  return normalized;
}
