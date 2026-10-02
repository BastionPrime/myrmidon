import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  FORBIDDEN_CARD_ENV_KEYS,
  GITHUB_ENV_ALLOWLIST_ENV,
  MANAGED_GITHUB_CARD_ENV_KEYS,
  createCardEnvResolver,
  parseGithubEnvAllowlist,
  type CardEnvBindingContext,
  type CardEnvPorts,
} from "./card-env.js";
import { compileHermesProfile } from "./profile-compiler.js";
import { buildHermesProfileInput, type BotProfileSettings } from "./profile-input.js";

// Everything here is placeholder data: fake ids and obviously-fake secret values.

const COMPANY = "company-1";
const AGENT = { id: "agent-a", companyId: COMPANY };
// myrmidon(FLEETD-VMEXEC): the allowlist matches agent names.
const DEV_AGENT = { id: "agent-dev", companyId: COMPANY, name: "dev-vmexec" };

interface FakeState {
  /** secret id -> [stamp, value]; a missing entry is a secret that does not exist. */
  secrets: Map<string, { stamp: string; value: string }>;
  resolveCalls: Array<{ companyId: string; bindings: Record<string, unknown>; context: CardEnvBindingContext }>;
  stampCalls: string[];
  failNextResolve: boolean;
}

function fakePorts(initial: Record<string, { stamp: string; value: string }> = {}): { ports: CardEnvPorts; state: FakeState } {
  const state: FakeState = {
    secrets: new Map(Object.entries(initial)),
    resolveCalls: [],
    stampCalls: [],
    failNextResolve: false,
  };
  const ports: CardEnvPorts = {
    async resolveEnvBindings(companyId, bindings, context) {
      state.resolveCalls.push({ companyId, bindings: structuredClone(bindings), context });
      if (state.failNextResolve) {
        state.failNextResolve = false;
        throw new Error("Secret is not bound to agent:agent-a at env.TOKEN");
      }
      const env: Record<string, string> = {};
      const secretKeys = new Set<string>();
      for (const [name, raw] of Object.entries(bindings)) {
        const binding = raw as { type?: string; value?: string; secretId?: string };
        if (binding.type === "secret_ref" && binding.secretId) {
          const secret = state.secrets.get(binding.secretId);
          if (!secret) throw new Error("Secret not found");
          env[name] = secret.value;
          secretKeys.add(name);
        } else {
          env[name] = binding.value ?? String(raw);
        }
      }
      return { env, secretKeys };
    },
    async readSecretStamp(_companyId, secretId) {
      state.stampCalls.push(secretId);
      return state.secrets.get(secretId)?.stamp ?? null;
    },
  };
  return { ports, state };
}

const ref = (secretId: string) => ({ type: "secret_ref", secretId, version: "latest" });
const plain = (value: string) => ({ type: "plain", value });
const card = (env: Record<string, unknown>) => ({ ...AGENT, adapterConfig: { env } });

