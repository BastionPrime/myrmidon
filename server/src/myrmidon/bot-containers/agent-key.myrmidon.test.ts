import { describe, expect, it } from "vitest";

import { BOT_AGENT_API_KEY_NAME, ensureBotAgentKey, type BotAgentKeyDeps } from "./agent-key.js";

// Placeholder ids and tokens only.

const AGENT_ID = "agent-a";

interface FakeKey {
  id: string;
  name: string;
  token: string;
  revoked: boolean;
  responsibleUserId?: string | null;
}

interface FakeOptions {
  keys?: FakeKey[];
  secret?: { secretId: string; value: string } | null;
  failCreate?: boolean;
  failStore?: boolean;
  failRevokeOf?: string[];
  /** The company's default responsible user (default "user-a"), and its oldest active owner (default none). */
  defaultUser?: string | null;
  ownerUser?: string | null;
}

function fake(options: FakeOptions = {}) {
  const state = {
    keys: (options.keys ?? []).map((key) => ({ ...key })),
    secret: options.secret ? { ...options.secret } : null,
    counter: 0,
    calls: [] as string[],
  };
  const deps: BotAgentKeyDeps = {
    async readSecret() {
      state.calls.push("readSecret");
      return state.secret ? { ...state.secret } : null;
    },
    async findActiveKeyByToken(_agentId, token) {
      state.calls.push("findActiveKeyByToken");
      const key = state.keys.find((candidate) => candidate.token === token && !candidate.revoked);
      return key ? { id: key.id, responsibleUserId: key.responsibleUserId ?? null } : null;
    },
    async listActiveBotKeyIds() {
      state.calls.push("listActiveBotKeyIds");
      return state.keys.filter((key) => key.name === BOT_AGENT_API_KEY_NAME && !key.revoked).map((key) => key.id);
    },
    async readCompanyDefaultResponsibleUserId() {
      return options.defaultUser === undefined ? "user-a" : options.defaultUser;
    },
    async findCompanyOwnerUserId() {
      return options.ownerUser ?? null;
    },
    async createKey(_agentId, responsibleUserId) {
      state.calls.push("createKey");
      if (options.failCreate) throw new Error("agent is terminated");
      state.counter += 1;
      const key = {
        id: `key-new-${state.counter}`,
        name: BOT_AGENT_API_KEY_NAME,
        token: `token-new-${state.counter}`,
        revoked: false,
        responsibleUserId,
      };
      state.keys.push(key);
      return { id: key.id, token: key.token };
    },
    async fillKeyResponsibleUser(_agentId, keyId, responsibleUserId) {
      state.calls.push(`fillKeyResponsibleUser:${keyId}`);
      const key = state.keys.find((candidate) => candidate.id === keyId);
      if (!key || key.revoked || key.responsibleUserId) return false;
      key.responsibleUserId = responsibleUserId;
      return true;
    },
    async revokeKey(_agentId, keyId) {
      state.calls.push(`revokeKey:${keyId}`);
      if (options.failRevokeOf?.includes(keyId)) throw new Error("database is read-only");
      const key = state.keys.find((candidate) => candidate.id === keyId);
      if (key) key.revoked = true;
    },
    async storeSecret(existing, token) {
      state.calls.push(existing ? "rotateSecret" : "createSecret");
      if (options.failStore) throw new Error("secret provider is down");
      state.secret = { secretId: existing?.secretId ?? "secret-new", value: token };
    },
  };
  return { deps, state };
}

/** Every call of the fake that changes something (a read is not one). */
function isWrite(call: string): boolean {
  return (
    call === "createKey" ||
    call.startsWith("revokeKey:") ||
    call.startsWith("fillKeyResponsibleUser:") ||
    call === "createSecret" ||
    call === "rotateSecret"
  );
}

const ACTIVE_KEY: FakeKey = { id: "key-1", name: BOT_AGENT_API_KEY_NAME, token: "token-1", revoked: false, responsibleUserId: "user-a" };
const REVOKED_KEY: FakeKey = { id: "key-0", name: BOT_AGENT_API_KEY_NAME, token: "token-0", revoked: true };

