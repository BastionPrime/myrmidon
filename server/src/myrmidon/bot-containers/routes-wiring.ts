// server/src/myrmidon/bot-containers/routes-wiring.ts
//
// myrmidon(W2b): real wiring of routes.ts (database lookup, permission check) and
// the registry the container runtime is plugged into.
//
// The runtime (driver, profile compiler, maintenance port, network) is not built
// here: compiling a profile needs the agent's resolved env, secrets and skills,
// and that belongs to the startup wiring (startup.ts, W2a), which calls
// setBotContainerRuntime once at startup, with the same runtime the periodic
// sweep uses. Until then (flag off, no scheduler in this process, or a runtime
// that could not be built) the routes answer "runtime not configured" instead
// of guessing.

import { eq } from "drizzle-orm";
import { agents, type Db } from "@paperclipai/db";
import { forbidden } from "../../errors.js";
import { accessService } from "../../services/index.js";
import { authorizationDeniedDetails } from "../../services/authorization.js";
import { applyBotContainerNow, type BotContainerRuntimeDeps } from "./index.js";
import { botContainerRoutes } from "./routes.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let registeredRuntime: BotContainerRuntimeDeps | null = null;

export function setBotContainerRuntime(runtime: BotContainerRuntimeDeps | null): void {
  registeredRuntime = runtime;
}

export function getBotContainerRuntime(): BotContainerRuntimeDeps | null {
  return registeredRuntime;
}

/** Router for app.ts: the agent card's container status and "Apply now". */
export function myrmidonBotContainerRoutes(db: Db) {
  // Built on first use: app.ts is constructed in tests that stub parts of services/.
  let access: ReturnType<typeof accessService> | null = null;
  return botContainerRoutes({
    getAgent: async (id) => {
      // A malformed id is "no such agent", not a database error.
      if (!UUID_PATTERN.test(id)) return null;
      const row = await db
        .select({
          id: agents.id,
          companyId: agents.companyId,
          adapterType: agents.adapterType,
          adapterConfig: agents.adapterConfig,
        })
        .from(agents)
        .where(eq(agents.id, id))
        .then((rows) => rows[0] ?? null);
      return row;
    },
    assertCanUpdateAgent: async (req, agent) => {
      access ??= accessService(db);
      const decision = await access.decide({
        actor: req.actor,
        action: "agent_config:update",
        resource: { type: "agent", companyId: agent.companyId, agentId: agent.id },
      });
      if (!decision.allowed) throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
    },
    getRuntime: getBotContainerRuntime,
    applyNow: applyBotContainerNow,
  });
}