describe("myrmidon(W2a) card env — what a card may bind", () => {
  it.each([...FORBIDDEN_CARD_ENV_KEYS])("drops %s with a warning and never asks the secrets service for it", async (name) => {
    const { ports, state } = fakePorts({ s1: { stamp: "1:active", value: "fake-value-0001" } });
    const resolve = createCardEnvResolver(ports);
    const result = await resolve(card({ [name]: ref("s1"), KEEP_ME: plain("kept") }));
    expect(result.env[name]).toBeUndefined();
    expect(result.env.KEEP_ME).toEqual({ value: "kept", secret: false });
    expect(result.warnings).toEqual([expect.stringContaining(`env.${name}`)]);
    expect(state.resolveCalls).toHaveLength(1);
    expect(Object.keys(state.resolveCalls[0]!.bindings)).toEqual(["KEEP_ME"]);
  });

  it.each([...MANAGED_GITHUB_CARD_ENV_KEYS])(
    "drops the managed GitHub token %s with a warning and never asks the secrets service for it",
    async (name) => {
      const { ports, state } = fakePorts({ s1: { stamp: "1:active", value: "fake-value-0001" } });
      const resolve = createCardEnvResolver(ports);
      const result = await resolve(card({ [name]: ref("s1"), KEEP_ME: plain("kept") }));
      expect(result.env[name]).toBeUndefined();
      expect(result.env.KEEP_ME).toEqual({ value: "kept", secret: false });
      expect(result.warnings).toEqual([expect.stringContaining(`env.${name}`)]);
      expect(state.resolveCalls).toHaveLength(1);
      expect(Object.keys(state.resolveCalls[0]!.bindings)).toEqual(["KEEP_ME"]);
    },
  );

  it("resolves nothing, and warns once per name, when a card binds only reserved variables", async () => {
    const { ports, state } = fakePorts({ s1: { stamp: "1:active", value: "fake-value-0001" } });
    const result = await createCardEnvResolver(ports)(
      card({ GH_TOKEN: ref("s1"), PAPERCLIP_API_KEY: ref("s1") }),
    );
    expect(result.env).toEqual({});
    expect(result.warnings).toHaveLength(2);
    expect(state.resolveCalls).toHaveLength(0);
    expect(state.stampCalls).toEqual([]);
  });

  it("keeps a variable that only looks like a GitHub token name", async () => {
    const { ports } = fakePorts();
    const result = await createCardEnvResolver(ports)(
      card({ GITHUB_REPO: plain("example/repo"), GH_HOST: plain("github.example.com") }),
    );
    expect(Object.keys(result.env).sort()).toEqual(["GH_HOST", "GITHUB_REPO"]);
    expect(result.warnings).toEqual([]);
  });

  it("never lets a forbidden variable reach the compiled .env", async () => {
    const { ports } = fakePorts({ s1: { stamp: "1:active", value: "fake-secret-from-card" } });
    const resolved = await createCardEnvResolver(ports)(
      card({
        PAPERCLIP_GITHUB_BROKER_TOKEN: ref("s1"),
        PAPERCLIP_RUNNER_NETWORK_ACCESS: plain("open"),
        PAPERCLIP_API_KEY: ref("s1"),
        GH_TOKEN: ref("s1"),
        GITHUB_TOKEN: plain("fake-plain-github-token"),
        FLEET_NOTE: plain("ok"),
      }),
    );
    const settings: BotProfileSettings = {
      hindsightApiUrl: "https://example.com/hindsight",
      hindsightBank: "fleet-default",
      hindsightAllowedBanks: null,
      llmBaseUrl: "https://example.com/llm/v1",
      llmApiKeyEnv: "FLEET_LLM_API_KEY",
      llmApiKeySecret: "FLEET_LLM_API_KEY",
      boardUrl: "http://board.example.com:3100",
      runtimeMcpUrlBase: null,
      mcpServers: [],
      mcpServersError: null,
    };
    const { input } = buildHermesProfileInput(
      {
        botKey: "agent-a",
        adapterConfig: { provider: "custom" },
        runtimeConfig: {},
        env: resolved.env,
        skills: {},
        instructions: "",
        llmApiKey: "fake-llm-key-0001",
        apiServerKey: "fake-api-server-key-0001",
        paperclipApiKey: "fake-bots-own-board-key-0001",
        mcpServers: [],
      },
      settings,
    );
    const envFile = compileHermesProfile(input).files.find((f) => f.path === "hermes/.env")!.content;
    expect(envFile).not.toContain("fake-secret-from-card");
    expect(envFile).not.toContain("PAPERCLIP_GITHUB_BROKER_TOKEN");
    expect(envFile).not.toContain("PAPERCLIP_RUNNER_NETWORK_ACCESS");
    expect(envFile).not.toContain("GH_TOKEN");
    expect(envFile).not.toContain("GITHUB_TOKEN");
    expect(envFile).not.toContain("fake-plain-github-token");
    expect(envFile).toContain("PAPERCLIP_API_KEY=");
    expect(envFile).toContain("fake-bots-own-board-key-0001");
    expect(envFile).toContain("FLEET_NOTE");
  });

  it("drops a per-user secret with a warning", async () => {
    const { ports, state } = fakePorts();
    const result = await createCardEnvResolver(ports)(
      card({ PER_USER: { type: "user_secret_ref", key: "personal-token" }, KEEP_ME: plain("kept") }),
    );
    expect(result.env.PER_USER).toBeUndefined();
    expect(result.warnings).toEqual([expect.stringContaining("env.PER_USER")]);
    expect(Object.keys(state.resolveCalls[0]!.bindings)).toEqual(["KEEP_ME"]);
  });

  it("keeps the forbidden-variable list identical to the board's own", () => {
    const heartbeat = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../services/heartbeat.ts"),
      "utf8",
    );
    const block = /const FORBIDDEN_ENV_BINDING_KEYS = new Set\(\[([\s\S]*?)\]\);/.exec(heartbeat);
    expect(block, "FORBIDDEN_ENV_BINDING_KEYS not found in services/heartbeat.ts").not.toBeNull();
    const boardKeys = [...block![1]!.matchAll(/"([A-Z0-9_]+)"/g)].map((match) => match[1]!);
    expect(boardKeys.length).toBeGreaterThan(0);
    expect([...FORBIDDEN_CARD_ENV_KEYS].sort()).toEqual([...boardKeys].sort());
  });

  it("keeps the managed GitHub token list identical to the board's own", () => {
    const heartbeat = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../services/heartbeat.ts"),
      "utf8",
    );
    const block = /const MANAGED_GITHUB_TOKEN_KEYS = new Set\(\[([\s\S]*?)\]\);/.exec(heartbeat);
    expect(block, "MANAGED_GITHUB_TOKEN_KEYS not found in services/heartbeat.ts").not.toBeNull();
    const boardKeys = [...block![1]!.matchAll(/"([A-Z0-9_]+)"/g)].map((match) => match[1]!);
    expect(boardKeys.length).toBeGreaterThan(0);
    expect([...MANAGED_GITHUB_CARD_ENV_KEYS].sort()).toEqual([...boardKeys].sort());
  });
});

