// server/src/myrmidon/bot-containers/agent-key.ts
//
// myrmidon(W2a): the bot's own board API key (PAPERCLIP_API_KEY in the container's
// .env), as a pure get-or-create over injected operations. The database-bound
// operations live in profile-ports.ts; the rules live here so they are tested
// against fakes:
//
//   - The token in the company secret must belong to an ACTIVE key. "Some key
//     with the bot's name is active" is not proof: after a lost secret the
//     active key may be a stranger's, and the secret's token dead. The check is
//     the token's own hash against agent_api_keys (findActiveKeyIdByToken).
//   - Creating is all-or-nothing from the caller's side. A key is issued first
//     (its token is shown once), then stored as the secret's value. If storing
//     fails the key is revoked, so nothing is left active that no secret can
//     ever reveal.
//   - After a successful store, every OTHER active key of the same name is
//     revoked. A bot has exactly one such key; a leftover is a token that nothing
//     uses but that still opens the board as the bot.
//   - Nothing here writes when the secret already holds an active key's token,
//     apart from revoking strays; the reconciler calls this once a minute per bot.

/** The name the bot's board API key carries in agent_api_keys, so an operator can see what it is for. */
export const BOT_AGENT_API_KEY_NAME = "myrmidon-bot-container";

export interface BotAgentKeyDeps {
  /** The secret's current value, or null when the secret does not exist. */
  readSecret(): Promise<{ secretId: string; value: string } | null>;
  /** The id of the ACTIVE (not revoked) key of this agent whose token is `token`; null when none. */
  findActiveKeyIdByToken(agentId: string, token: string): Promise<string | null>;
  /** Every active key of this agent that carries `BOT_AGENT_API_KEY_NAME`. */
  listActiveBotKeyIds(agentId: string): Promise<string[]>;
  /** Issues a key; the token is only available here. */
  createKey(agentId: string): Promise<{ id: string; token: string }>;
  revokeKey(agentId: string, keyId: string): Promise<void>;
  /** Stores the token as the secret's value: a new version of an existing secret, or a new secret. */
  storeSecret(existing: { secretId: string } | null, token: string): Promise<void>;
}

export interface EnsuredBotAgentKey {
  value: string;
  /** Cleanup that failed without failing the call (a stray key that could not be revoked). Retried next call. */
  warnings: string[];
}

async function revokeQuietly(
  deps: BotAgentKeyDeps,
  agentId: string,
  keyId: string,
  why: string,
  warnings: string[],
): Promise<void> {
  try {
    await deps.revokeKey(agentId, keyId);
  } catch (err) {
    // Retried on the next tick: the stray sweep below runs whenever the secret is healthy.
    warnings.push(`board API key ${keyId}: ${why}, revoke failed (${err instanceof Error ? err.message : String(err)})`);
  }
}

async function revokeStrays(
  deps: BotAgentKeyDeps,
  agentId: string,
  keepKeyId: string,
  why: string,
  warnings: string[],
): Promise<void> {
  const active = await deps.listActiveBotKeyIds(agentId);
  for (const keyId of active) {
    if (keyId !== keepKeyId) await revokeQuietly(deps, agentId, keyId, why, warnings);
  }
}

export async function ensureBotAgentKey(deps: BotAgentKeyDeps, agentId: string): Promise<EnsuredBotAgentKey> {
  const warnings: string[] = [];
  const existing = await deps.readSecret();

  if (existing && existing.value.trim()) {
    const activeKeyId = await deps.findActiveKeyIdByToken(agentId, existing.value);
    if (activeKeyId) {
      await revokeStrays(deps, agentId, activeKeyId, "a stray key beside the bot's key", warnings);
      return { value: existing.value, warnings };
    }
  }

  // No secret, an empty one, or a token that is not an active key's (revoked, or never issued).
  const created = await deps.createKey(agentId);
  try {
    await deps.storeSecret(existing ? { secretId: existing.secretId } : null, created.token);
  } catch (err) {
    // The caller sees the original failure: a failed compensation must not mask it. The key it
    // would leave carries the bot's name and is not the secret's, so the next call sweeps it.
    await revokeQuietly(deps, agentId, created.id, "the secret could not be stored", warnings);
    throw err;
  }
  await revokeStrays(deps, agentId, created.id, "replaced by a new key", warnings);
  return { value: created.token, warnings };
}
