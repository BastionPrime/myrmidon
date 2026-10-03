// server/src/myrmidon/litellm-sync/index.ts
//
// myrmidon(1.6.1 MODEL-PROVIDERS B: main module export for LiteLLM synchronization.
//
// Exports all the necessary functionality for synchronizing enabled models
// with LiteLLM's registry and managing agent key allowlists.

export { 
  createLitellmSyncService, 
  type LitellmSyncServiceDeps,
  type SyncTrigger 
} from "./service.js";

export type { LitellmSyncService } from "./service.js";

export { 
  createLitellmSyncClient, 
  type LitellmSyncClientDeps 
} from "./client.js";

export { 
  type LitellmSyncPort 
} from "./port.js";

export { 
  updateAgentAllowlistsForCompany,
  updateAgentGatewayKeyAllowlist
} from "./agent-allowlist-handler.js";

export { 
  reconcileLitellmRegistryAtStartup 
} from "./startup-reconciler.js";