describe("myrmidon(W2a) card env — resolved under a binding context", () => {
  it("asks for the values as the agent's own consumer, with a system actor, so the binding is checked", async () => {
    const { ports, state } = fakePorts({ s1: { stamp: "1:active", value: "fake-value-0001" } });
    await createCardEnvResolver(ports)(card({ TOKEN: ref("s1") }));
    expect(state.resolveCalls).toEqual([
      {
        companyId: COMPANY,
        bindings: { TOKEN: ref("s1") },
        context: { consumerType: "agent", consumerId: "agent-a", actorType: "system" },
      },
    ]);
  });

  it("marks a secret_ref's value secret and a plain value not", async () => {
    const { ports } = fakePorts({ s1: { stamp: "1:active", value: "fake-value-0001" } });
    const result = await createCardEnvResolver(ports)(card({ TOKEN: ref("s1"), MODE: plain("fast") }));
    expect(result.env).toEqual({
      TOKEN: { value: "fake-value-0001", secret: true },
      MODE: { value: "fast", secret: false },
    });
    expect(result.warnings).toEqual([]);
  });

  it("propagates a refusal instead of falling back to an unchecked resolve", async () => {
    const { ports, state } = fakePorts({ s1: { stamp: "1:active", value: "fake-value-0001" } });
    state.failNextResolve = true;
    await expect(createCardEnvResolver(ports)(card({ TOKEN: ref("s1") }))).rejects.toThrow("not bound");
    expect(state.resolveCalls).toHaveLength(1);
  });

  it("resolves nothing for a card without env", async () => {
    const { ports, state } = fakePorts();
    const resolve = createCardEnvResolver(ports);
    expect(await resolve({ ...AGENT, adapterConfig: {} })).toEqual({ env: {}, warnings: [] });
    expect(await resolve(card({}))).toEqual({ env: {}, warnings: [] });
    expect(state.resolveCalls).toHaveLength(0);
  });
});

