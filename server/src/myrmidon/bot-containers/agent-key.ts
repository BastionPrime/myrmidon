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
//   - The key carries a responsible user. The board rejects an agent key that has
//     none (403 RESPONSIBLE_USER_UNAVAILABLE on every call), so a key issued
//     without one is worthless. The reconcile tick has no acting person, so the
//     user is the one the board itself uses for work without an actor (routines,
//     activity): the company's default responsible user, else its oldest active
//     owner. With neither, no key is issued at all.
//   - A key that was issued without one (an earlier version of this driver) is
//     repaired in place: the missing user is filled in on the same key. Rotating
//     instead would change the token in the secret, so the profile hash changes
//     and every affected bot is restarted through a maintenance window; filling
//     the empty field keeps the token, the secret and the running container.
//     Only an EMPTY field is ever written, never a user an operator set.
//   - Nothing else is written when the secret already holds an active key's token,
//     apart from revoking strays; the reconciler calls this once a minute per bot.

/** The name the bot's board API key carries in agent_api_keys, so an operator can see what it is for. */
export const BOT_AGENT_API_KEY_NAME = "myrmidon-bot-container";

export interface BotAgentKeyDeps {
  /** The secret's current value, or null when the secret does not exist. */
  readSecret(): Promise<{ secretId: string; value: string } | null>;
  /** The ACTIVE (not revoked) key of this agent whose token is `token`, with the user it answers
   *  for (null when it has none); null when there is no such key. */
  findActiveKeyByToken(agentId: string, token: string): Promise<{ id: string; responsibleUserId: string | null } | null>;
  /** Every active key of this agent that carries `BOT_AGENT_API_KEY_NAME`. */
  listActiveBotKeyIds(agentId: string): Promise<string[]>;
  /** The company's default responsible user; null when none is set. */
  readCompanyDefaultResponsibleUserId(): Promise<string | null>;
  /** The company's oldest active owner (a user); null when there is none. */
  findCompanyOwnerUserId(): Promise<string | null>;
  /** Issues a key that answers for `responsibleUserId`; the token is only available here. */
  createKey(agentId: string, responsibleUserId: string): Promise<{ id: string; token: string }>;
  /** Sets `responsibleUserId` on the bot's own key, only while that key has none. False when nothing
   *  was changed (the key got a user meanwhile, was revoked or is not the bot's). */
  fillKeyResponsibleUser(agentId: string, keyId: string, responsibleUserId: string): Promise<boolean>;
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

/** The user a bot's key answers for when nobody is acting: the company's default, else its oldest active owner. */
async function resolveResponsibleUserId(deps: BotAgentKeyDeps): Promise<string | null> {
  return (await deps.readCompanyDefaultResponsibleUserId()) ?? (await deps.findCompanyOwnerUserId());
}

/** Repairs a key issued without a responsible user. A failure is reported, never thrown: the bot's
 *  profile does not change, and the next tick tries again. */
async function fillMissingResponsibleUser(
  deps: BotAgentKeyDeps,
  agentId: string,
  keyId: string,
  warnings: string[],
): Promise<void> {
  try {
    const userId = await resolveResponsibleUserId(deps);
    if (!userId) {
      warnings.push(
        `board API key ${keyId} has no responsible user, so the board rejects it, and the company has neither a default responsible user nor an active owner to give it`,
      );
      return;
    }
    if (!(await deps.fillKeyResponsibleUser(agentId, keyId, userId))) {
      warnings.push(`board API key ${keyId} has no responsible user and it could not be set (the key changed meanwhile); retried next tick`);
    }
  } catch (err) {
    warnings.push(
      `board API key ${keyId} has no responsible user and it could not be set (${err instanceof Error ? err.message : String(err)}); retried next tick`,
    );
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
    const activeKey = await deps.findActiveKeyByToken(agentId, existing.value);
    if (activeKey) {
      if (!activeKey.responsibleUserId?.trim()) await fillMissingResponsibleUser(deps, agentId, activeKey.id, warnings);
      await revokeStrays(deps, agentId, activeKey.id, "a stray key beside the bot's key", warnings);
      return { value: existing.value, warnings };
    }
  }

  // No secret, an empty one, or a token that is not an active key's (revoked, or never issued).
  // The user comes first: with none to give, nothing is issued that the board would reject.
  const responsibleUserId = await resolveResponsibleUserId(deps);
  if (!responsibleUserId) {
    throw new Error(
      "cannot issue the bot's board API key: the company has neither a default responsible user nor an active owner for it to answer for",
    );
  }
  const created = await deps.createKey(agentId, responsibleUserId);
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
