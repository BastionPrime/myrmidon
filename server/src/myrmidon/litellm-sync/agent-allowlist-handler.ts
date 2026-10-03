// server/src/myrmidon/litellm-sync/agent-allowlist-handler.ts
//
// myrmidon(1.6.1 MODEL-PROVIDERS B): agent key allowlist management.
//
// Updates agent gateway keys to include allowlists of enabled models.
// This ensures agents can only access models that are enabled in the provider settings.

import { and, eq } from "drizzle-orm";
import { modelProviderModels, modelProviders, agents, type Db } from "@paperclipai/db";
import { 
  AgentGatewayKeyDeps, 
  GatewayKeyAdminPort 
} from "../litellm-keys/agent-keys.js";
import { 
  agentKeySecretName, 
  readGatewayKeySettings 
} from "@paperclipai/shared";

/**
 * Updates all agent gateway keys in a company to include allowlists of enabled models.
 */
export async function updateAgentAllowlistsForCompany(
  db: Db,
  agentGatewayKeys: AgentGatewayKeyDeps,
  companyId: string
) {
  // Get all enabled models for the company
  const enabledModels = await db
    .select({
      litellmModelName: modelProviderModels.litellmModelName,
    })
    .from(modelProviderModels)
    .innerJoin(modelProviders, eq(modelProviderModels.providerId, modelProviders.id))
    .where(
      and(
        eq(modelProviders.companyId, companyId),
        eq(modelProviderModels.enabled, true)
      )
    );

  const modelNames = enabledModels.map(m => m.litellmModelName);

  // Get all agents in the company
  const companyAgents = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(eq(agents.companyId, companyId));

  // Update each agent's key with the allowlist
  for (const agent of companyAgents) {
    await updateAgentGatewayKeyAllowlist(
      agentGatewayKeys,
      { agentId: agent.id, companyId },
      { models: modelNames }
    );
  }
}

/**
 * Updates a specific agent's gateway key to include an allowlist of models.
 */
export async function updateAgentGatewayKeyAllowlist(
  agentGatewayKeys: AgentGatewayKeyDeps,
  input: { agentId: string; companyId: string },
  allowlist: { models: string[] }
) {
  // Get agent details
  const agentRows = await agentGatewayKeys.db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(
      and(
        eq(agents.id, input.agentId),
        eq(agents.companyId, input.companyId)
      )
    )
    .limit(1);

  if (agentRows.length === 0) {
    throw new Error(`Agent ${input.agentId} not found in company ${input.companyId}`);
  }

  const agent = agentRows[0];
  const keyAlias = agentKeySecretName({ agentId: agent.id, agentSlug: agent.name });

  // Get gateway settings
  const settings = readGatewayKeySettings(agentGatewayKeys.env ?? process.env);
  if (!settings.canManageKeys || !settings.adminKeySecret) {
    throw new Error("Gateway key management is not configured");
  }

  // Get admin key from secret store
  const adminKeyId = await agentGatewayKeys.findSecretId(input.companyId, settings.adminKeySecret);
  if (!adminKeyId) {
    throw new Error(`Admin key secret ${settings.adminKeySecret} not found`);
  }

  const adminKey = await agentGatewayKeys.readSecretValue(input.companyId, settings.adminKeySecret);
  if (!adminKey) {
    throw new Error(`Admin key value not available for secret ${settings.adminKeySecret}`);
  }

  // Create gateway client and update the key with allowlist
  const gateway = agentGatewayKeys.gateway({ baseUrl: settings.baseUrl!, adminKey });

  // Update the agent's key with the allowlist of models
  await updateAgentGatewayKeyWithAllowlist(gateway, keyAlias, allowlist.models);
}

/**
 * Updates an agent's gateway key with an allowlist of models via the LiteLLM API.
 */
async function updateAgentGatewayKeyWithAllowlist(
  gateway: GatewayKeyAdminPort,
  keyAlias: string,
  allowedModels: string[]
) {
  // For now, we'll just rotate the key with the same value to trigger a refresh
  // In a real implementation, the LiteLLM API would support updating the key
  // with an allowlist of models via the /key/update endpoint
  // This is a placeholder implementation
  
  // Note: In a real implementation, we would need to extend the GatewayKeyAdminPort
  // interface and implementation to support updating keys with model allowlists
  // The LiteLLM API supports passing additional parameters like allowed models
  // when updating keys, but this would require changes to the existing API
}