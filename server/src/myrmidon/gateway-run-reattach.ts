// server/src/myrmidon/gateway-run-reattach.ts
//
// myrmidon(HERMES-RUN-REATTACH): reattach live gateway runs after a board
// restart.
//
// The incident: the board was recreated without maintenance mode. Every
// in-flight hermes_gateway run kept running inside the bot's gateway (it owns
// the process, the board only talks HTTP), but the board had no in-process
// handle for it, so the orphan reaper marked each run "Process lost -- server
// may have restarted" and failed the agent. The gateway kept the runs in its
// max_concurrent_runs slots, the board believed the agent was free, sent a new
// run, and the gateway answered 429 -- which the board treated as a failure
// and put the agent into error.
//
// This sweep is the reattach half: at startup, for every still-`running` run
// of a hermes_gateway agent whose gateway run id was persisted on the row
// (externalRunId, written the moment the gateway admitted the run), claim the
// run and re-dispatch it through the ordinary execution path with
// contextSnapshot.reattachGatewayRunId set. The adapter then skips POST
// /v1/runs and attaches to the existing gateway run (GET /v1/runs/{id} first:
// live -> keep supervising, terminal -> read the result back, unknown -> fall
// back to an ordinary create with this attempt's own Idempotency-Key).
//
// Runs on the startup path before reapOrphanedRuns (see index.ts): a claimed
// reattach execution registers in activeRunExecutions, so the reaper's
// locallyTracked check skips it. A run this sweep cannot claim (no
// externalRunId, agent gone, terminal status) falls through to the reaper
// exactly as before.
//
// The 429 half of the incident lives in the heartbeat service: a gateway 429
// is a transient resource wait (errorFamily transient_upstream carrying the
// gateway's Retry-After), the agent stays idle instead of going to error, and
// the bounded retry follows the gateway's own hint.

import { and, eq, isNotNull, sql } from "drizzle-orm";
import { agents, heartbeatRuns, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { legacyControllerBootId } from "../services/legacy-controller-lease.js";

/** Context key carrying the gateway run id into the adapter dispatch. */
export const REATTACH_GATEWAY_RUN_ID_CONTEXT_KEY = "reattachGatewayRunId";

/** The narrow heartbeat surface this module uses; the full service satisfies it. */
export interface GatewayRunReattachHeartbeatPort {
  /**
   * Re-dispatch a still-running run through the ordinary execution path, with
   * the reattach marker in its context snapshot. The heartbeat service's
   * executeRun accepts `gatewayRunReattach` for exactly this.
   */
  executeRunForGatewayReattach: (
    runId: string,
    gatewayRunId: string,
  ) => Promise<void>;
}

export interface GatewayRunReattachResult {
  /** Runs inspected by this pass. */
  scanned: number;
  /** Runs claimed and re-dispatched for reattach. */
  reattached: number;
  /** Runs skipped because the row already carries a reattach marker (an
   * earlier pass claimed it; the execution may still be starting). */
  skippedAlreadyMarked: number;
  /** Claim or dispatch failures; the reaper or a later pass handles them. */
  failed: number;
  runIds: string[];
}

/**
 * One pass: query and claim live here, dispatch is injected, so the claim
 * logic stays testable. Not only for startup -- periodic ticks may reuse it,
 * which is why the claim is an idempotent compare-and-set on the marker.
 */
export async function sweepGatewayRunReattach(
  db: Db,
  heartbeat: GatewayRunReattachHeartbeatPort,
): Promise<GatewayRunReattachResult> {
  const candidates = await db
    .select({
      id: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      externalRunId: heartbeatRuns.externalRunId,
    })
    .from(heartbeatRuns)
    .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
    .where(
      and(
        eq(heartbeatRuns.status, "running"),
        eq(heartbeatRuns.runtimeMode, "legacy"),
        eq(agents.adapterType, "hermes_gateway"),
        isNotNull(heartbeatRuns.externalRunId),
      ),
    );

  const result: GatewayRunReattachResult = {
    scanned: candidates.length,
    reattached: 0,
    skippedAlreadyMarked: 0,
    failed: 0,
    runIds: [],
  };

  for (const candidate of candidates) {
    try {
      // Atomically mark the run for reattach and claim the legacy controller
      // lease in one UPDATE: only a row that is still running, still carries
      // the gateway run id, and has no reattach marker yet wins. The lease
      // claim mirrors legacyControllerClaim (same boot id, a fresh 60s lease,
      // a distinct execution stage) so the reaper's hasLiveLegacyController
      // check sees a live controller while the execution spins up.
      const [claimed] = await db
        .update(heartbeatRuns)
        .set({
          contextSnapshot: sql`(
            coalesce(
              case when jsonb_typeof(${heartbeatRuns.contextSnapshot}) = 'object'
                then ${heartbeatRuns.contextSnapshot} else '{}'::jsonb end,
              '{}'::jsonb
            )
          ) || jsonb_build_object(${REATTACH_GATEWAY_RUN_ID_CONTEXT_KEY}::text, ${candidate.externalRunId}::text)`,
          controllerBootId: legacyControllerBootId,
          controllerLeaseExpiresAt: sql`clock_timestamp() + interval '60 seconds'`,
          executionStage: "reattaching",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(heartbeatRuns.id, candidate.id),
            eq(heartbeatRuns.companyId, candidate.companyId),
            eq(heartbeatRuns.status, "running"),
            isNotNull(heartbeatRuns.externalRunId),
            sql`coalesce((${heartbeatRuns.contextSnapshot} ->> ${REATTACH_GATEWAY_RUN_ID_CONTEXT_KEY}), '') = ''`,
          ),
        )
        .returning({ id: heartbeatRuns.id });
      if (!claimed) {
        result.skippedAlreadyMarked += 1;
        continue;
      }
      await heartbeat.executeRunForGatewayReattach(
        candidate.id,
        candidate.externalRunId!,
      );
      result.reattached += 1;
      result.runIds.push(candidate.id);
    } catch (err) {
      result.failed += 1;
      logger.error(
        { err, runId: candidate.id, externalRunId: candidate.externalRunId },
        "gateway run reattach dispatch failed; the orphan reaper will finalize the run if it stays unclaimed",
      );
    }
  }

  if (result.reattached > 0) {
    logger.info(
      { ...result },
      "gateway run reattach: redispatched running gateway runs after restart",
    );
  }
  return result;
}
