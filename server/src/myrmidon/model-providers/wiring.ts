// server/src/myrmidon/model-providers/wiring.ts
//
// myrmidon(1.6.1 MODEL-PROVIDERS A): binds the model-provider routes to the
// database, the secret store and the company activity log. Kept apart from
// routes.ts so the routes stay testable with plain fakes; this file is the
// only one that knows about `Db` and the secrets service.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { secretService } from "../../services/index.js";
import { logActivity } from "../../services/index.js";
import { modelProviderRoutes, type ModelProviderRoutesDeps } from "./routes.js";
import {
  createModelProviderCatalogPort,
  createModelProviderService,
  type ModelProviderActivityEntry,
} from "./service.js";

/** The activity row of one model-provider mutation (add / rotate / remove). */
export async function recordModelProviderActivity(
  db: Db,
  entry: ModelProviderActivityEntry,
): Promise<void> {
  await logActivity(db, {
    companyId: entry.companyId,
    actorType: "user",
    actorId: "board",
    action: entry.action,
    entityType: "model_provider",
    entityId: entry.providerId,
    details: entry.details,
  });
}

export function myrmidonModelProviderRoutes(db: Db): Router {
  const secrets = secretService(db);
  const deps: ModelProviderRoutesDeps = {
    service: createModelProviderService({
      db,
      secrets: {
        readSecretValue: (companyId, secretName) =>
          secrets
            .getByName(companyId, secretName)
            .then((row) => (row ? secrets.resolveSecretValue(companyId, row.id, "latest") : null)),
        findSecretId: (companyId, secretName) =>
          secrets.getByName(companyId, secretName).then((row) => row?.id ?? null),
        createSecret: async (input) => {
          const created = (await secrets.create(
            input.companyId,
            {
              name: input.name,
              key: input.name,
              value: input.value,
              description: input.description,
            } as never,
            { userId: null, agentId: null },
          )) as { id: string };
          return { id: created.id };
        },
        rotateSecret: async (secretId, value) => {
          await secrets.rotate(secretId, { value }, { userId: null, agentId: null });
        },
        deleteSecret: async (secretId) => {
          await secrets.update(secretId, { status: "deleted" });
        },
      },
      catalog: createModelProviderCatalogPort(),
    }),
    recordActivity: (entry) => recordModelProviderActivity(db, entry),
  };
  return modelProviderRoutes(deps);
}
