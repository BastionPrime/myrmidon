import type { Agent } from "@paperclipai/plugin-sdk";

/**
 * Bank resolution for the forked hindsight plugin.
 *
 * One rule, applied identically everywhere the plugin touches memory
 * (comment retention, run-start recall, the two agent tools):
 *
 * 1. `adapterConfig.hindsight.bankId` on the agent card — read through the
 *    plugin SDK's agents API (`ctx.agents.get`), which the manifest's
 *    `agents.read` capability authorizes;
 * 2. otherwise `bankByAgentId[agentId]` from the plugin's configuration —
 *    the map an operator keeps synchronized from the agent cards;
 * 3. otherwise the agent is **closed**: retention is skipped with a warning
 *    and recall returns nothing. There is no fallback to a shared bank.
 */

export interface BankResolution {
  bankId: string;
  source: "agent-card" | "config-map";
  agentName: string | null;
}

export interface AgentLookup {
  (agentId: string, companyId: string): Promise<Agent | null>;
}

function readCardBankId(agent: Agent | null): string | null {
  const hindsight = agent?.adapterConfig?.["hindsight"];
  if (hindsight === null || typeof hindsight !== "object" || Array.isArray(hindsight)) return null;
  const bankId = (hindsight as Record<string, unknown>)["bankId"];
  if (typeof bankId !== "string") return null;
  const trimmed = bankId.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readConfigBankId(config: Record<string, unknown>, agentId: string): string | null {
  const map = config["bankByAgentId"];
  if (map === null || typeof map !== "object" || Array.isArray(map)) return null;
  const bankId = (map as Record<string, unknown>)[agentId];
  if (typeof bankId !== "string") return null;
  const trimmed = bankId.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Resolve the bank for one agent, or `null` when the agent is closed.
 *
 * Card lookup errors are treated as "no card value" (the card may be gone);
 * the agent then either resolves through the config map or stays closed.
 */
export async function resolveBank(
  input: {
    agentId: string;
    companyId: string;
    getAgent: AgentLookup;
    config: Record<string, unknown>;
  },
): Promise<BankResolution | null> {
  let agent: Agent | null = null;
  try {
    agent = await input.getAgent(input.agentId, input.companyId);
  } catch {
    agent = null;
  }
  const cardBankId = readCardBankId(agent);
  if (cardBankId) {
    return { bankId: cardBankId, source: "agent-card", agentName: agent?.name ?? null };
  }
  const configBankId = readConfigBankId(input.config, input.agentId);
  if (configBankId) {
    return { bankId: configBankId, source: "config-map", agentName: agent?.name ?? null };
  }
  return null;
}
