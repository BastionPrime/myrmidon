// Live run admission limits (myrmidon C0, RUNTIME-LIMITS): read, change and
// apply the four ceilings without restarting the server.
//
// Contract: `instance_settings.general.runLimits` is the source of truth once
// an operator saves it; the environment stays the default for an instance that
// never did (see packages/shared/src/myrmidon-runtime-limits.ts for the
// precedence and the value rules). A change writes the row, records it in the
// activity log for every company, then applies it to the process-wide
// admission and asks the queued-run sweep to run, so runs waiting behind the
// old ceiling start within the resweep delay instead of at the next scheduler
// tick.
//
// Two overlapping requests can commit their rows in one order and reach the
// in-memory apply in the other; the audit log would then disagree with the
// limits actually in force. Every request's read-write-audit-apply sequence
// runs through one queue (see `withRuntimeLimitsTransition`), exactly as the
// task-drain transition does.

import type { Db } from "@paperclipai/db";
import {
  RUN_LIMIT_KEYS,
  mergeRunLimits,
  resolveRunLimits,
  type ResolvedRunLimits,
  type RunLimits,
  type RunLimitsPatch,
} from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { instanceSettingsService, logActivity } from "../../services/index.js";

export type RuntimeLimitsView = ResolvedRunLimits;

/** Who changed the limits, for the activity log. */
export interface RuntimeLimitsActor {
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  agentId: string | null;
  runId: string | null;
  agentApiKeyId: string | null;
}

/** One activity row; the database service fills in the entity fields. */
export type RuntimeLimitsAuditEntry = RuntimeLimitsActor & {
  companyId: string;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown>;
};

/** Everything the service needs, so tests can run it without a database. */
export interface RuntimeLimitsServiceDeps {
  settings: {
    getGeneral(): Promise<{ runLimits?: unknown }>;
    updateGeneral(patch: { runLimits: RunLimits }): Promise<unknown>;
  };
  listCompanyIds(): Promise<string[]>;
  logActivity(entry: RuntimeLimitsAuditEntry): Promise<unknown>;
  /** Put the limits in force on the live admission. */
  apply(limits: RunLimits): void;
  /** Ask the queued-run sweep to run shortly, so held runs start without waiting for the tick. */
  scheduleResweep(): void;
  env?: Record<string, string | undefined>;
}

export interface RuntimeLimitsService {
  /** Effective limits and where each value came from. */
  read(): Promise<RuntimeLimitsView>;
  /** Persist, audit and apply a patch; returns the limits now in force. */
  update(patch: RunLimitsPatch, actor: RuntimeLimitsActor): Promise<RuntimeLimitsView>;
}

/** `instance.runtime_limits.updated` — the audit action of a limits change. */
export const RUNTIME_LIMITS_ACTION = "instance.runtime_limits.updated";

let runtimeLimitsTransitionQueue: Promise<void> = Promise.resolve();

function withRuntimeLimitsTransition<T>(run: () => Promise<T>): Promise<T> {
  const turn = runtimeLimitsTransitionQueue.then(run);
  // Normalize to a settled void promise for the next caller in line, so a
  // rejected transition cannot wedge every later one behind it.
  runtimeLimitsTransitionQueue = turn.then(
    () => undefined,
    () => undefined,
  );
  return turn;
}

export function runtimeLimitsService(
  db: Db,
  overrides: Partial<RuntimeLimitsServiceDeps> = {},
): RuntimeLimitsService {
  const deps: RuntimeLimitsServiceDeps = {
    settings: instanceSettingsService(db),
    listCompanyIds: () => instanceSettingsService(db).listCompanyIds(),
    logActivity: (entry) => logActivity(db, entry),
    apply: () => undefined,
    scheduleResweep: () => undefined,
    ...overrides,
  };
  const env = deps.env ?? process.env;

  return {
    read: async (): Promise<RuntimeLimitsView> => {
      const general = await deps.settings.getGeneral();
      return resolveRunLimits({ stored: general.runLimits, env });
    },

    update: async (patch, actor) =>
      withRuntimeLimitsTransition(async () => {
        const general = await deps.settings.getGeneral();
        const before = resolveRunLimits({ stored: general.runLimits, env });
        const next = mergeRunLimits(before.limits, patch);
        const changedKeys = RUN_LIMIT_KEYS.filter((key) => before.limits[key] !== next[key]);

        await deps.settings.updateGeneral({ runLimits: next });

        const companyIds = await deps.listCompanyIds();
        await Promise.all(
          companyIds.map((companyId) =>
            deps.logActivity({
              companyId,
              actorType: actor.actorType,
              actorId: actor.actorId,
              agentId: actor.agentId,
              runId: actor.runId,
              agentApiKeyId: actor.agentApiKeyId,
              action: RUNTIME_LIMITS_ACTION,
              entityType: "instance_settings",
              entityId: "default",
              details: { previous: before.limits, next, changedKeys },
            }),
          ),
        );

        // Only after the row and the audit records are committed: the limits in
        // force must never run ahead of what the log says they are.
        deps.apply(next);
        deps.scheduleResweep();
        logger.info(
          { limits: next, changedKeys, actorType: actor.actorType },
          "run admission limits updated without a restart",
        );
        return resolveRunLimits({ stored: next, env });
      }),
  };
}