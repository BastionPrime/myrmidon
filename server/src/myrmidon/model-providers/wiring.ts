// server/src/myrmidon/model-providers/wiring.ts
//
// myrmidon(1.6.1 MODEL-PROVIDERS A+B): binds the model-provider routes to the
// database, the secret store and the company activity log. Kept apart from
// routes.ts so the routes stay testable with plain fakes; this file is the
// only one that knows about `Db` and the secrets service.
// Also integrates with LiteLLM synchronization (part B).

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
import { modelProviderRoutesWithSync, type ModelProviderRoutesWithSyncDeps } from "./routes-with-sync.js";
import { createLitellmSyncService } from "../litellm-sync/service.js";
import { createLitellmSyncClient } from "../litellm-sync/client.js";
import { defaultAgentGatewayKeyDeps } from "../litellm-keys/agent-keys.js";

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

export function myrmidonModelProviderRoutes(db: Db, env: NodeJS.ProcessEnv = process.env): Router {
  const secrets = secretService(db);
  
  // Create the basic model provider service
  const modelProviderService = createModelProviderService({
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
  });
  
  // Create the LiteLLM sync client
  const litellmBaseUrl = env.MYRMIDON_LITELLM_BASE_URL || "http://localhost:4000";
  const litellmAdminKey = env.MYRMIDON_LITELLM_ADMIN_KEY_SECRET || "";
  
  if (!litellmAdminKey) {
    console.warn("MYRMIDON_LITELLM_ADMIN_KEY_SECRET not set, LiteLLM sync will not work");
  }
  
  const litellmClient = createLitellmSyncClient({
    litellmBaseUrl,
    litellmAdminKey,
  });

  // Create the agent gateway key dependencies
  const agentGatewayKeys = defaultAgentGatewayKeyDeps(db, env);

  // Create the LiteLLM sync service
  const litellmSyncServiceDeps = {
    db,
    litellm: litellmClient,
  };
  const litellmSyncService = createLitellmSyncService(litellmSyncServiceDeps);

  // Create the combined route dependencies
  const deps: ModelProviderRoutesWithSyncDeps = {
    service: modelProviderService,
    litellmSyncService,
    recordActivity: (entry) => recordModelProviderActivity(db, entry),
  };
  
  return modelProviderRoutesWithSync(deps);
}

/**
 * Initializes the model provider system at startup, including LiteLLM reconciliation.
 */
export async function initializeModelProvidersAtStartup(db: Db, env: NodeJS.ProcessEnv = process.env) {
  // Initialize LiteLLM sync at startup - this reconciles the database state with LiteLLM
  const litellmBaseUrl = env.MYRMIDON_LITELLM_BASE_URL || "http://localhost:4000";
  const litellmAdminKey = env.MYRMIDON_LITELLM_ADMIN_KEY_SECRET || "";
  
  if (!litellmAdminKey) {
    console.warn("MYRMIDON_LITELLM_ADMIN_KEY_SECRET not set, skipping LiteLLM startup reconciliation");
    return;
  }
  
  // Create the LiteLLM sync client for startup initialization
  const litellmClient = createLitellmSyncClient({
    litellmBaseUrl,
    litellmAdminKey,
  });

  // Create the LiteLLM sync service dependencies for startup
  const litellmSyncServiceDeps = {
    db,
    litellm: litellmClient,
  };

  // Perform startup reconciliation
  const service = createLitellmSyncService(litellmSyncServiceDeps);
  await service.reconcileWithLitellm();
}
