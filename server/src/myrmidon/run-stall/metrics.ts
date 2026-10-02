// Metric surface of run stall detection, for the health page (part E of the
// team-liveness feature). Read-only: no schema change, no new table, the count
// is a query over the runs the sweep already marks with its own error code.

import { and, count, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { RUN_STALL_ERROR_CODE } from "./constants.js";

/** Default window of the health metric: what happened in the last day. */
export const RUN_STALL_METRIC_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface RunStallCountInput {
  /** Instant the window starts at; defaults to one day before `now`. */
  since?: Date;
  /** Restricts the count to one company; omitted means the whole instance. */
  companyId?: string;
  now?: Date;
}

/**
 * How many runs the stall sweep interrupted inside the window. The health page
 * of part E reports it as-is; a nonzero value on a healthy board means runs
 * really are stalling and the sweep is doing its job, not that the server is
 * broken.
 */
export async function countRunStallInterrupts(db: Db, input: RunStallCountInput = {}): Promise<number> {
  const now = input.now ?? new Date();
  const since = input.since ?? new Date(now.getTime() - RUN_STALL_METRIC_WINDOW_MS);
  const windowStart = sql`coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.updatedAt})`;
  const [row] = await db
    .select({ total: count() })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.errorCode, RUN_STALL_ERROR_CODE),
        input.companyId ? eq(heartbeatRuns.companyId, input.companyId) : undefined,
        gte(windowStart, since.toISOString()),
      ),
    );
  return Number(row?.total ?? 0);
}