describe("myrmidon(W2a) card env — resolved again only when something it depends on changed", () => {
  it("does not resolve a second time for an unchanged card and unchanged secrets, and returns the same env", async () => {
    const { ports, state } = fakePorts({ s1: { stamp: "1:active", value: "fake-value-0001" } });
    const resolve = createCardEnvResolver(ports);
    const first = await resolve(card({ TOKEN: ref("s1"), MODE: plain("fast") }));
    const second = await resolve(card({ TOKEN: ref("s1"), MODE: plain("fast") }));
    const third = await resolve(card({ MODE: plain("fast"), TOKEN: ref("s1") }));
    expect(state.resolveCalls).toHaveLength(1);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    // The version check is not a resolve: it is asked on every call.
    expect(state.stampCalls).toEqual(["s1", "s1", "s1"]);
  });

  it("resolves again when a secret gets a new version (rotation)", async () => {
    const { ports, state } = fakePorts({ s1: { stamp: "1:active", value: "fake-value-0001" } });
    const resolve = createCardEnvResolver(ports);
    await resolve(card({ TOKEN: ref("s1") }));
    state.secrets.set("s1", { stamp: "2:active", value: "fake-value-0002" });
    const after = await resolve(card({ TOKEN: ref("s1") }));
    expect(after.env.TOKEN).toEqual({ value: "fake-value-0002", secret: true });
    expect(state.resolveCalls).toHaveLength(2);
  });

  it("resolves again when a secret's status changes", async () => {
    const { ports, state } = fakePorts({ s1: { stamp: "1:active", value: "fake-value-0001" } });
    const resolve = createCardEnvResolver(ports);
    await resolve(card({ TOKEN: ref("s1") }));
    state.secrets.set("s1", { stamp: "1:disabled", value: "fake-value-0001" });
    await resolve(card({ TOKEN: ref("s1") }));
    expect(state.resolveCalls).toHaveLength(2);
  });

  it("resolves again when the card's bindings change", async () => {
    const { ports, state } = fakePorts({
      s1: { stamp: "1:active", value: "fake-value-0001" },
      s2: { stamp: "1:active", value: "fake-value-0002" },
    });
    const resolve = createCardEnvResolver(ports);
    await resolve(card({ TOKEN: ref("s1") }));
    const repointed = await resolve(card({ TOKEN: ref("s2") }));
    expect(repointed.env.TOKEN?.value).toBe("fake-value-0002");
    const edited = await resolve(card({ TOKEN: ref("s2"), MODE: plain("fast") }));
    expect(edited.env.MODE?.value).toBe("fast");
    expect(state.resolveCalls).toHaveLength(3);
  });

  it("resolves a plain-only card once and never asks for a secret's version", async () => {
    const { ports, state } = fakePorts();
    const resolve = createCardEnvResolver(ports);
    await resolve(card({ MODE: plain("fast") }));
    await resolve(card({ MODE: plain("fast") }));
    expect(state.resolveCalls).toHaveLength(1);
    expect(state.stampCalls).toEqual([]);
  });

  it("keeps a separate cache per agent", async () => {
    const { ports, state } = fakePorts({ s1: { stamp: "1:active", value: "fake-value-0001" } });
    const resolve = createCardEnvResolver(ports);
    await resolve({ id: "agent-a", companyId: COMPANY, adapterConfig: { env: { TOKEN: ref("s1") } } });
    await resolve({ id: "agent-b", companyId: COMPANY, adapterConfig: { env: { TOKEN: ref("s1") } } });
    await resolve({ id: "agent-a", companyId: COMPANY, adapterConfig: { env: { TOKEN: ref("s1") } } });
    expect(state.resolveCalls.map((call) => call.context.consumerId)).toEqual(["agent-a", "agent-b"]);
  });

  it("does not remember a failure: the next call resolves again", async () => {
    const { ports, state } = fakePorts({ s1: { stamp: "1:active", value: "fake-value-0001" } });
    const resolve = createCardEnvResolver(ports);
    state.failNextResolve = true;
    await expect(resolve(card({ TOKEN: ref("s1") }))).rejects.toThrow();
    const retried = await resolve(card({ TOKEN: ref("s1") }));
    expect(retried.env.TOKEN?.value).toBe("fake-value-0001");
    expect(state.resolveCalls).toHaveLength(2);
  });

  it("does not let a caller's edit of the returned env change what the next call returns", async () => {
    const { ports } = fakePorts({ s1: { stamp: "1:active", value: "fake-value-0001" } });
    const resolve = createCardEnvResolver(ports);
    const first = await resolve(card({ TOKEN: ref("s1") }));
    delete first.env.TOKEN;
    const second = await resolve(card({ TOKEN: ref("s1") }));
    expect(second.env.TOKEN?.value).toBe("fake-value-0001");
  });

  it("treats a vanished secret as a change of its own: it resolves (and fails) instead of serving the old value", async () => {
    const { ports, state } = fakePorts({ s1: { stamp: "1:active", value: "fake-value-0001" } });
    const resolve = createCardEnvResolver(ports);
    await resolve(card({ TOKEN: ref("s1") }));
    state.secrets.delete("s1");
    await expect(resolve(card({ TOKEN: ref("s1") }))).rejects.toThrow("Secret not found");
  });
});

