// server/src/myrmidon/foraging/index.ts
//
// myrmidon(1.6-FORAGE): entry point of FORAGING.
//
// Wires the store, the reader and the candidate port to the database and hands
// app.ts a router. The candidate port is the seam with SKILL-LIFECYCLE: while
// that module is not merged the port is absent and findings stay `unverified`;
// once it lands, `foragingCandidatePort` below is the single place to connect it,
// so no other file of this feature changes.

import type { Db } from "@paperclipai/db";
import { secretService } from "../../services/index.js";
import { logger } from "../../middleware/logger.js";
import { nullForagingCandidatePort, type ForagingCandidatePort } from "./domain.js";
import { createForagingReader } from "./reader.js";
import { readForagingSettings } from "./settings.js";
import { createForagingService, type ForagingService } from "./service.js";
import { createDbForagingStore, type ForagingStore } from "./store.js";
import { foragingRoutes } from "./routes.js";

export {
  FORAGING_BUDGET_CENTS_ENV,
  FORAGING_INTERVAL_SEC_ENV,
  FORAGING_KEY_SECRET_ENV,
  diffSnapshots,
  normalizeSnapshot,
  estimateCostCents,
  decideForagingBudget,
  skillKeyForRole,
  nullForagingCandidatePort,
} from "./domain.js";
export type { ForagingCandidatePort, ForagingSweepResult, ForagingSourceRef } from "./domain.js";
export { readForagingSettings, FORAGING_ENABLED_ENV } from "./settings.js";
export { createForagingService } from "./service.js";
export { createDbForagingStore } from "./store.js";
export { createForagingReader } from "./reader.js";

/**
 * The candidate port of the running instance.
 *
 * SKILL-LIFECYCLE is a separate feature (its own tables and service). Until its
 * service is available in this deployment the port stays absent: a finding is
 * recorded `unverified` and nothing else happens. The wiring is one call site,
 * so connecting the lifecycle later does not touch the sweep.
 */
export function foragingCandidatePort(): ForagingCandidatePort {
  return nullForagingCandidatePort;
}

export interface ForagingWiring {
  store: ForagingStore;
  service: ForagingService;
  env: NodeJS.ProcessEnv;
}

/** The store, the reader and the service bound to the database. */
export function foragingWiring(db: Db, env: NodeJS.ProcessEnv = process.env): ForagingWiring {
  const settings = readForagingSettings(env);
  const store = createDbForagingStore(db);
  const secrets = secretService(db);
  const service = createForagingService({
    store,
    reader: createForagingReader({
      env,
      minHostIntervalMs: settings.minHostIntervalMs,
      readKey: async (companyId, secretName) => {
        if (!secretName) return null;
        const row = await secrets.getByName(companyId, secretName);
        if (!row) return null;
        return secrets.resolveSecretValue(companyId, row.id, "latest");
      },
    }),
    candidatePort: foragingCandidatePort(),
    settings: { budget: settings.budget },
    log: logger,
  });
  return { store, service, env };
}

/** Router for app.ts. */
export function myrmidonForagingRoutes(db: Db, env: NodeJS.ProcessEnv = process.env) {
  const wiring = foragingWiring(db, env);
  return foragingRoutes({
    db,
    store: wiring.store,
    service: wiring.service,
    env: wiring.env,
  });
}