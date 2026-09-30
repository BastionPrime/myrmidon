import {
  WORKSPACE_QUOTA_EXCEEDED_ACTION,
  WORKSPACE_QUOTA_SIGNAL_INTERVAL_MS,
  WORKSPACE_TOTAL_QUOTA_EXCEEDED_ACTION,
  isWorkspaceOverQuota,
  readWorkspaceHygieneRecord,
  shouldSignalWorkspaceQuota,
  workspaceQuotaBytes,
  workspaceQuotaSignalDetails,
  workspaceTotalQuotaSignalDetails,
  writeWorkspaceHygieneRecord,
  type WorkspaceHygieneLimits,
  type WorkspaceHygieneMeasurementRecord,
} from "@paperclipai/shared";
import type { LogActivityInput } from "../../services/activity-log.js";
import { measureWorkspaceSize, type WorkspaceSizeMeasurement } from "./measure.js";
import type { WorkspaceHygieneStore } from "./store.js";

/**
 * The workspace quota sweep (myrmidon WORKSPACE-HYGIENE, part C).
 *
 * Runs from the server's scheduler tick, next to the terminal workspace reaper.
 * One tick looks at one page of workspaces in a rotating `(updatedAt, id)`
 * order, measures the local directory of each one, stores the measurement in
 * the workspace metadata and, when the workspace is over the quota, writes one
 * "clean up" line into the activity log. A later tick continues where the
 * previous one stopped, so the whole fleet is covered without one tick ever
 * measuring everything.
 *
 * Why the parts are bounded the way they are:
 *
 * - one page per tick, with a keyset cursor: measuring every workspace in one
 *   tick would hold the shared scheduler;
 * - `remeasureIntervalMs`: a workspace is measured at most once per interval,
 *   so the disk walk is not repeated on every tick;
 * - `maxSweepMs`: the whole sweep gives up after this long and the rest of the
 *   page waits for the next rotation;
 * - the walk itself is bounded by depth, entries and time (see measure.ts);
 * - a signal is suppressed for `signalIntervalMs` after the previous one, so a
 *   workspace that stays over its quota does not fill the activity log.
 *
 * The sweep is a signal, not a reaper: it never deletes anything. Deleting a
 * workspace is the terminal workspace reaper's job (part B of the same
 * feature).
 */

/** Author of the sweep's activity lines. */
export const WORKSPACE_HYGIENE_ACTOR_ID = "workspace_hygiene_sweep";

/** Workspaces measured per tick. */
export const WORKSPACE_HYGIENE_DEFAULT_PAGE_SIZE = 25;
/** A workspace is not measured again within this window. */
export const WORKSPACE_HYGIENE_DEFAULT_REMEASURE_MS = 6 * 60 * 60 * 1000;
/** The whole sweep stops after this long, whatever is left in the page. */
export const WORKSPACE_HYGIENE_DEFAULT_MAX_SWEEP_MS = 15_000;
/** Upper bound on the rows read for the instance totals. */
export const WORKSPACE_HYGIENE_TOTAL_MEASURED_LIMIT = 2_000;

