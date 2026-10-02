// server/src/myrmidon/wiki-cortex/wiring.ts
//
// myrmidon(1.6-WIKI): binds the regulation routes to the database and the
// company activity log. Kept apart from routes.ts so the routes stay testable
// with plain fakes and this file is the only one that knows about `Db`.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { logActivity } from "../../services/index.js";
import { wikiRegulationRoutes, type WikiRegulationActivityEntry } from "./routes.js";
import { createWikiRegulationService } from "./service.js";
import { createDbRegulationStore } from "./store.js";

/** The activity row of one wiki mutation. */
export async function recordWikiRegulationActivity(db: Db, entry: WikiRegulationActivityEntry): Promise<void> {
  const { actor } = entry;
  const actorType = actor.agentId ? "agent" : actor.userId ? "user" : "system";
  await logActivity(db, {
    companyId: entry.companyId,
    actorType,
    actorId: actor.agentId ?? actor.userId ?? "system",
    agentId: actor.agentId ?? null,
    runId: null,
    action: entry.action,
    entityType: "myrmidon_wiki_regulation",
    entityId: entry.slug,
    details: entry.details,
  });
}

export function myrmidonWikiCortexRoutes(db: Db): Router {
  const service = createWikiRegulationService(createDbRegulationStore(db));
  return wikiRegulationRoutes({
    service,
    recordActivity: (entry) => recordWikiRegulationActivity(db, entry),
  });
}