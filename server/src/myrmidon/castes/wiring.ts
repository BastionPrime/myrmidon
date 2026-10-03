// server/src/myrmidon/castes/wiring.ts
//
// myrmidon(1.6.1 CUSTOM-CASTES A): binds the caste routes to the database and
// the company activity log. Kept apart from routes.ts so the routes stay
// testable with plain fakes; this file is the only one that knows about `Db`.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { logActivity } from "../../services/index.js";
import { casteRoutes, type CasteRoutesDeps } from "./routes.js";
import { createCasteService, type CasteActivityEntry } from "./service.js";
import { createCasteStore } from "./store.js";

/** The activity row of one caste mutation (create / update / remove). */
export async function recordCasteActivity(db: Db, entry: CasteActivityEntry): Promise<void> {
  await logActivity(db, {
    companyId: entry.companyId,
    actorType: "user",
    actorId: "board",
    action: entry.action,
    entityType: "caste",
    entityId: entry.casteKey,
    details: entry.details,
  });
}

export function myrmidonCasteRoutes(db: Db): Router {
  const store = createCasteStore({ db });
  const deps: CasteRoutesDeps = {
    service: createCasteService({ db, store }),
    recordActivity: (entry) => recordCasteActivity(db, entry),
  };
  return casteRoutes(deps);
}
