// server/src/myrmidon/litellm-sync/startup-reconciler.ts
//
// myrmidon(1.6.1 MODEL-PROVIDERS B): startup reconciliation.
//
// Reconciles the LiteLLM model registry with the database state at server startup.
// Ensures that all enabled models in the database are registered in LiteLLM and
// all models registered in LiteLLM that are not enabled in the database are unregistered.

import type { Db } from "@paperclipai/db";
import { createLitellmSyncService } from "./service.js";
import { createLitellmSyncClient } from "./client.js";

/**
 * Starts the LiteLLM model reconciliation at server startup.
 * This ensures that the models registered in LiteLLM match the enabled models in the database.
 */
export async function startLitellmModelReconciliation(db: Db) {
  // Create the LiteLLM client with default configuration
  const litellmClient = createLitellmSyncClient({
    litellmBaseUrl: process.env.LITELLM_PROXY_URL ?? "http://localhost:4000",
    litellmAdminKey: process.env.LITELLM_ADMIN_KEY ?? "",
  });

  const litellmSyncService = createLitellmSyncService({
    db,
    litellm: litellmClient,
  });

  try {
    await litellmSyncService.reconcileWithLitellm();
    console.log("LiteLLM model reconciliation completed at startup");
  } catch (error) {
    console.error("LiteLLM model reconciliation failed at startup:", error);
  }
}