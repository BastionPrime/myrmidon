// server/src/myrmidon/agent-memory/index.ts
//
// myrmidon(MEMORY-UI): real wiring of the memory routes for app.ts — the
// agent row from the database and the vendor authz asserters, the same shape
// the bot-container routes use (routes-wiring.ts).

import { eq } from "drizzle-orm";
import { agents, type Db } from "@paperclipai/db";
import { assertBoard, hasCompanyAccess } from "../../routes/authz.js";
import { agentMemoryRoutes } from "./routes.js";
import { defaultAgentMemoryDeps } from "./service.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function myrmidonAgentMemoryRoutes(db: Db, env: NodeJS.ProcessEnv = process.env) {
  return agentMemoryRoutes({
    deps: defaultAgentMemoryDeps(db, env),
    async getAgent(id) {
      // A malformed id is "no such agent", not a database error.
      if (!UUID_PATTERN.test(id)) return null;
      const row = await db
        .select({ id: agents.id, companyId: agents.companyId })
        .from(agents)
        .where(eq(agents.id, id))
        .then((rows) => rows[0] ?? null);
      return row;
    },
    hasCompanyAccess: (req, companyId) => hasCompanyAccess(req, companyId),
    assertBoard: (req) => assertBoard(req),
  });
}
