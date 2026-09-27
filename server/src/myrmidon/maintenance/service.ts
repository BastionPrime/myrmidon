// Maintenance mode (R3): window lifecycle, counters and the periodic tick.
// Design: docs/myrmidon/design/maintenance-mode.md

import { randomUUID } from "node:crypto";
import { and, eq, inArray, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { agentWakeupRequests, agents, companies, heartbeatRuns, type Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { logActivity } from "../../services/activity-log.js";
import {
  decideTick,
  newWindow,
  retireWindow,
  sameScope,
  type MaintenanceActor,
  type MaintenanceDocument,
  type MaintenanceOnTimeout,
  type MaintenanceScope,
  type MaintenanceState,
  type MaintenanceWindow,
} from "./domain.js";
import { setMaintenanceDocumentCache, windowAgentIds } from "./gate.js";
import { readMaintenanceSettings } from "./settings.js";
import { mutateMaintenanceDocument, readMaintenanceDocument } from "./store.js";

/** The heartbeat operations the mode needs. Injected so tests can observe them. */
export interface MaintenanceHeartbeatPort {
  /** Start whatever is queued and admissible (vendor resumeQueuedRuns). */
  resumeQueuedRuns(): Promise<void>;
  /** Interrupt one running run for maintenance and schedule its retry. */
  interruptRunForMaintenance?(runId: string, windowId: string): Promise<{ retryScheduled: boolean }>;
}

/** Side integrations (Zabbix). Failures are logged and never block the mode. */
export interface MaintenanceHooks {
  onEntered?(window: MaintenanceWindow): Promise<Partial<MaintenanceWindow["zabbix"]> | void>;
  onExited?(window: MaintenanceWindow): Promise<Partial<MaintenanceWindow["zabbix"]> | void>;
}

export class MaintenanceError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

export interface MaintenanceWindowView {
  id: string;
  scope: MaintenanceScope;
  companyId: string | null;
  state: MaintenanceState;
  reason: string;
  drainTimeoutSec: number;
  onTimeout: MaintenanceOnTimeout;
  startedAt: string;
  onAt: string | null;
  drainDeadlineAt: string;
  drainTimedOut: boolean;
  exitRequestedAt: string | null;
  runningRuns: number;
  queuedRuns: number;
  queuedWakeups: number;
  interruptedRuns: number;
  startedBy: MaintenanceActor | null;
}

export interface MaintenanceStatusView {
  active: boolean;
  instance: MaintenanceWindowView | null;
  windows: MaintenanceWindowView[];
}

export interface EnterInput {
  scope: MaintenanceScope;
  reason: string;
  drainTimeoutSec?: number;
  onTimeout?: MaintenanceOnTimeout;
}

const SYSTEM_ACTOR: MaintenanceActor = { actorType: "system", actorId: "myrmidon-maintenance" };

export function maintenanceService(
  db: Db,
  deps: { heartbeat: MaintenanceHeartbeatPort; hooks?: MaintenanceHooks; now?: () => Date },
) {
  const now = deps.now ?? (() => new Date());
  const hooks = deps.hooks ?? {};

  async function agentFilter(window: MaintenanceWindow, column: AnyPgColumn): Promise<SQL | null | false> {
    const ids = await windowAgentIds(db, window);
    if (ids === null) return null;
    if (ids.length === 0) return false;
    return inArray(column, ids);
  }

  async function runIdsInScope(window: MaintenanceWindow, statuses: string[]): Promise<string[]> {
    const filter = await agentFilter(window, heartbeatRuns.agentId);
    if (filter === false) return [];
    const rows = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(inArray(heartbeatRuns.status, statuses), filter ?? undefined));
    return rows.map((row) => row.id);
  }

  async function countWakeups(window: MaintenanceWindow): Promise<number> {
    const filter = await agentFilter(window, agentWakeupRequests.agentId);
    if (filter === false) return 0;
    const rows = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(and(inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"]), filter ?? undefined));
    return rows.length;
  }

  async function view(window: MaintenanceWindow): Promise<MaintenanceWindowView> {
    const [running, queued, wakeups] = await Promise.all([
      runIdsInScope(window, ["running"]),
      runIdsInScope(window, ["queued", "scheduled_retry"]),
      countWakeups(window),
    ]);
    return {
      id: window.id,
      scope: window.scope,
      companyId: window.companyId,
      state: window.state,
      reason: window.reason,
      drainTimeoutSec: window.drainTimeoutSec,
      onTimeout: window.onTimeout,
      startedAt: window.enteredAt,
      onAt: window.onAt,
      drainDeadlineAt: window.drainDeadlineAt,
      drainTimedOut: window.drainTimedOut,
      exitRequestedAt: window.exitRequestedAt,
      runningRuns: running.length,
      queuedRuns: queued.length,
      queuedWakeups: wakeups,
      interruptedRuns: window.interruptedRunIds.length,
      startedBy: window.startedBy,
    };
  }

  async function companyIdsFor(window: MaintenanceWindow): Promise<string[]> {
    if (window.companyId) return [window.companyId];
    const rows = await db.select({ id: companies.id }).from(companies);
    return rows.map((row) => row.id);
  }

  async function audit(
    window: MaintenanceWindow,
    action: string,
    actor: MaintenanceActor,
    details: Record<string, unknown> = {},
  ) {
    try {
      const companyIds = await companyIdsFor(window);
      for (const companyId of companyIds) {
        await logActivity(db, {
          companyId,
          actorType: actor.actorType as "user" | "system",
          actorId: actor.actorId,
          action: `myrmidon.maintenance.${action}`,
          entityType: "myrmidon_maintenance",
          entityId: window.id,
          details: { scope: window.scope, reason: window.reason, state: window.state, ...details },
        });
      }
    } catch (err) {
      logger.error({ err, windowId: window.id, action }, "failed to write maintenance activity");
    }
  }

  async function write<T>(change: (doc: MaintenanceDocument) => { next: MaintenanceDocument | null; result: T }) {
    const out = await mutateMaintenanceDocument(db, change);
    setMaintenanceDocumentCache(out.doc);
    return out;
  }

  function updateWindow(doc: MaintenanceDocument, id: string, patch: Partial<MaintenanceWindow>): MaintenanceDocument {
    return { ...doc, windows: doc.windows.map((w) => (w.id === id ? { ...w, ...patch } : w)) };
  }

  async function resolveScope(scope: MaintenanceScope): Promise<{ scope: MaintenanceScope; companyId: string | null }> {
    if (scope.type === "instance") return { scope: { type: "instance" }, companyId: null };
    const id = scope.id!;
    if (scope.type === "company") {
      const row = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, id)).then((r) => r[0]);
      if (!row) throw new MaintenanceError(404, "Company not found");
      return { scope: { type: "company", id }, companyId: id };
    }
    const agent = await db
      .select({ id: agents.id, companyId: agents.companyId })
      .from(agents)
      .where(eq(agents.id, id))
      .then((r) => r[0]);
    if (!agent) throw new MaintenanceError(404, "Agent not found");
    return { scope: { type: scope.type, id }, companyId: agent.companyId };
  }

  async function runHook(window: MaintenanceWindow, name: "onEntered" | "onExited") {
    const hook = hooks[name];
    if (!hook) return;
    try {
      const zabbix = await hook(window);
      if (zabbix && name === "onEntered") {
        await write((doc) => ({
          next: doc.windows.some((w) => w.id === window.id)
            ? updateWindow(doc, window.id, { zabbix: { ...window.zabbix, ...zabbix } })
            : null,
          result: null,
        }));
      }
    } catch (err) {
      logger.error({ err, windowId: window.id, hook: name }, "maintenance integration hook failed");
    }
  }

  async function finishLeaving(window: MaintenanceWindow) {
    // Admission is already open for this window (state `leaving`); start what queued up.
    try {
      await deps.heartbeat.resumeQueuedRuns();
    } catch (err) {
      // The vendor periodic resumeQueuedRuns picks the queue up anyway.
      logger.error({ err, windowId: window.id }, "failed to resume queued runs after maintenance");
    }
    await runHook(window, "onExited");
    const at = now();
    await write((doc) => ({
      next: doc.windows.some((w) => w.id === window.id) ? retireWindow(doc, window.id, at) : null,
      result: null,
    }));
    await audit(window, "exited", SYSTEM_ACTOR);
  }

  async function tickWindow(window: MaintenanceWindow) {
    if (window.state === "leaving") {
      await finishLeaving(window);
      return;
    }
    const running = await runIdsInScope(window, ["running"]);
    const decision = decideTick(window, running, now());
    if (decision.kind === "mark_on") {
      const at = now().toISOString();
      const { changed } = await write((doc) => {
        const current = doc.windows.find((w) => w.id === window.id);
        if (!current || current.state !== "entering") return { next: null, result: null };
        return { next: updateWindow(doc, window.id, { state: "on", onAt: at }), result: null };
      });
      if (changed) await audit({ ...window, state: "on" }, "on", SYSTEM_ACTOR);
    } else if (decision.kind === "mark_timed_out") {
      const { changed } = await write((doc) => {
        const current = doc.windows.find((w) => w.id === window.id);
        if (!current || current.state !== "entering" || current.drainTimedOut) return { next: null, result: null };
        return { next: updateWindow(doc, window.id, { drainTimedOut: true }), result: null };
      });
      if (changed) await audit(window, "drain_timed_out", SYSTEM_ACTOR, { runningRuns: running.length });
    } else if (decision.kind === "interrupt") {
      await interruptRuns(window, decision.runIds);
    }
  }

  async function interruptRuns(window: MaintenanceWindow, runIds: string[]) {
    const interrupt = deps.heartbeat.interruptRunForMaintenance;
    if (!interrupt) return;
    for (const runId of runIds) {
      if (window.interruptedRunIds.includes(runId)) continue;
      try {
        const { retryScheduled } = await interrupt(runId, window.id);
        await write((doc) => {
          const current = doc.windows.find((w) => w.id === window.id);
          if (!current) return { next: null, result: null };
          return {
            next: updateWindow(doc, window.id, {
              drainTimedOut: true,
              interruptedRunIds: [...new Set([...current.interruptedRunIds, runId])],
            }),
            result: null,
          };
        });
        await audit(window, "run_interrupted", SYSTEM_ACTOR, { runId });
        if (!retryScheduled) await audit(window, "retry_not_scheduled", SYSTEM_ACTOR, { runId });
      } catch (err) {
        logger.error({ err, runId, windowId: window.id }, "failed to interrupt run for maintenance");
        await audit(window, "interrupt_failed", SYSTEM_ACTOR, { runId, error: String(err) });
      }
    }
  }

  let tickInFlight: Promise<void> | null = null;

  async function tick() {
    if (tickInFlight) return tickInFlight;
    tickInFlight = (async () => {
      const doc = await readMaintenanceDocument(db);
      setMaintenanceDocumentCache(doc);
      for (const window of doc.windows) {
        try {
          await tickWindow(window);
        } catch (err) {
          logger.error({ err, windowId: window.id }, "maintenance tick failed for window");
        }
      }
    })().finally(() => {
      tickInFlight = null;
    });
    return tickInFlight;
  }

  async function status(filter?: MaintenanceScope): Promise<MaintenanceStatusView> {
    const doc = await readMaintenanceDocument(db);
    setMaintenanceDocumentCache(doc);
    const selected = filter ? doc.windows.filter((w) => sameScope(w.scope, filter)) : doc.windows;
    const views = await Promise.all(selected.map(view));
    return {
      active: doc.windows.length > 0,
      instance: views.find((v) => v.scope.type === "instance") ?? null,
      windows: views,
    };
  }

  return {
    status,
    tick,

    async enter(input: EnterInput, actor: MaintenanceActor) {
      const { scope, companyId } = await resolveScope(input.scope);
      const settings = readMaintenanceSettings();
      const at = now();
      const candidate = newWindow({
        id: randomUUID(),
        scope,
        companyId,
        reason: input.reason,
        drainTimeoutSec: input.drainTimeoutSec ?? settings.defaultDrainTimeoutSec,
        onTimeout: input.onTimeout ?? "wait",
        startedBy: actor,
        now: at,
      });
      const { result: window, changed } = await write((doc) => {
        const existing = doc.windows.find((w) => sameScope(w.scope, scope));
        if (existing?.state === "leaving") {
          throw new MaintenanceError(409, "Maintenance for this scope is still leaving; retry shortly");
        }
        if (existing) return { next: null, result: existing };
        return { next: { ...doc, windows: [...doc.windows, candidate] }, result: candidate };
      });
      if (changed) {
        await audit(window, "enter_requested", actor, {
          drainTimeoutSec: window.drainTimeoutSec,
          onTimeout: window.onTimeout,
        });
        await runHook(window, "onEntered");
        await tickWindow(window);
      }
      const current = (await readMaintenanceDocument(db)).windows.find((w) => w.id === window.id) ?? window;
      return { ...(await view(current)), changed };
    },

    async exit(scopeInput: MaintenanceScope, actor: MaintenanceActor, reason?: string) {
      const scope: MaintenanceScope = scopeInput.type === "instance" ? { type: "instance" } : scopeInput;
      const at = now().toISOString();
      const { result: window, changed } = await write((doc) => {
        const existing = doc.windows.find((w) => sameScope(w.scope, scope));
        if (!existing || existing.state === "leaving") return { next: null, result: existing ?? null };
        const leaving: MaintenanceWindow = { ...existing, state: "leaving", exitRequestedAt: at };
        return { next: updateWindow(doc, existing.id, leaving), result: leaving };
      });
      if (!window) return { scope, state: "off" as const, changed: false };
      if (changed) await audit(window, "exit_requested", actor, reason ? { exitReason: reason } : {});
      await finishLeaving(window);
      const still = (await readMaintenanceDocument(db)).windows.find((w) => w.id === window.id);
      if (still) return { ...(await view(still)), changed };
      return { scope, state: "off" as const, changed };
    },

    /** Startup: load windows before the scheduler's first pass and finish interrupted exits. */
    async restore() {
      const doc = await readMaintenanceDocument(db);
      setMaintenanceDocumentCache(doc);
      return doc;
    },
  };
}

export type MaintenanceService = ReturnType<typeof maintenanceService>;
