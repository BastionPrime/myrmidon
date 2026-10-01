// myrmidon(SC1): wiring for the fleet-console routes.
//
// The real dependencies are the Drizzle registry store, the panel audit log as
// the session journal, and the panel secret store for the two values the console
// needs: the shared Guacamole `json-secret-key` and the node password named by a
// registry row. Neither value leaves the server. A secret that is missing or
// cannot be resolved reads as `null`, and the service turns that into a 503
// instead of issuing a token the Guacamole client would reject.

import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { secretService } from "../../services/secrets.js";
import { activityConsoleJournal } from "./journal.js";
import { fleetConsoleRoutes } from "./routes.js";
import { FLEET_CONSOLE_SECRET_KEY_NAME, readFleetConsoleSettings } from "./settings.js";
import { consoleService } from "./service.js";
import { fleetServerStore } from "./store.js";

export function myrmidonFleetConsoleRoutes(db: Db) {
  const secrets = secretService(db);

  async function readSecret(companyId: string, key: string): Promise<string | null> {
    try {
      const secret = await secrets.getByKey(companyId, key);
      if (!secret) return null;
      return await secrets.resolveSecretValue(companyId, secret.id, "latest");
    } catch (err) {
      logger.warn({ err, companyId, secretKey: key }, "console secret could not be resolved");
      return null;
    }
  }

  const service = consoleService({
    store: fleetServerStore(db),
    journal: activityConsoleJournal(db),
    settings: readFleetConsoleSettings(),
    readSecretKey: (companyId) => readSecret(companyId, FLEET_CONSOLE_SECRET_KEY_NAME),
    readNodePassword: (companyId, key) => readSecret(companyId, key),
  });

  return fleetConsoleRoutes({ service });
}