describe("myrmidon(W2a) ensureBotAgentKey", () => {
  it("creates a key and stores its token when there is no secret yet", async () => {
    const { deps, state } = fake();
    const result = await ensureBotAgentKey(deps, AGENT_ID);
    expect(result).toEqual({ value: "token-new-1", warnings: [] });
    expect(state.secret).toEqual({ secretId: "secret-new", value: "token-new-1" });
    expect(state.keys.filter((key) => !key.revoked).map((key) => key.id)).toEqual(["key-new-1"]);
    expect(state.calls).toContain("createSecret");
  });

  it("writes nothing when the secret holds the token of an active key", async () => {
    const { deps, state } = fake({ keys: [ACTIVE_KEY], secret: { secretId: "secret-1", value: "token-1" } });
    expect(await ensureBotAgentKey(deps, AGENT_ID)).toEqual({ value: "token-1", warnings: [] });
    expect(state.calls.filter(isWrite)).toEqual([]);
  });

  it("issues a new key, rotates the secret and leaves the old token unused when the key was revoked", async () => {
    const { deps, state } = fake({ keys: [REVOKED_KEY], secret: { secretId: "secret-1", value: "token-0" } });
    const result = await ensureBotAgentKey(deps, AGENT_ID);
    expect(result.value).toBe("token-new-1");
    expect(result.value).not.toBe("token-0");
    // The same secret was rotated, not a second secret created.
    expect(state.calls).toContain("rotateSecret");
    expect(state.calls).not.toContain("createSecret");
    expect(state.secret).toEqual({ secretId: "secret-1", value: "token-new-1" });
    expect(state.keys.filter((key) => !key.revoked).map((key) => key.id)).toEqual(["key-new-1"]);
  });

  it("does not take a stranger's active key for the bot's: the secret's own token must match", async () => {
    // Active key with the bot's name, but the secret holds a token that belongs to no active key.
    const { deps, state } = fake({ keys: [ACTIVE_KEY], secret: { secretId: "secret-1", value: "token-lost" } });
    const result = await ensureBotAgentKey(deps, AGENT_ID);
    expect(result.value).toBe("token-new-1");
    // The stranger under the same name is revoked, since a bot has exactly one such key.
    expect(state.keys.find((key) => key.id === "key-1")?.revoked).toBe(true);
    expect(state.keys.filter((key) => !key.revoked).map((key) => key.id)).toEqual(["key-new-1"]);
  });

  it("treats an empty secret value as no token", async () => {
    const { deps, state } = fake({ keys: [ACTIVE_KEY], secret: { secretId: "secret-1", value: "  " } });
    const result = await ensureBotAgentKey(deps, AGENT_ID);
    expect(result.value).toBe("token-new-1");
    expect(state.calls).toContain("rotateSecret");
    expect(state.calls).not.toContain("findActiveKeyByToken");
  });

  it("revokes the key it created when storing the secret fails, and reports the failure", async () => {
    const { deps, state } = fake({ failStore: true });
    await expect(ensureBotAgentKey(deps, AGENT_ID)).rejects.toThrow("secret provider is down");
    expect(state.keys).toEqual([
      { id: "key-new-1", name: BOT_AGENT_API_KEY_NAME, token: "token-new-1", revoked: true, responsibleUserId: "user-a" },
    ]);
    expect(state.secret).toBeNull();
  });

  it("revokes the key it created when rotating an existing secret fails, keeping the old secret value", async () => {
    const { deps, state } = fake({ keys: [REVOKED_KEY], secret: { secretId: "secret-1", value: "token-0" }, failStore: true });
    await expect(ensureBotAgentKey(deps, AGENT_ID)).rejects.toThrow("secret provider is down");
    expect(state.keys.filter((key) => !key.revoked)).toEqual([]);
    expect(state.secret).toEqual({ secretId: "secret-1", value: "token-0" });
  });

  it("creates nothing to revoke when issuing the key itself fails", async () => {
    const { deps, state } = fake({ failCreate: true });
    await expect(ensureBotAgentKey(deps, AGENT_ID)).rejects.toThrow("agent is terminated");
    expect(state.calls.filter((call) => call.startsWith("revokeKey"))).toEqual([]);
    expect(state.secret).toBeNull();
  });

  it("still fails with the original error when the compensating revoke fails too", async () => {
    const { deps, state } = fake({ failStore: true, failRevokeOf: ["key-new-1"] });
    await expect(ensureBotAgentKey(deps, AGENT_ID)).rejects.toThrow("secret provider is down");
    // The key it could not revoke is the bot's-name key that no secret holds: the next call sweeps it.
    expect(state.keys.filter((key) => !key.revoked).map((key) => key.id)).toEqual(["key-new-1"]);
    expect(state.secret).toBeNull();
  });

  it("sweeps a key left by a failed compensation on the next call", async () => {
    const orphan: FakeKey = { id: "key-orphan", name: BOT_AGENT_API_KEY_NAME, token: "token-orphan", revoked: false };
    const { deps, state } = fake({ keys: [orphan] });
    const result = await ensureBotAgentKey(deps, AGENT_ID);
    expect(result.value).toBe("token-new-1");
    expect(state.keys.find((key) => key.id === "key-orphan")?.revoked).toBe(true);
  });

  it("revokes every other active key of the bot's name after a successful issue", async () => {
    const stray = (id: string): FakeKey => ({ id, name: BOT_AGENT_API_KEY_NAME, token: `token-${id}`, revoked: false });
    const other: FakeKey = { id: "key-other", name: "some-operator-key", token: "token-other", revoked: false };
    const { deps, state } = fake({ keys: [stray("s1"), stray("s2"), other] });
    await ensureBotAgentKey(deps, AGENT_ID);
    const active = state.keys.filter((key) => !key.revoked).map((key) => key.id);
    // The new key and a key of another name (not the bot's) stay active.
    expect(active.sort()).toEqual(["key-new-1", "key-other"]);
  });

  it("sweeps a stray beside a healthy key without issuing anything", async () => {
    const stray: FakeKey = { id: "key-stray", name: BOT_AGENT_API_KEY_NAME, token: "token-stray", revoked: false };
    const { deps, state } = fake({ keys: [ACTIVE_KEY, stray], secret: { secretId: "secret-1", value: "token-1" } });
    expect((await ensureBotAgentKey(deps, AGENT_ID)).value).toBe("token-1");
    expect(state.keys.find((key) => key.id === "key-stray")?.revoked).toBe(true);
    expect(state.keys.find((key) => key.id === "key-1")?.revoked).toBe(false);
    expect(state.calls).not.toContain("createKey");
  });

  it("keeps the new key when revoking a stray fails, and reports it instead of failing", async () => {
    const stray: FakeKey = { id: "key-stray", name: BOT_AGENT_API_KEY_NAME, token: "token-stray", revoked: false };
    const { deps, state } = fake({ keys: [stray], failRevokeOf: ["key-stray"] });
    const result = await ensureBotAgentKey(deps, AGENT_ID);
    expect(result.value).toBe("token-new-1");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("key-stray");
    expect(result.warnings[0]).toContain("revoke failed");
    // A revoke that failed is not a reason to lose the key that was just stored.
    expect(state.secret?.value).toBe("token-new-1");
  });

  it("issues the key with a responsible user: the company default, else its owner, else nothing", async () => {
    const fromDefault = fake();
    await ensureBotAgentKey(fromDefault.deps, AGENT_ID);
    expect(fromDefault.state.keys[0]?.responsibleUserId).toBe("user-a");

    const fromOwner = fake({ defaultUser: null, ownerUser: "user-b" });
    await ensureBotAgentKey(fromOwner.deps, AGENT_ID);
    expect(fromOwner.state.keys[0]?.responsibleUserId).toBe("user-b");

    const nobody = fake({ defaultUser: null });
    await expect(ensureBotAgentKey(nobody.deps, AGENT_ID)).rejects.toThrow("neither a default responsible user nor an active owner");
    expect(nobody.state.calls.filter(isWrite)).toEqual([]);
  });

  it("fills the missing responsible user into a legacy key in place: same token, same secret, no new key", async () => {
    const legacy: FakeKey = { ...ACTIVE_KEY, responsibleUserId: null };
    const { deps, state } = fake({ keys: [legacy], secret: { secretId: "secret-1", value: "token-1" } });
    expect(await ensureBotAgentKey(deps, AGENT_ID)).toEqual({ value: "token-1", warnings: [] });
    expect(state.keys).toEqual([{ ...ACTIVE_KEY, responsibleUserId: "user-a" }]);
    expect(state.secret).toEqual({ secretId: "secret-1", value: "token-1" });
    expect(state.calls).not.toContain("createKey");
    // Already filled: the next tick writes nothing.
    const callsAfterFirst = state.calls.length;
    await ensureBotAgentKey(deps, AGENT_ID);
    expect(state.calls.slice(callsAfterFirst).filter(isWrite)).toEqual([]);
  });

  it("is stable across ticks: the second call reuses the first call's key and writes nothing", async () => {
    const { deps, state } = fake();
    const first = await ensureBotAgentKey(deps, AGENT_ID);
    const callsAfterFirst = state.calls.length;
    const second = await ensureBotAgentKey(deps, AGENT_ID);
    expect(second.value).toBe(first.value);
    const later = state.calls.slice(callsAfterFirst);
    expect(later.filter(isWrite)).toEqual([]);
  });
});
