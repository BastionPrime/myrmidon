// Maintenance mode (R3): pure rules. No I/O and no clock reads here; callers pass `now`.
// Design: docs/myrmidon/design/maintenance-mode.md

export const MAINTENANCE_SCOPE_TYPES = ["instance", "company", "department", "agent"] as const;
export type MaintenanceScopeType = (typeof MAINTENANCE_SCOPE_TYPES)[number];

export const MAINTENANCE_ON_TIMEOUT = ["wait", "interrupt_and_retry"] as const;
export type MaintenanceOnTimeout = (typeof MAINTENANCE_ON_TIMEOUT)[number];

export type MaintenanceWindowState = "entering" | "on" | "leaving";
export type MaintenanceState = MaintenanceWindowState | "off";

/** Error code on runs interrupted by maintenance. Only this code skips the reconciliation hold. */
export const MAINTENANCE_INTERRUPT_ERROR_CODE = "myrmidon_maintenance_interrupted";
export const MAINTENANCE_RETRY_REASON = "myrmidon_maintenance";
export const MAINTENANCE_RETRY_WAKE_REASON = "myrmidon_maintenance_retry";

export interface MaintenanceScope {
  type: MaintenanceScopeType;
  /** Company id for `company`, manager agent id for `department`, agent id for `agent`. */
  id?: string | null;
}

export interface MaintenanceActor {
  actorType: string;
  actorId: string;
}

export interface MaintenanceWindow {
  id: string;
  scope: MaintenanceScope;
  /** Company of the scope; null for `instance`. */
  companyId: string | null;
  state: MaintenanceWindowState;
  reason: string;
  drainTimeoutSec: number;
  onTimeout: MaintenanceOnTimeout;
  enteredAt: string;
  drainDeadlineAt: string;
  onAt: string | null;
  drainTimedOut: boolean;
  exitRequestedAt: string | null;
  exitedAt?: string | null;
  startedBy: MaintenanceActor | null;
  interruptedRunIds: string[];
  zabbix: { maintenanceId: string | null; lastError: string | null };
}

export interface MaintenanceDocument {
  version: 1;
  windows: MaintenanceWindow[];
  history: MaintenanceWindow[];
}

export const MAINTENANCE_HISTORY_LIMIT = 20;

