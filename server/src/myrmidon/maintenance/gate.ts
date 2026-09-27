// Maintenance mode admission gate. Called from the vendor heartbeat admission points,
// so it must stay cheap and must not import the heartbeat service.

import { eq, inArray } from "drizzle-orm";
import { agents, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import {
  blockingWindows,
  departmentMembers,
  reportsToChain,
  windowCoversAgent,
  type AgentPlacement,
  type MaintenanceDocument,
  type MaintenanceWindow,
} from "./domain.js";
import { readMaintenanceSettings } from "./settings.js";
import { readMaintenanceDocument } from "./store.js";

type Runner = Pick<Db, "select">;

// Process-wide caches, like the vendor task-drain state: every heartbeatService
// instance must see the same gate.
let documentCache: { doc: MaintenanceDocument; at: number } | null = null;
const companyDirectoryCache = new Map<string, { reportsTo: Map<string, string | null>; at: number }>();
const agentCompanyCache = new Map<string, string>();

function cacheTtlMs() {
  return readMaintenanceSettings().cacheTtlMs;
}

/** The service calls this after every write, so the gate sees transitions at once. */
export function setMaintenanceDocumentCache(doc: MaintenanceDocument, now = Date.now()) {
  documentCache = { doc, at: now };
}

/** Test helper: forget every cache. */
export function resetMaintenanceGateCaches() {
  documentCache = null;
  companyDirectoryCache.clear();
  agentCompanyCache.clear();
}

export async function getCachedMaintenanceDocument(db: Runner): Promise<MaintenanceDocument> {
  const now = Date.now();
  if (documentCache && now - documentCache.at < cacheTtlMs()) return documentCache.doc;
  try {
    const doc = await readMaintenanceDocument(db as Db);
    documentCache = { doc, at: now };
    return doc;
  } catch (err) {
    // Keep the last known state on a read failure: an open window must not
    // silently reopen admission because of one failed query.
    if (documentCache) return documentCache.doc;
    throw err;
  }
}

async function companyReportsTo(db: Runner, companyId: string): Promise<Map<string, string | null>> {
  const now = Date.now();
  const cached = companyDirectoryCache.get(companyId);
  if (cached && now - cached.at < cacheTtlMs()) return cached.reportsTo;
  const rows = await db
    .select({ id: agents.id, reportsTo: agents.reportsTo })
    .from(agents)
    .where(eq(agents.companyId, companyId));
  const reportsTo = new Map(rows.map((row) => [row.id, row.reportsTo ?? null] as const));
  companyDirectoryCache.set(companyId, { reportsTo, at: now });
  return reportsTo;
}

export async function resolveAgentPlacement(db: Runner, agentId: string): Promise<AgentPlacement | null> {
  let companyId = agentCompanyCache.get(agentId);
  if (!companyId) {
    const row = await db
      .select({ companyId: agents.companyId })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    companyId = row.companyId;
    agentCompanyCache.set(agentId, companyId);
  }
  const reportsTo = await companyReportsTo(db, companyId);
  return { agentId, companyId, chain: reportsToChain(agentId, reportsTo) };
}

/** Agent ids covered by a window's scope, or null for "every agent" (instance). */
export async function windowAgentIds(db: Runner, window: MaintenanceWindow): Promise<string[] | null> {
  switch (window.scope.type) {
    case "instance":
      return null;
    case "company": {
      const rows = await db.select({ id: agents.id }).from(agents).where(eq(agents.companyId, window.scope.id!));
      return rows.map((row) => row.id);
    }
    case "agent":
      return [window.scope.id!];
    case "department": {
      if (!window.companyId) return [window.scope.id!];
      const reportsTo = await companyReportsTo(db, window.companyId);
      return departmentMembers(window.scope.id!, reportsTo);
    }
    default:
      return [];
  }
}

/** The blocking windows that cover an agent (empty when it may run). */
export async function maintenanceWindowsForAgent(db: Runner, agentId: string): Promise<MaintenanceWindow[]> {
  const windows = blockingWindows(await getCachedMaintenanceDocument(db));
  if (windows.length === 0) return [];
  if (windows.some((w) => w.scope.type === "instance")) return windows.filter((w) => w.scope.type === "instance");
  const placement = await resolveAgentPlacement(db, agentId);
  if (!placement) return [];
  return windows.filter((w) => windowCoversAgent(w, placement));
}

export async function isAgentUnderMaintenance(db: Runner, agentId: string): Promise<boolean> {
  return (await maintenanceWindowsForAgent(db, agentId)).length > 0;
}

/** Admission check for a run id (executeRun re-check). */
export async function isRunUnderMaintenance(db: Runner, runId: string): Promise<boolean> {
  const windows = blockingWindows(await getCachedMaintenanceDocument(db));
  if (windows.length === 0) return false;
  if (windows.some((w) => w.scope.type === "instance")) return true;
  const run = await db
    .select({ agentId: heartbeatRuns.agentId })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, runId))
    .then((rows) => rows[0] ?? null);
  return run ? isAgentUnderMaintenance(db, run.agentId) : false;
}

