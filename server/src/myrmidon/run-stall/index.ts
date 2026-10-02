// Run stall detection wiring: turns the pure sweep into the pass the scheduler
// calls, binding it to the heartbeat service, the issue service, the activity
// log and the maintenance gate. Every side effect the sweep performs enters
// here, so the rules above stay testable and each vendor file keeps a single
// call site (CONVENTIONS.md §8).

import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { logActivity } from "../../services/activity-log.js";
import { isRunUnderMaintenance } from "../maintenance/gate.js";
import {
  RUN_STALL_ERROR_CODE,
  RUN_STALL_INTERRUPT_REASON,
  RUN_STALL_WAKE_IDEMPOTENCY_PREFIX,
  RUN_STALL_WAKE_REASON,
} from "./constants.js";
import { createRunStallSweep, type RunStallSweep } from "./sweep.js";

/** The narrow heartbeat surface this module uses; the full service satisfies it. */
export interface RunStallHeartbeatPort {
  cancelRun: (
    runId: string,
    reason?: string,
    options?: {
      errorCode?: string;
      resultJson?: Record<string, unknown>;
      eventMessage?: string;
      suppressImmediateRecovery?: boolean;
    },
  ) => Promise<unknown>;
  wakeup: (
    agentId: string,
    options: {
      source?: "timer" | "assignment" | "on_demand" | "automation";
      triggerDetail?: "manual" | "ping" | "callback" | "system";
      reason?: string;
      payload?: Record<string, unknown>;
      contextSnapshot?: Record<string, unknown>;
      idempotencyKey?: string | null;
      requestedByActorType?: "user" | "agent" | "system";
      requestedByActorId?: string;
    },
  ) => Promise<unknown>;
}

/** The narrow issue-service surface this module uses. */
export interface RunStallIssuePort {
  updateForCompany: (
    id: string,
    companyId: string,
    data: { status?: string; executionState?: null },
  ) => Promise<unknown>;
}

export interface CreateRunStallSweepInput {
  db: Db;
  heartbeat: RunStallHeartbeatPort;
  issues: RunStallIssuePort;
  isRunUnderMaintenance?: (runId: string) => Promise<boolean>;
  env?: NodeJS.ProcessEnv;
}

/**
 * Builds the run-stall pass.
 *
 * The interrupt reuses the maintenance chain: a bounded cancel with its own
 * error code, and `suppressImmediateRecovery` because this sweep itself
 * re-opens the task and wakes the assignee. The code is exempted from the
 * vendor's reconciliation hold the same way the maintenance code is, so the run
 * is treated as resumable and never settled as a replay-blocked failure.
 */
export function createRunStallSweepFromHeartbeat(input: CreateRunStallSweepInput): RunStallSweep {
  return createRunStallSweep({
    db: input.db,
    interruptRun: async ({ runId, issueId, silenceMs }) => {
      await input.heartbeat.cancelRun(runId, RUN_STALL_INTERRUPT_REASON, {
        errorCode: RUN_STALL_ERROR_CODE,
        resultJson: {
          myrmidonRunStall: {
            silenceMs,
            issueId,
          },
        },
        eventMessage: "run interrupted: no recorded progress within the stall threshold",
        // The task is re-opened by this sweep and the assignee is woken right
        // after, so the release path must not fire its own escalation on top.
        suppressImmediateRecovery: true,
      });
    },
    returnIssueToTodo: async ({ issueId, companyId }) => {
      await input.issues.updateForCompany(issueId, companyId, { status: "todo", executionState: null });
      return true;
    },
    wakeAssignee: async ({ agentId, issueId, runId, identifier }) => {
      const wake = await input.heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: RUN_STALL_WAKE_REASON,
        payload: { issueId },
        contextSnapshot: {
          issueId,
          taskKey: issueId,
          source: RUN_STALL_WAKE_IDEMPOTENCY_PREFIX,
          stalledRunId: runId,
        },
        idempotencyKey: `${RUN_STALL_WAKE_IDEMPOTENCY_PREFIX}:${runId}`,
        requestedByActorType: "system",
        requestedByActorId: RUN_STALL_WAKE_IDEMPOTENCY_PREFIX,
      });
      if (!wake) {
        // The admission path refused (pause, limits, coalescing): that is a
        // decision, not an error. The task stays `todo` and the normal wake path
        // picks it up, so this pass reports "not woken" and moves on.
        logger.info({ agentId, issueId, identifier, runId }, "run stall wake was not admitted");
        return false;
      }
      return true;
    },
    isRunUnderMaintenance: input.isRunUnderMaintenance ?? ((runId) => isRunUnderMaintenance(input.db, runId)),
    logActivity: async (entry) => {
      await logActivity(input.db, {
        companyId: entry.companyId,
        actorType: entry.actorType,
        actorId: entry.actorId,
        agentId: entry.agentId,
        runId: entry.runId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        details: entry.details,
      });
    },
    env: input.env,
  });
}

export { createRunStallSweep, type RunStallSweep, type RunStallSweepResult } from "./sweep.js";
export { countRunStallInterrupts, RUN_STALL_METRIC_WINDOW_MS } from "./metrics.js";
export { RUN_STALL_ERROR_CODE, RUN_STALL_WAKE_REASON } from "./constants.js";
export { classifyRunStall, progressAnchorAt, progressSilenceMs, shouldReturnIssueToTodo } from "./policy.js";
export { readRunStallSettings, readRunStallEnabled } from "./settings.js";