describe("myrmidon(FLEETD-VMEXEC) card env — the GitHub env allowlist", () => {
  it("keeps a managed GitHub token binding for a named agent, resolved as a secret", async () => {
    const { ports, state } = fakePorts({ s1: { stamp: "1:active", value: "fake-github-pat" } });
    const resolve = createCardEnvResolver(ports, { env: { [GITHUB_ENV_ALLOWLIST_ENV]: "dev-vmexec" } });
    const result = await resolve({ ...DEV_AGENT, adapterConfig: { env: { GITHUB_TOKEN: ref("s1") } } });
    expect(result.env.GITHUB_TOKEN).toEqual({ value: "fake-github-pat", secret: true });
    expect(result.warnings).toEqual([]);
    expect(state.resolveCalls).toEqual([
      {
        companyId: COMPANY,
        bindings: { GITHUB_TOKEN: ref("s1") },
        context: { consumerType: "agent", consumerId: "agent-dev", actorType: "system" },
      },
    ]);
  });

  it("still drops the token for an agent not in the list, and for an unnamed agent", async () => {
    const { ports } = fakePorts({ s1: { stamp: "1:active", value: "fake-github-pat" } });
    const resolve = createCardEnvResolver(ports, { env: { [GITHUB_ENV_ALLOWLIST_ENV]: "dev-vmexec,dev-other" } });
    const notListed = await resolve({ id: "agent-b", companyId: COMPANY, name: "dev-elsewhere", adapterConfig: { env: { GITHUB_TOKEN: ref("s1"), KEEP: plain("kept") } } });
    expect(notListed.env.GITHUB_TOKEN).toBeUndefined();
    expect(notListed.env.KEEP).toEqual({ value: "kept", secret: false });
    expect(notListed.warnings).toEqual([expect.stringContaining("env.GITHUB_TOKEN")]);
    const unnamed = await resolve({ id: "agent-c", companyId: COMPANY, adapterConfig: { env: { GITHUB_TOKEN: ref("s1"), KEEP: plain("kept") } } });
    expect(unnamed.env.GITHUB_TOKEN).toBeUndefined();
    expect(unnamed.env.KEEP).toEqual({ value: "kept", secret: false });
    expect(unnamed.warnings).toEqual([expect.stringContaining("env.GITHUB_TOKEN")]);
  });

  it("an empty or unset allowlist changes nothing (the fork's default)", async () => {
    const { ports } = fakePorts({ s1: { stamp: "1:active", value: "fake-github-pat" } });
    for (const raw of [undefined, "", "   ", ","]) {
      const resolve = createCardEnvResolver(ports, { env: raw === undefined ? {} : { [GITHUB_ENV_ALLOWLIST_ENV]: raw } });
      const result = await resolve({ ...DEV_AGENT, adapterConfig: { env: { GITHUB_TOKEN: ref("s1") } } });
      expect(result.env.GITHUB_TOKEN).toBeUndefined();
      expect(result.warnings).toEqual([expect.stringContaining("env.GITHUB_TOKEN")]);
    }
  });

  it("the allowlist is read per resolve, so emptying it takes effect on the next call", async () => {
    const { ports, state } = fakePorts({ s1: { stamp: "1:active", value: "fake-github-pat" } });
    const env: Record<string, string | undefined> = { [GITHUB_ENV_ALLOWLIST_ENV]: "dev-vmexec" };
    const resolve = createCardEnvResolver(ports, { env: env as NodeJS.ProcessEnv });
    const first = await resolve({ ...DEV_AGENT, adapterConfig: { env: { GITHUB_TOKEN: ref("s1") } } });
    expect(first.env.GITHUB_TOKEN).toEqual({ value: "fake-github-pat", secret: true });
    env[GITHUB_ENV_ALLOWLIST_ENV] = "";
    const second = await resolve({ ...DEV_AGENT, adapterConfig: { env: { GITHUB_TOKEN: ref("s1") } } });
    expect(second.env.GITHUB_TOKEN).toBeUndefined();
    expect(second.warnings).toEqual([expect.stringContaining("env.GITHUB_TOKEN")]);
    expect(state.resolveCalls).toHaveLength(1);
  });

  it("parses the list as trimmed, comma-separated agent names", () => {
    expect([...parseGithubEnvAllowlist(" a , b ,, c ")]).toEqual(["a", "b", "c"]);
    expect(parseGithubEnvAllowlist(undefined).size).toBe(0);
    expect(parseGithubEnvAllowlist("").size).toBe(0);
  });
});
