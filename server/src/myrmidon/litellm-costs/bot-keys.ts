// server/src/myrmidon/litellm-costs/bot-keys.ts
//
// myrmidon(M2-A): the bot gateway keys of a company, for spend attribution.
//
// Each bot's LLM gateway key lives in the company secret store under the name
// the instance configured (MYRMIDON_BOT_LLM_API_KEY_SECRET, default
// MYRMIDON_BOT_LLM_API_KEY_ENV — the same secret the bot profile compiles
// its hermes/.env from). This module resolves, per card that goes through
// the gateway, the key value and hands back agentId + value; the sweep
// hashes it and matches the gateway ledger's api_key.
//
// Resolution goes through the secrets service without a binding context on
// purpose: the same "no audit event per secret per minute" rule the bot
// reconciler follows (profile-ports.ts) — this sweep runs on a timer too.
// The key values never leave this process's memory and are never logged.

import { and, eq, ne, sql } from "drizzle-orm";
import { agents, type Db } from "@paperclipai/db";
import { secretService } from "../../services/index.js";
import { cardUsesLlmGateway } from "../bot-containers/profile-input.js";

export const BOT_LLM_API_KEY_ENV_ENV = "MYRMIDON_BOT_LLM_API_KEY_ENV";
export const BOT_LLM_API_KEY_SECRET_ENV = "MYRMIDON_BOT_LLM_API_KEY_SECRET";
/** Cards carry the key under this env name by default when they name none. */
const DEFAULT_BOT_LLM_KEY_ENV = "MYRMIDON_BOT_LLM_API_KEY";

/**
 * agentId + gateway key value for every card of the company that goes
 * through the gateway. A card with its own provider has no gateway key and
 * is skipped (its spend never appears in the gateway ledger under our keys).
 */
export async function listGatewayBotKeys(
  db: Db,
  companyId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Array<{ agentId: string; keyValue: string }>> {
  const secrets = secretService(db);
  const keyEnv = env[BOT_LLM_API_KEY_ENV_ENV]?.trim() || null;
  const keySecret = env[BOT_LLM_API_KEY_SECRET_ENV]?.trim() || keyEnv || DEFAULT_BOT_LLM_KEY_ENV;

  const rows = await db
    .select({
      agentId: agents.id,
      adapterType: agents.adapterType,
      adapterConfig: agents.adapterConfig,
    })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated")));

  const result: Array<{ agentId: string; keyValue: string }> = [];
  for (const row of rows) {
    if (row.adapterType !== "hermes_gateway") continue;
    const config = asRecord(row.adapterConfig);
    if (!cardUsesLlmGateway(config)) continue;

    // A card's own env binding wins (the profile compiler's precedence).
    const ownEnv = asRecord(config.env);
    const ownValue = typeof ownEnv?.[keyEnv ?? DEFAULT_BOT_LLM_KEY_ENV]?.value === "string"
      ? ownEnv[keyEnv ?? DEFAULT_BOT_LLM_KEY_ENV].value.trim()
      : "";
    if (ownValue) {
      result.push({ agentId: row.agentId, keyValue: ownValue });
      continue;
    }
    const secretRow = await secrets.getByName(companyId, keySecret);
    if (!secretRow) continue;
    const value = await secrets.resolveSecretValue(companyId, secretRow.id, "latest");
    if (value && value.trim()) result.push({ agentId: row.agentId, keyValue: value.trim() });
  }
  return result;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
