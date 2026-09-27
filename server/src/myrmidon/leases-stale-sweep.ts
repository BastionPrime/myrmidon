import { and, asc, eq, inArray, isNotNull, lte } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import type { environmentService } from "../services/environments.js";
import type { environmentRuntimeService } from "../services/environment-runtime.js";
import { remoteTerminationReceipt } from "../services/remote-execution-termination.js";

/**
 * Stale active environment lease sweep (P1).
 *
 * A cancelled, failed or timed-out run can keep its environment lease `active`
 * when its own finalization never released it (a cancel path that skipped the
 * release, a missed teardown, a crash window). An active lease on a terminal run
 * keeps the issue busy (execution_owner_active) and defers every later wake.
 *
 * The sweep finds such leases once the run has been finished for longer than a
 * grace window, checks that the run process is really gone, tears the provider
 * sandbox down from the recorded lease data and marks the lease `expired`.
 * A teardown failure keeps the lease active; a later tick retries it.
 */

export const STALE_LEASE_GRACE_ENV = "MYRMIDON_STALE_LEASE_GRACE_MS";
export const DEFAULT_STALE_LEASE_GRACE_MS = 10 * 60 * 1000;
/** The sweep inspects at most this many leases per scheduler tick. */
export const STALE_LEASE_SWEEP_PAGE_SIZE = 50;
export const STALE_LEASE_SWEEP_FAILURE_REASON = "stale_active_lease_sweep";

const TERMINAL_RUN_STATUSES = ["succeeded", "interrupted", "failed", "cancelled", "timed_out"];

/** Grace window in milliseconds; invalid values fall back to the default. */
export function readStaleLeaseGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[STALE_LEASE_GRACE_ENV]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_STALE_LEASE_GRACE_MS;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : DEFAULT_STALE_LEASE_GRACE_MS;
}

type HeartbeatRunRow = typeof heartbeatRuns.$inferSelect;
type LeaseRow = typeof environmentLeases.$inferSelect;
type EnvironmentService = ReturnType<typeof environmentService>;
type EnvironmentRuntime = ReturnType<typeof environmentRuntimeService>;

export interface StaleActiveLeaseSweepDeps {
  db: Db;
  environments: Pick<EnvironmentService, "getLeaseById" | "releaseLease">;
  environmentRuntime: Pick<EnvironmentRuntime, "retryPendingSandboxTeardown">;
  /** True while the run still has a live process, process group or in-server execution. */
  isRunStillActive: (run: HeartbeatRunRow) => boolean;
  /** Follow-up once a lease is released (acknowledge stop, resume deferred comments). */
  afterRelease?: (lease: LeaseRow) => Promise<void>;
}

export interface StaleActiveLeaseSweepResult {
  inspected: number;
  released: number;
  skippedAlive: number;
  failed: number;
}

function needsProviderTeardown(lease: { provider: string | null }): boolean {
  // A local lease is bookkeeping only: there is no sandbox to destroy.
  return !!lease.provider && lease.provider !== "local";
}

export function createStaleActiveLeaseSweep(deps: StaleActiveLeaseSweepDeps) {
  return async function sweepStaleActiveEnvironmentLeases(opts?: {
    graceMs?: number;
    now?: Date;
  }): Promise<StaleActiveLeaseSweepResult> {
    const graceMs = opts?.graceMs ?? readStaleLeaseGraceMs();
    const now = opts?.now ?? new Date();
    const cutoff = new Date(now.getTime() - graceMs);
    const rows = await deps.db
      .select({ lease: environmentLeases, run: heartbeatRuns })
      .from(environmentLeases)
      .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, environmentLeases.heartbeatRunId))
      .where(
        and(
          eq(environmentLeases.status, "active"),
          inArray(heartbeatRuns.status, TERMINAL_RUN_STATUSES),
          isNotNull(heartbeatRuns.finishedAt),
          lte(heartbeatRuns.finishedAt, cutoff),
        ),
      )
      .orderBy(asc(environmentLeases.updatedAt))
      .limit(STALE_LEASE_SWEEP_PAGE_SIZE);

    const result: StaleActiveLeaseSweepResult = { inspected: 0, released: 0, skippedAlive: 0, failed: 0 };
    for (const { lease, run } of rows) {
      result.inspected += 1;
      // A terminal run with a live process may still be a recovery subject; its
      // own teardown path releases the lease.
      if (deps.isRunStillActive(run)) {
        result.skippedAlive += 1;
        continue;
      }
      try {
        const record = (await deps.environments.getLeaseById(lease.id)) ?? null;
        const receipt =
          record && needsProviderTeardown(record)
            ? await deps.environmentRuntime.retryPendingSandboxTeardown({ environment: null, lease: record })
            : null;
        await deps.environments.releaseLease(lease.id, "expired", {
          cleanupStatus: "success",
          failureReason: STALE_LEASE_SWEEP_FAILURE_REASON,
          remoteExecutionTermination: remoteTerminationReceipt(lease, receipt),
        });
        result.released += 1;
        logger.warn(
          { leaseId: lease.id, runId: run.id },
          "released a stale active environment lease on a terminal heartbeat run",
        );
      } catch {
        // Log a constant errorKind only: the exception can carry a credential in
        // its message, code, cause or stack. The lease stays active for a retry.
        result.failed += 1;
        logger.warn(
          { errorKind: "destroy_failed", leaseId: lease.id, runId: run.id },
          "stale active environment lease release failed",
        );
        continue;
      }
      await deps.afterRelease?.(lease).catch(() =>
        logger.warn({ leaseId: lease.id }, "could not reconsider messages after stale active lease release"),
      );
    }
    return result;
  };
}