export interface WorkspaceHygieneLogger {
  info(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
  error(payload: Record<string, unknown>, message: string): void;
}

export interface WorkspaceHygieneSweepResult {
  /** ISO timestamp when this sweep started; the freshness anchor the API reports. */
  at: string;
  /** Rows taken from the rotation in this tick. */
  scanned: number;
  measured: number;
  /** Rows whose measurement was still fresh. */
  skippedFresh: number;
  /** Rows with no local directory to measure. */
  skippedUnmeasurable: number;
  failed: number;
  overQuota: number;
  /** "Clean up" signals written in this tick. */
  signalled: number;
  /** Sum of the sizes measured in this tick, in bytes. */
  totalBytes: number;
  /** True when the per-company total signal was written in this tick. */
  totalSignalled: boolean;
  /** Measurements that hit the walk cap and are lower bounds. */
  truncated: number;
  elapsedMs: number;
}

export interface WorkspaceHygieneSweepDeps {
  store: WorkspaceHygieneStore;
  /** Quotas in force; read at the top of every sweep, so a change applies at once. */
  resolveLimits: () => Promise<WorkspaceHygieneLimits>;
  measure?: (cwd: string) => Promise<WorkspaceSizeMeasurement>;
  logActivity: (entry: LogActivityInput) => Promise<unknown>;
  logger?: WorkspaceHygieneLogger;
  now?: () => Date;
  pageSize?: number;
  remeasureIntervalMs?: number;
  maxSweepMs?: number;
  signalIntervalMs?: number;
}

export interface WorkspaceHygieneSweep {
  sweep(): Promise<WorkspaceHygieneSweepResult>;
  /** The result of the last finished sweep, or null before the first one. */
  lastResult(): WorkspaceHygieneSweepResult | null;
}

function emptyResult(at: string, elapsedMs = 0): WorkspaceHygieneSweepResult {
  return {
    at,
    scanned: 0,
    measured: 0,
    skippedFresh: 0,
    skippedUnmeasurable: 0,
    failed: 0,
    overQuota: 0,
    signalled: 0,
    totalBytes: 0,
    totalSignalled: false,
    truncated: 0,
    elapsedMs,
  };
}

export function createWorkspaceHygieneSweep(deps: WorkspaceHygieneSweepDeps): WorkspaceHygieneSweep {
  const pageSize = deps.pageSize ?? WORKSPACE_HYGIENE_DEFAULT_PAGE_SIZE;
  const remeasureIntervalMs = deps.remeasureIntervalMs ?? WORKSPACE_HYGIENE_DEFAULT_REMEASURE_MS;
  const maxSweepMs = deps.maxSweepMs ?? WORKSPACE_HYGIENE_DEFAULT_MAX_SWEEP_MS;
  const signalIntervalMs = deps.signalIntervalMs ?? WORKSPACE_QUOTA_SIGNAL_INTERVAL_MS;
  const measure = deps.measure ?? ((cwd: string) => measureWorkspaceSize(cwd));
  const clock = deps.now ?? (() => new Date());

  let cursor: { updatedAt: Date; id: string } | null = null;
  let boundary: Date | null = null;
  let lastResult: WorkspaceHygieneSweepResult | null = null;
  let inFlight: Promise<WorkspaceHygieneSweepResult> | null = null;

  async function runSweep(): Promise<WorkspaceHygieneSweepResult> {
    const startedAt = clock().getTime();
    const limits = await deps.resolveLimits();
    const now = clock();
    // Freeze the upper bound for the whole rotation. Without it a steady stream
    // of newer rows keeps every page full and the cursor never reaches the end.
    if (!boundary) boundary = now;
    const page = await deps.store.listPage({ cursor, boundary, limit: pageSize });
    if (page.length < pageSize) {
      cursor = null;
      boundary = null;
    } else {
      const last = page[page.length - 1]!;
      cursor = { updatedAt: last.updatedAt, id: last.id };
    }

    const result = emptyResult(now.toISOString());
    for (const row of page) {
      if (clock().getTime() - startedAt > maxSweepMs) break;
      result.scanned += 1;

      const previous = readWorkspaceHygieneRecord(row.metadata);
      const previousMeasuredAt = previous ? Date.parse(previous.measuredAt) : Number.NaN;
      if (previous && Number.isFinite(previousMeasuredAt) && now.getTime() - previousMeasuredAt < remeasureIntervalMs) {
        result.skippedFresh += 1;
        continue;
      }
      if (row.providerType !== "local_fs" || !row.cwd) {
        result.skippedUnmeasurable += 1;
        continue;
      }

      let measurement: WorkspaceSizeMeasurement;
      try {
        measurement = await measure(row.cwd);
      } catch {
        result.failed += 1;
        continue;
      }

      const overQuota = isWorkspaceOverQuota(measurement.sizeBytes, limits.workspaceQuotaMb);
      if (overQuota) result.overQuota += 1;
      const measuredAt = now.toISOString();
      let lastSignalAt = previous?.lastSignalAt ?? null;
      const signalDue = shouldSignalWorkspaceQuota({
        sizeBytes: measurement.sizeBytes,
        quotaMb: limits.workspaceQuotaMb,
        lastSignalAt,
        now,
        intervalMs: signalIntervalMs,
      });
      if (signalDue) {
        try {
          await deps.logActivity({
            companyId: row.companyId,
            actorType: "system",
            actorId: WORKSPACE_HYGIENE_ACTOR_ID,
            action: WORKSPACE_QUOTA_EXCEEDED_ACTION,
            entityType: "execution_workspace",
            entityId: row.id,
            details: workspaceQuotaSignalDetails({
              workspaceId: row.id,
              workspaceName: row.name,
              sizeBytes: measurement.sizeBytes,
              quotaMb: limits.workspaceQuotaMb,
              measuredAt,
            }),
          });
          result.signalled += 1;
          lastSignalAt = measuredAt;
        } catch {
          // Keep the previous timestamp: an unwritten signal must not silence
          // the next tick.
          result.failed += 1;
        }
      }

      const record: WorkspaceHygieneMeasurementRecord = {
        measuredAt,
        sizeBytes: measurement.sizeBytes,
        entries: measurement.entries,
        truncated: measurement.truncated,
        overQuota,
        lastSignalAt,
      };
      try {
        await deps.store.saveMetadata(row.id, writeWorkspaceHygieneRecord(row.metadata, record));
      } catch {
        result.failed += 1;
        continue;
      }
      result.measured += 1;
      result.totalBytes += measurement.sizeBytes;
      if (measurement.truncated) result.truncated += 1;
    }

    result.totalSignalled = await signalCompanyTotals(limits, now, result);
    result.elapsedMs = Math.max(0, clock().getTime() - startedAt);
    if (result.measured > 0 || result.signalled > 0 || result.failed > 0) {
      deps.logger?.info({ ...result }, "workspace hygiene sweep measured workspaces");
    }
    lastResult = result;
    return result;
  }

  async function signalCompanyTotals(
    limits: WorkspaceHygieneLimits,
    now: Date,
    result: WorkspaceHygieneSweepResult,
  ): Promise<boolean> {
    if (limits.totalQuotaMb === null) return false;
    const totalQuotaBytes = workspaceQuotaBytes(limits.totalQuotaMb)!;
    const rows = await deps.store.listMeasured(WORKSPACE_HYGIENE_TOTAL_MEASURED_LIMIT);
    const perCompany = new Map<string, { bytes: number; count: number }>();
    for (const row of rows) {
      const record = readWorkspaceHygieneRecord(row.metadata);
      if (!record) continue;
      const current = perCompany.get(row.companyId) ?? { bytes: 0, count: 0 };
      current.bytes += record.sizeBytes;
      current.count += 1;
      perCompany.set(row.companyId, current);
    }
    let signalled = false;
    for (const [companyId, total] of perCompany) {
      if (total.bytes <= totalQuotaBytes) continue;
      const lastSignalAt = await deps.store.lastActivityAt(companyId, WORKSPACE_TOTAL_QUOTA_EXCEEDED_ACTION);
      if (lastSignalAt && now.getTime() - lastSignalAt.getTime() < signalIntervalMs) continue;
      try {
        await deps.logActivity({
          companyId,
          actorType: "system",
          actorId: WORKSPACE_HYGIENE_ACTOR_ID,
          action: WORKSPACE_TOTAL_QUOTA_EXCEEDED_ACTION,
          entityType: "instance_settings",
          entityId: "workspace-hygiene",
          details: workspaceTotalQuotaSignalDetails({
            totalBytes: total.bytes,
            totalQuotaMb: limits.totalQuotaMb,
            measuredWorkspaces: total.count,
          }),
        });
        signalled = true;
        result.signalled += 1;
      } catch {
        result.failed += 1;
      }
    }
    return signalled;
  }

  return {
    sweep: () => {
      // A tick that arrives while a sweep runs joins it instead of measuring the
      // same workspaces twice.
      if (inFlight) return inFlight;
      inFlight = runSweep().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    lastResult: () => lastResult,
  };
}