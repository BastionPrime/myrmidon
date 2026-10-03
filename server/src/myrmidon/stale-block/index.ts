// myrmidon(STALE-BLOCK): entry point — one import, one call site in the
// server entry (CONVENTIONS.md §12), no separate scheduler loop of its own.

import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { isInstanceUnderMaintenance } from "../maintenance/gate.js";
import { createStaleBlockSweep, type StaleBlockSweep } from "./sweep.js";

export { createStaleBlockSweep, type StaleBlockSweep, type StaleBlockSweepResult } from "./sweep.js";
export {
  judgeStaleBlockReason,
  collectStaleBlockReasons,
  describeStaleBlockReason,
  type StaleBlockReason,
} from "./policy.js";
export { readReasonRef, type StaleBlockReasonRef } from "./reason.js";
export {
  readStaleBlockEnabled,
  readStaleBlockSettings,
  STALE_BLOCK_ENABLED_ENV,
  STALE_BLOCK_INTERVAL_SEC_ENV,
  type StaleBlockSettings,
} from "./settings.js";
export {
  readStaleBlockSignals,
  recordStaleBlockSignal,
  resetStaleBlockSignals,
  staleBlockSignalDedupKey,
  staleBlockSignalWhyNow,
  type StaleBlockSignal,
  DEFAULT_STALE_BLOCK_SIGNAL_TTL_MS,
  STALE_BLOCK_SIGNAL_TTL_ENV,
} from "./attention.js";

/**
 * Builds the stale-block pass the scheduler tick calls. The event/gate
 * liveness seam is injected; the default reads nothing (events are only
 * declared dead by an explicit `false` from the wiring, so an unwired gate
 * key never silently unblocks a task).
 */
export function createStaleBlockScheduler(input: {
  db: Db;
  track: (work: Promise<unknown>) => void;
  isEventStillSet?: (companyId: string, eventKey: string) => Promise<boolean>;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}): () => void {
  const sweep = createStaleBlockSweep({
    db: input.db,
    isEventStillSet: input.isEventStillSet ?? (async () => true),
    isUnderMaintenance: isInstanceUnderMaintenance,
    logActivity: async (entry) => {
      // Loaded lazily with the service layer, for the same partial-mock
      // startup-graph reason as the issue service import.
      const { logActivity } = await import("../../services/activity-log.js");
      await logActivity(input.db, entry);
    },
    env: input.env,
    now: input.now,
  });
  return () => {
    input.track(
      sweep
        .sweep()
        .then((result) => {
          if (result.unblocked > 0) {
            logger.info(result, "stale block sweep removed dead blocks");
          }
        })
        .catch((err) => {
          logger.error({ err }, "stale block sweep failed");
        }),
    );
  };
}
