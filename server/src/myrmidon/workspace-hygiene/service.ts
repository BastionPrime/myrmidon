import {
  WORKSPACE_HYGIENE_LIMIT_KEYS,
  WORKSPACE_HYGIENE_UPDATED_ACTION,
  mergeWorkspaceHygieneLimits,
  readWorkspaceHygieneRecord,
  resolveWorkspaceHygieneLimits,
  summarizeWorkspaceMeasurements,
  type ResolvedWorkspaceHygieneLimits,
  type WorkspaceHygieneLimits,
  type WorkspaceHygieneLimitsPatch,
} from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import type { LogActivityInput } from "../../services/activity-log.js";
import type { WorkspaceHygieneStore } from "./store.js";
import type { WorkspaceHygieneSweepResult } from "./sweep.js";

/**
 * Read and change the workspace quotas without a restart (myrmidon
 * WORKSPACE-HYGIENE, part C).
 *
 * Contract: `instance_settings.general.workspaceHygiene` is the source of truth
 * once an operator saves it; the environment stays the default for an instance
 * that never did (see packages/shared/src/myrmidon-workspace-hygiene.ts for the
 * precedence and the value rules). A change writes the row and records it in
 * the activity log for every company. Nothing has to be applied to a live
 * object: the sweep reads the quotas at the top of every tick, so the next tick
 * already uses the new value.
 *
 * The read side never walks the disk. It reports what the sweep last measured
 * (stored in the workspace metadata) plus the size of the quotas in force, so
 * the endpoint stays cheap enough for a panel that polls it.
 *
 * Two overlapping writes can commit their rows in one order and audit them in
 * the other; the audit would then disagree with the stored value. Every write
 * runs through one queue, exactly as the runtime limits transition does.
 */

export interface WorkspaceHygieneActor {
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  agentId: string | null;
  runId: string | null;
  agentApiKeyId: string | null;
}

export interface WorkspaceHygieneWorkspaceView {
  id: string;
  name: string;
  status: string;
  sizeBytes: number;
  sizeMb: number;
  measuredAt: string;
  overQuota: boolean;
  truncated: boolean;
}

export interface WorkspaceHygieneView {
  quota: {
    workspaceQuotaMb: number | null;
    totalQuotaMb: number | null;
    sources: ResolvedWorkspaceHygieneLimits["sources"];
  };
  workspaces: WorkspaceHygieneWorkspaceView[];
  status: {
    measuredWorkspaces: number;
    overQuotaCount: number;
    totalSizeMb: number;
    lastSweepAt: string | null;
    lastSweep: WorkspaceHygieneSweepResult | null;
  };
}

/** Upper bound on the rows read for the view; a panel wants the biggest ones, not every row. */
export const WORKSPACE_HYGIENE_VIEW_MEASURED_LIMIT = 500;
/** Rows returned by the endpoint. */
export const WORKSPACE_HYGIENE_VIEW_WORKSPACE_LIMIT = 200;

export interface WorkspaceHygieneServiceDeps {
  settings: {
    getGeneral(): Promise<{ workspaceHygiene?: unknown }>;
    updateGeneral(patch: { workspaceHygiene: WorkspaceHygieneLimits }): Promise<unknown>;
  };
  listCompanyIds(): Promise<string[]>;
  logActivity(entry: LogActivityInput): Promise<unknown>;
  store: WorkspaceHygieneStore;
  /** Result of the last sweep of this process, when one ran. */
  lastSweep?: () => WorkspaceHygieneSweepResult | null;
  env?: Record<string, string | undefined>;
}

export interface WorkspaceHygieneService {
  /** Quotas in force and the sizes of the last measurements. */
  read(): Promise<WorkspaceHygieneView>;
  /** Persist and audit a patch; returns the quotas now in force. */
  update(patch: WorkspaceHygieneLimitsPatch, actor: WorkspaceHygieneActor): Promise<WorkspaceHygieneView>;
}

let workspaceHygieneTransitionQueue: Promise<void> = Promise.resolve();

function withWorkspaceHygieneTransition<T>(run: () => Promise<T>): Promise<T> {
  const turn = workspaceHygieneTransitionQueue.then(run);
  // Normalize to a settled void promise for the next caller in line, so a
  // rejected transition cannot wedge every later one behind it.
  workspaceHygieneTransitionQueue = turn.then(
    () => undefined,
    () => undefined,
  );
  return turn;
}

export function workspaceHygieneService(
  deps: WorkspaceHygieneServiceDeps,
): WorkspaceHygieneService {
  const env = deps.env ?? process.env;

  async function read(): Promise<WorkspaceHygieneView> {
    const general = await deps.settings.getGeneral();
    const resolved = resolveWorkspaceHygieneLimits({ stored: general.workspaceHygiene, env });
    const rows = await deps.store.listMeasured(WORKSPACE_HYGIENE_VIEW_MEASURED_LIMIT);
    const workspaces: WorkspaceHygieneWorkspaceView[] = [];
    for (const row of rows) {
      const record = readWorkspaceHygieneRecord(row.metadata);
      if (!record) continue;
      workspaces.push({
        id: row.id,
        name: row.name,
        status: row.status,
        sizeBytes: record.sizeBytes,
        sizeMb: Math.round(record.sizeBytes / (1024 * 1024)),
        measuredAt: record.measuredAt,
        overQuota: record.overQuota,
        truncated: record.truncated,
      });
    }
    // Biggest first: the panel exists to show what fills the disk.
    workspaces.sort((a, b) => b.sizeBytes - a.sizeBytes || a.name.localeCompare(b.name));
    const summary = summarizeWorkspaceMeasurements(workspaces);
    const lastSweep = deps.lastSweep?.() ?? null;
    return {
      quota: {
        workspaceQuotaMb: resolved.limits.workspaceQuotaMb,
        totalQuotaMb: resolved.limits.totalQuotaMb,
        sources: resolved.sources,
      },
      workspaces: workspaces.slice(0, WORKSPACE_HYGIENE_VIEW_WORKSPACE_LIMIT),
      status: {
        measuredWorkspaces: summary.measuredWorkspaces,
        overQuotaCount: summary.overQuotaCount,
        totalSizeMb: Math.round(summary.totalBytes / (1024 * 1024)),
        lastSweepAt: lastSweep?.at ?? null,
        lastSweep,
      },
    };
  }

  return {
    read,

    update: async (patch, actor) =>
      withWorkspaceHygieneTransition(async () => {
        const general = await deps.settings.getGeneral();
        const before = resolveWorkspaceHygieneLimits({ stored: general.workspaceHygiene, env });
        const next = mergeWorkspaceHygieneLimits(before.limits, patch);
        const changedKeys = WORKSPACE_HYGIENE_LIMIT_KEYS.filter(
          (key) => before.limits[key] !== next[key],
        );

        await deps.settings.updateGeneral({ workspaceHygiene: next });

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
              action: WORKSPACE_HYGIENE_UPDATED_ACTION,
              entityType: "instance_settings",
              entityId: "workspace-hygiene",
              details: { previous: before.limits, next, changedKeys },
            }),
          ),
        );

        logger.info(
          { quotas: next, changedKeys, actorType: actor.actorType },
          "workspace hygiene quotas updated without a restart",
        );
        return read();
      }),
  };
}