export function emptyMaintenanceDocument(): MaintenanceDocument {
  return { version: 1, windows: [], history: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read the stored document defensively: anything malformed becomes "no windows". */
export function parseMaintenanceDocument(raw: unknown): MaintenanceDocument {
  if (!isRecord(raw) || !Array.isArray(raw.windows)) return emptyMaintenanceDocument();
  const windows = raw.windows.filter(
    (w): w is MaintenanceWindow =>
      isRecord(w) &&
      typeof w.id === "string" &&
      isRecord(w.scope) &&
      MAINTENANCE_SCOPE_TYPES.includes((w.scope as { type: MaintenanceScopeType }).type) &&
      (w.state === "entering" || w.state === "on" || w.state === "leaving"),
  );
  const history = Array.isArray(raw.history) ? (raw.history.filter(isRecord) as unknown as MaintenanceWindow[]) : [];
  return { version: 1, windows, history };
}

export function scopeKey(scope: MaintenanceScope): string {
  return scope.type === "instance" ? "instance" : `${scope.type}:${scope.id ?? ""}`;
}

export function sameScope(a: MaintenanceScope, b: MaintenanceScope): boolean {
  return scopeKey(a) === scopeKey(b);
}

/** Windows that hold run admission closed. A `leaving` window has already reopened admission. */
export function blockingWindows(doc: MaintenanceDocument): MaintenanceWindow[] {
  return doc.windows.filter((w) => w.state === "entering" || w.state === "on");
}

export interface AgentPlacement {
  agentId: string;
  companyId: string;
  /** The agent itself, then its manager, its manager's manager and so on (reportsTo chain). */
  chain: string[];
}

/** Does a window cover this agent? Department membership is read from the current chain. */
export function windowCoversAgent(window: MaintenanceWindow, agent: AgentPlacement): boolean {
  switch (window.scope.type) {
    case "instance":
      return true;
    case "company":
      return window.scope.id === agent.companyId;
    case "agent":
      return window.scope.id === agent.agentId;
    case "department":
      return window.companyId === agent.companyId && agent.chain.includes(window.scope.id ?? "");
    default:
      return false;
  }
}

/** Build the reportsTo chain from a company's agent list. Cycles are cut. */
export function reportsToChain(agentId: string, reportsTo: Map<string, string | null>): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current: string | null | undefined = agentId;
  while (current && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    current = reportsTo.get(current) ?? null;
  }
  return chain;
}

/** All agents under a manager (the manager included), from a company's agent list. */
export function departmentMembers(managerId: string, reportsTo: Map<string, string | null>): string[] {
  const children = new Map<string, string[]>();
  for (const [id, parent] of reportsTo) {
    if (!parent) continue;
    const list = children.get(parent) ?? [];
    list.push(id);
    children.set(parent, list);
  }
  const members: string[] = [];
  const seen = new Set<string>();
  const stack = [managerId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    members.push(id);
    for (const child of children.get(id) ?? []) stack.push(child);
  }
  return members;
}

export type TickDecision =
  | { kind: "none" }
  | { kind: "mark_on" }
  | { kind: "mark_timed_out" }
  | { kind: "interrupt"; runIds: string[] }
  | { kind: "finish_leaving" };

/**
 * What the tick does with one window, given the runs still running in its scope.
 * `leaving` windows are finished by the service after it wakes the queue.
 */
export function decideTick(window: MaintenanceWindow, runningRunIds: string[], now: Date): TickDecision {
  if (window.state === "leaving") return { kind: "finish_leaving" };
  if (window.state !== "entering") return { kind: "none" };
  if (runningRunIds.length === 0) return { kind: "mark_on" };
  const pastDeadline = now.getTime() >= Date.parse(window.drainDeadlineAt);
  if (!pastDeadline) return { kind: "none" };
  if (window.onTimeout === "interrupt_and_retry") return { kind: "interrupt", runIds: runningRunIds };
  return window.drainTimedOut ? { kind: "none" } : { kind: "mark_timed_out" };
}

export function newWindow(input: {
  id: string;
  scope: MaintenanceScope;
  companyId: string | null;
  reason: string;
  drainTimeoutSec: number;
  onTimeout: MaintenanceOnTimeout;
  startedBy: MaintenanceActor | null;
  now: Date;
}): MaintenanceWindow {
  return {
    id: input.id,
    scope: input.scope.type === "instance" ? { type: "instance" } : { type: input.scope.type, id: input.scope.id },
    companyId: input.companyId,
    state: "entering",
    reason: input.reason,
    drainTimeoutSec: input.drainTimeoutSec,
    onTimeout: input.onTimeout,
    enteredAt: input.now.toISOString(),
    drainDeadlineAt: new Date(input.now.getTime() + input.drainTimeoutSec * 1000).toISOString(),
    onAt: null,
    drainTimedOut: false,
    exitRequestedAt: null,
    startedBy: input.startedBy,
    interruptedRunIds: [],
    zabbix: { maintenanceId: null, lastError: null },
  };
}

/** Move a finished window to history, newest first, bounded. */
export function retireWindow(doc: MaintenanceDocument, windowId: string, now: Date): MaintenanceDocument {
  const window = doc.windows.find((w) => w.id === windowId);
  if (!window) return doc;
  return {
    version: 1,
    windows: doc.windows.filter((w) => w.id !== windowId),
    history: [{ ...window, exitedAt: now.toISOString() }, ...doc.history].slice(0, MAINTENANCE_HISTORY_LIMIT),
  };
}
