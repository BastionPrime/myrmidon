// myrmidon(X8c): /stop cancels this conversation's own in-flight runs, the
// same way the board's own cancel route does (server/src/routes/agents.ts:6694-6706),
// stamped so recovery reads it as owner-requested and does not re-wake the
// agent it was just told to stop.

import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { logger } from "../../../middleware/logger.js";

const MAX_STOPPED_RUNS = 5;

export interface StopBridgedChatRunsInput {
  db: Db;
  companyId: string;
  agentId: string;
  issueId: string;
  boardUserId: string;
  cancelRun: (
    runId: string,
    reason: string,
    options: { errorCode?: string; resultJson?: Record<string, unknown> },
  ) => Promise<unknown>;
}

export interface StopBridgedChatRunsResult {
  stopped: number;
  /** A cancel attempt failed; the caller should report stopping as unavailable, not crash the command. */
  failed: boolean;
}

export async function stopBridgedChatRuns(
  input: StopBridgedChatRunsInput,
): Promise<StopBridgedChatRunsResult> {
  const runs = await input.db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
        inArray(heartbeatRuns.status, ["queued", "running"]),
        sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${input.issueId}`,
      ),
    )
    .limit(MAX_STOPPED_RUNS);

  let stopped = 0;
  for (const run of runs) {
    try {
      await input.cancelRun(run.id, "Stopped from chat by the conversation owner", {
        errorCode: "chat_session_stopped",
        resultJson: {
          cancelledByActorType: "user",
          cancelledByUserId: input.boardUserId,
        },
      });
      stopped += 1;
    } catch (err) {
      logger.warn(
        { err, runId: run.id, issueId: input.issueId },
        "myrmidon(X8c): /stop failed to cancel a run",
      );
      return { stopped, failed: true };
    }
  }
  return { stopped, failed: false };
}
