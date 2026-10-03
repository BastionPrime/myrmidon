// Parallel helpers (myrmidon PARALLEL-HELPERS) entry point.
//
// No startup apply and no live object: the profile compiler re-reads the
// settings row on every reconcile tick (profile-ports.ts parallelHelpers), so
// a ceiling change reaches every bot's config.yaml within one tick. The only
// thing wired here is the routes plus the agents walk the capacity hint needs
// (agents are company-scoped; the settings are instance-level, so the walk
// crosses companies the same way the runtime-limits audit does).

import { agents as agentsTable, type Db } from "@paperclipai/db";
import { parallelHelpersRoutes } from "./routes.js";
import { parallelHelpersService, type ParallelHelpersService } from "./service.js";

export { parallelHelpersService, PARALLEL_HELPERS_ACTION } from "./service.js";
export type { ParallelHelpersService } from "./service.js";

/** Router for app.ts: GET/PATCH /api/myrmidon/parallel-helpers. */
export function myrmidonParallelHelpersRoutes(db: Db) {
  const service: ParallelHelpersService = parallelHelpersService(db, {
    // Read-only walk over every company's agents: the capacity hint is a sum
    // over all bot cards on this instance. adapterConfig on the row is the
    // raw card, the same shape profile-ports.loadAgent hands the compiler.
    listCards: async () =>
      db
        .select({ id: agentsTable.id, name: agentsTable.name, adapterConfig: agentsTable.adapterConfig })
        .from(agentsTable)
        .then((rows) =>
          rows.map((row) => ({
            id: row.id,
            name: row.name,
            adapterConfig:
              typeof row.adapterConfig === "object" && row.adapterConfig !== null && !Array.isArray(row.adapterConfig)
                ? (row.adapterConfig as Record<string, unknown>)
                : {},
          })),
        ),
  });
  return parallelHelpersRoutes(db, service);
}
