// server/src/myrmidon/agent-tool-permissions.ts
//
// myrmidon(S6): the database half of per-agent tool permissions. The permission
// model and its decision live in `@paperclipai/shared` (myrmidon-agent-tool-permissions);
// here is only the read of the agent record.
//
// The permission is stored on the agent itself, so it survives the ways a run is
// reached: a run-bound call, a bot-container gateway call and an operator call all
// resolve the same agent id and therefore the same permission.

import { agents, type Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { readAgentToolPermissions, type AgentToolPermissions } from "@paperclipai/shared";

/** The agent's tool permission; an absent or malformed value is the allow-all default. */
export async function loadAgentToolPermissions(
  db: Db,
  companyId: string,
  agentId: string,
): Promise<AgentToolPermissions> {
  const [row] = await db
    .select({ permissions: agents.permissions })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)))
    .limit(1);
  return readAgentToolPermissions(row?.permissions);
}