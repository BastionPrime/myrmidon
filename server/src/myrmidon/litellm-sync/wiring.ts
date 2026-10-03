// server/src/myrmidon/litellm-sync/wiring.ts
//
// myrmidon(1.6.1 MODEL-PROVIDERS B): wiring for LiteLLM synchronization.
//
// Connects the model provider service with the LiteLLM synchronization service.
// Hooks into model enable/disable events to trigger sync operations.
// Integrates with the application startup to perform initial reconciliation.

import { type Db } from "@paperclipai/db";
import { 
  createLitellmSyncService, 
  type LitellmSyncServiceDeps 
} from "./service.js";
import { 
  createLitellmSyncClient,
  type LitellmSyncClientDeps 
} from "./client.js";
import { 
  defaultAgentGatewayKeyDeps 
} from "../litellm-keys/agent-keys.js";
import { 
  updateAgentAllowlistsForCompany 
} from "./agent-allowlist-handler.js";
import { reconcileLitellmRegistryAtStartup } from "./startup-reconciler.js";

export interface LitellmSyncWiringDeps {
  db: Db;
  litellmBaseUrl: string;
  litellmAdminKey: string;
}

/**
 * Creates and wires the LiteLLM synchronization service with the model provider service.
 */
export function wireLitellmSync(deps: LitellmSyncWiringDeps) {
  // Create the LiteLLM client
  const litellmClientDeps: LitellmSyncClientDeps = {
    litellmBaseUrl: deps.litellmBaseUrl,
    litellmAdminKey: deps.litellmAdminKey,
  };
  
  const litellmClient = createLitellmSyncClient(litellmClientDeps);
  
  // Create the agent gateway key dependencies
  const agentGatewayKeys = defaultAgentGatewayKeyDeps(deps.db);
  
  // Create the service dependencies
  const serviceDeps: LitellmSyncServiceDeps = {
    db: deps.db,
    litellm: litellmClient,
  };
  
  // Create the sync service with event handlers
  const syncService = createLitellmSyncService(serviceDeps, {
    async onModelRegistered(litellmModelName: string) {
      console.log(`Model registered in LiteLLM: ${litellmModelName}`);
      // Optionally trigger updates to agent allowlists when models are registered
    },
    
    async onModelUnregistered(litellmModelName: string) {
      console.log(`Model unregistered from LiteLLM: ${litellmModelName}`);
      // Optionally trigger updates to agent allowlists when models are unregistered
    },
  });
  
  return {
    syncService,
    updateAgentAllowlistsForCompany: (companyId: string) => 
      updateAgentAllowlistsForCompany(deps.db, agentGatewayKeys, companyId),
  };
}

/**
 * Performs startup initialization for LiteLLM synchronization.
 */
export async function initializeLitellmSyncAtStartup(deps: LitellmSyncWiringDeps) {
  // Create dependencies for the startup reconciler
  const litellmClientDeps: LitellmSyncClientDeps = {
    litellmBaseUrl: deps.litellmBaseUrl,
    litellmAdminKey: deps.litellmAdminKey,
  };
  
  const litellmClient = createLitellmSyncClient(litellmClientDeps);
  
  const serviceDeps: LitellmSyncServiceDeps = {
    db: deps.db,
    litellm: litellmClient,
  };
  
  await reconcileLitellmRegistryAtStartup(serviceDeps);
}