/**
 * Filter helper for sweeps (watchdogs, stranded issues, timers): drop agents that
 * are under maintenance. Returns the input untouched when no window is open.
 */
export async function filterAgentsOutsideMaintenance<T>(
  db: Runner,
  items: T[],
  agentIdOf: (item: T) => string | null | undefined,
): Promise<T[]> {
  const windows = blockingWindows(await getCachedMaintenanceDocument(db));
  if (windows.length === 0 || items.length === 0) return items;
  if (windows.some((w) => w.scope.type === "instance")) return [];
  const kept: T[] = [];
  for (const item of items) {
    const agentId = agentIdOf(item);
    if (!agentId || !(await isAgentUnderMaintenance(db, agentId))) kept.push(item);
  }
  return kept;
}

/** Is any blocking window open? Cheap check for whole-sweep skips. */
export async function isInstanceUnderMaintenance(db: Runner): Promise<boolean> {
  return blockingWindows(await getCachedMaintenanceDocument(db)).some((w) => w.scope.type === "instance");
}


/**
 * Routine ticks are skipped while a window covers the routine's company or its
 * assignee agent (instance, company, department, agent scopes).
 */
export async function isRoutineUnderMaintenance(
  db: Runner,
  routine: { companyId: string; assigneeAgentId?: string | null },
): Promise<boolean> {
  const windows = blockingWindows(await getCachedMaintenanceDocument(db));
  if (windows.length === 0) return false;
  if (windows.some((w) => w.scope.type === "instance" || (w.scope.type === "company" && w.scope.id === routine.companyId))) {
    return true;
  }
  return routine.assigneeAgentId ? isAgentUnderMaintenance(db, routine.assigneeAgentId) : false;
}

/**
 * Task watchdogs: skip a watchdog when its watchdog agent or the assignee of the
 * watched issue is under maintenance (the subtree looks stopped only because
 * the window holds it).
 */
export async function filterTaskWatchdogsOutsideMaintenance<T extends { issueId: string; watchdogAgentId: string }>(
  db: Runner,
  rows: T[],
): Promise<T[]> {
  const windows = blockingWindows(await getCachedMaintenanceDocument(db));
  if (windows.length === 0 || rows.length === 0) return rows;
  if (windows.some((w) => w.scope.type === "instance")) return [];
  const issueIds = [...new Set(rows.map((row) => row.issueId))];
  const assignees = new Map(
    (
      await db
        .select({ id: issues.id, assigneeAgentId: issues.assigneeAgentId })
        .from(issues)
        .where(inArray(issues.id, issueIds))
    ).map((issue) => [issue.id, issue.assigneeAgentId] as const),
  );
  const kept: T[] = [];
  for (const row of rows) {
    if (await isAgentUnderMaintenance(db, row.watchdogAgentId)) continue;
    const assignee = assignees.get(row.issueId);
    if (assignee && (await isAgentUnderMaintenance(db, assignee))) continue;
    kept.push(row);
  }
  return kept;
}
