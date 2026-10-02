// myrmidon(SEC1-C): rotation → restart wiring for the Access section.
//
// After an ssh key (or any access-hub typed secret) rotates, the agents with
// a binding on that secret must pick up the new value in their containers.
// The board already owns the whole restart path: the bot-container profile
// compiler resolves secret bindings into the container env, and the
// reconciler restarts the container through a maintenance window whenever
// the compiled profile changed (restart-hash). Part C only needs to NAME the
// agents that hold a binding on the secret — `applyBotContainerNow` does the
// drain/restart inside the window, and it is a no-op for agents that are not
// container bots. Nothing here invents a second restart mechanism.
//
// The lookup reads the existing `company_secret_bindings` table through the
// access-hub queries (the same source grant/revoke writes).

import { applyBotContainerNow } from "../bot-containers/index.js";
import { getBotContainerRuntime } from "../bot-containers/routes-wiring.js";
import { agents, companySecretBindings, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";

/** The interface the routes call after a rotation; the routes tests inject a
 * fake. `applyNow` is deliberately not imported at module level in this file:
 * the routes tests must be able to run without the bot-containers runtime. */
export interface RotationRestartDeps {
  /** The agent rows applyBotContainerNow needs (id, companyId, adapterType,
   * adapterConfig); the caller queries them. */
  applyNow(agent: BotRestartAgent): Promise<{ kind: string }>;
}

export interface BotRestartAgent {
  agentId: string;
  companyId: string;
  adapterType: string;
  adapterConfig: Record<string, unknown> | null;
}

/** Agents with an active binding on the secret (targetType "agent"). */
export async function listAgentsBoundToSecret(db: Db, secretId: string): Promise<string[]> {
  const rows = await db
    .select({ targetId: companySecretBindings.targetId })
    .from(companySecretBindings)
    .where(eq(companySecretBindings.secretId, secretId));
  const ids: string[] = [];
  for (const row of rows) {
    if (row.targetId && !ids.includes(row.targetId)) ids.push(row.targetId);
  }
  return ids;
}

/** The agent rows the runtime needs for every bound agent id. */
export async function loadBoundAgentRows(db: Db, agentIds: string[]): Promise<BotRestartAgent[]> {
  if (agentIds.length === 0) return [];
  const rows = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      adapterType: agents.adapterType,
      adapterConfig: agents.adapterConfig,
    })
    .from(agents);
  const wanted = new Set(agentIds);
  return rows
    .filter((row) => wanted.has(row.id))
    .map((row) => ({
      agentId: row.id,
      companyId: row.companyId,
      adapterType: row.adapterType,
      // The raw JSON column comes back as a parsed record.
      adapterConfig: (row.adapterConfig ?? null) as Record<string, unknown> | null,
    }));
}

export interface RotationRestartOutcome {
  agentId: string;
  kind: string;
}

/** Fire the board's own apply path for every agent bound to the secret.
 * Errors of one agent never stop the others; the outcome kind carries the
 * reconcile result ("applied_restart", "unchanged", "not_applicable", ...). */
export async function restartBoundContainers(
  db: Db,
  secretId: string,
  runtime: { applyNow: (agent: BotRestartAgent) => Promise<{ kind: string }> },
): Promise<RotationRestartOutcome[]> {
  const agentIds = await listAgentsBoundToSecret(db, secretId);
  const rows = await loadBoundAgentRows(db, agentIds);
  const outcomes: RotationRestartOutcome[] = [];
  for (const agent of rows) {
    try {
      const result = await runtime.applyNow(agent);
      outcomes.push({ agentId: agent.agentId, kind: result.kind });
    } catch {
      // reconcileBot never throws, but the row load or the lock can; a failed
      // apply must not fail the rotation itself.
      outcomes.push({ agentId: agent.agentId, kind: "error" });
    }
  }
  return outcomes;
}

/** Build the real runtime adapter the routes use in production. */
export function rotationRestartRuntime(
  env: NodeJS.ProcessEnv = process.env,
): { applyNow: (agent: BotRestartAgent) => Promise<{ kind: string }> } {
  return {
    applyNow: async (agent) => {
      // The startup wiring registered the single runtime the sweep and the
      // "Apply now" button share; a server without bot containers (flag off,
      // no scheduler) has none, and the rotation reports not_applicable.
      const runtime = getBotContainerRuntime();
      if (!runtime) {
        return { kind: "not_applicable" };
      }
      const outcome = await applyBotContainerNow(
        {
          agentId: agent.agentId,
          adapterType: agent.adapterType,
          adapterConfig: agent.adapterConfig ?? {},
        },
        runtime,
        { env },
      );
      return { kind: outcome.kind };
    },
  };
}
