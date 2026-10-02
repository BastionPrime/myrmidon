import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertAgentMayReadOwnGatewayKey,
  assertManagedKeySecretName,
  createAgentGatewayKey,
  createGatewayKeyAdminPort,
  gatewayKeyValueHash,
  readAgentGatewayKey,
  rotateAgentGatewayKey,
  type AgentGatewayKeyDeps,
  type GatewayKeyAdminPort,
} from "./agent-keys.js";
import { assertCardFallbacksAcyclic, assertFallbackTopologyAcyclic } from "./fallback-cycles.js";

const ENABLED_ENV = {
  MYRMIDON_LITELLM_BASE_URL: "http://gateway.internal:4000",
  MYRMIDON_LITELLM_ADMIN_KEY_SECRET: "gateway-admin",
} as NodeJS.ProcessEnv;

/** A key-management port that records what it was asked to do. */
function recordingGateway(): GatewayKeyAdminPort & { calls: Array<{ op: string; alias: string; value?: string }> } {
  const calls: Array<{ op: string; alias: string; value?: string }> = [];
  const installed = new Set<string>();
  return {
    calls,
    async createKey({ alias, value }) {
      calls.push({ op: "create", alias, value });
      installed.add(alias);
    },
    async rotateKey({ alias, value }) {
      calls.push({ op: "rotate", alias, value });
      return installed.has(alias);
    },
    async deleteKey({ alias }) {
      calls.push({ op: "delete", alias });
      installed.delete(alias);
    },
  };
}

/** A deps bundle over an in-memory secret store. */
function makeDeps(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  const gateway = recordingGateway();
  const deps: AgentGatewayKeyDeps = {
    db: { select: () => ({ from: () => ({ where: async () => [] }) }) } as never,
    env: ENABLED_ENV,
    readSecretValue: async (_companyId, name) => store.get(name) ?? null,
    findSecretId: async (_companyId, name) => (store.has(name) ? `id-${name}` : null),
    createSecret: async ({ name, value }) => {
      store.set(name, value);
      return { id: `id-${name}` };
    },
    rotateSecret: async (secretId, value) => {
      store.set(secretId.replace(/^id-/, ""), value);
    },
    gateway: () => gateway,
  };
  return { deps, store, gateway };
}

/** A deps bundle whose agent lookup resolves one agent of a company. */
function depsWithAgent(
  agent: { id: string; name: string },
  seed: Record<string, string> = {},
  companyId = "company-a",
) {
  const base = makeDeps(seed);
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [{ id: agent.id, name: agent.name }] }),
      }),
    }),
  };
  void companyId;
  return { ...base, deps: { ...base.deps, db: db as never } };
}

describe("myrmidon(M2-B) agent gateway keys", () => {
  it("creates a key under a name derived from the agent and stores its value", async () => {
    const agent = { id: "agent-a", name: "Copywriter" };
    const { deps, store, gateway } = depsWithAgent(agent, { "gateway-admin": "admin-value" });
    const created = await createAgentGatewayKey(deps, { companyId: "company-a", agentId: agent.id });

    expect(created.view.secretName).toBe("llm-gateway-key-copywriter-agent-a");
    expect(created.view.present).toBe(true);
    expect(created.view.valueHash).toBe(gatewayKeyValueHash(created.value));
    // The gateway got the value; the store got the same value; nothing got a hash.
    expect(gateway.calls).toEqual([
      { op: "create", alias: created.view.secretName, value: created.value },
    ]);
    expect(store.get(created.view.secretName)).toBe(created.value);
  });

  it("never answers the value again on a read", async () => {
    const agent = { id: "agent-a", name: "Copywriter" };
    const { deps } = depsWithAgent(agent, { "gateway-admin": "admin-value" });
    const created = await createAgentGatewayKey(deps, { companyId: "company-a", agentId: agent.id });
    const view = await readAgentGatewayKey(deps, { companyId: "company-a", agentId: agent.id });

    expect(Object.keys(view)).not.toContain("value");
    expect(view.valueHash).toBe(gatewayKeyValueHash(created.value));
  });

  it("refuses a second key for the same agent instead of overwriting it", async () => {
    const agent = { id: "agent-a", name: "Copywriter" };
    const { deps } = depsWithAgent(agent, { "gateway-admin": "admin-value" });
    await createAgentGatewayKey(deps, { companyId: "company-a", agentId: agent.id });
    await expect(
      createAgentGatewayKey(deps, { companyId: "company-a", agentId: agent.id }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("rotates one agent's key without touching another agent's", async () => {
    const agentA = { id: "agent-a", name: "alpha" };
    const agentB = { id: "agent-b", name: "beta" };
    const seed = { "gateway-admin": "admin-value" };
    const a = depsWithAgent(agentA, seed);
    await createAgentGatewayKey(a.deps, { companyId: "company-a", agentId: agentA.id });
    const b = depsWithAgent(agentB, seed);
    await createAgentGatewayKey(b.deps, { companyId: "company-a", agentId: agentB.id });

    const valueOfA = a.store.get("llm-gateway-key-alpha-agent-a");
    const beforeB = b.store.get("llm-gateway-key-beta-agent-b");
    expect(beforeB).toBeDefined();

    const rotated = await rotateAgentGatewayKey(a.deps, { companyId: "company-a", agentId: agentA.id });
    expect(rotated.secretName).toBe("llm-gateway-key-alpha-agent-a");
    expect(a.store.get("llm-gateway-key-alpha-agent-a")).not.toBe(valueOfA);
    expect(gatewayKeyValueHash(a.store.get("llm-gateway-key-alpha-agent-a")!)).toBe(rotated.valueHash);
    // The other agent's secret value is untouched: that is the acceptance line.
    expect(b.store.get("llm-gateway-key-beta-agent-b")).toBe(beforeB);
    expect(a.gateway.calls.map((call) => call.alias)).toEqual([
      "llm-gateway-key-alpha-agent-a",
      "llm-gateway-key-alpha-agent-a",
    ]);
    expect(b.gateway.calls.map((call) => call.alias)).toEqual(["llm-gateway-key-beta-agent-b"]);
  });

  it("leaves the store alone when the gateway does not know the alias", async () => {
    const agent = { id: "agent-a", name: "alpha" };
    const { deps, store, gateway } = depsWithAgent(agent, {
      "gateway-admin": "admin-value",
      "llm-gateway-key-alpha-agent-a": "old-value",
    });
    // The alias is not installed in the port, so the rotation is not acknowledged.
    gateway.calls.length = 0;
    await expect(rotateAgentGatewayKey(deps, { companyId: "company-a", agentId: agent.id })).rejects.toMatchObject({
      status: 422,
    });
    expect(store.get("llm-gateway-key-alpha-agent-a")).toBe("old-value");
  });

  it("refuses to work without an admin key configured", async () => {
    const agent = { id: "agent-a", name: "alpha" };
    const { deps } = depsWithAgent(agent, {});
    const withoutAdmin = { ...deps, env: ENABLED_ENV };
    await expect(
      createAgentGatewayKey(withoutAdmin, { companyId: "company-a", agentId: agent.id }),
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe("myrmidon(M2-B) key ownership guards", () => {
  it("lets an agent read its own key and refuses another agent's", () => {
    expect(() =>
      assertAgentMayReadOwnGatewayKey({ actorType: "agent", actorAgentId: "agent-a", requestedAgentId: "agent-a" }),
    ).not.toThrow();
    expect(() =>
      assertAgentMayReadOwnGatewayKey({ actorType: "agent", actorAgentId: "agent-a", requestedAgentId: "agent-b" }),
    ).toThrow(/own LLM gateway key/);
  });

  it("does not narrow a board member", () => {
    expect(() =>
      assertAgentMayReadOwnGatewayKey({ actorType: "user", actorAgentId: null, requestedAgentId: "agent-b" }),
    ).not.toThrow();
  });

  it("refuses to rotate a secret this feature does not own", () => {
    expect(() => assertManagedKeySecretName("llm-gateway-key-alpha-agent-a")).not.toThrow();
    expect(() => assertManagedKeySecretName("some-other-secret")).toThrow(/not a managed/);
  });
});

describe("myrmidon(M2-B) fallback guards", () => {
  it("rejects a card chain that loops, with the models named", () => {
    expect(() =>
      assertCardFallbacksAcyclic({ model: "model-a", models: { fallbacks: ["model-b", "model-a"] } }),
    ).toThrow(/model-a -> model-b -> model-a/);
  });

  it("accepts a card chain without a loop", () => {
    expect(() =>
      assertCardFallbacksAcyclic({ model: "model-a", models: { fallbacks: ["model-b", "model-c"] } }),
    ).not.toThrow();
  });

  it("rejects a topology that loops, naming the loop", () => {
    expect(() =>
      assertFallbackTopologyAcyclic([
        { "model-a": ["model-b"] },
        { "model-b": ["model-a"] },
      ]),
    ).toThrow(/model-a -> model-b -> model-a/);
  });

  it("rejects an unreadable topology rather than checking nothing", () => {
    expect(() => assertFallbackTopologyAcyclic({ "model-a": ["model-b"] })).toThrow(/list of/);
  });
});

describe("myrmidon(M2-B) gateway key transport", () => {
  let server: Server | null = null;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  });

  it("sends the value in the body of the key endpoints", async () => {
    const seen: Array<{ path: string; body: Record<string, unknown>; auth: string | undefined }> = [];
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        seen.push({
          path: req.url ?? "",
          body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
          auth: req.headers.authorization,
        });
        if (req.url === "/key/update") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ key_alias: "llm-gateway-key-alpha-agent-a" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ key: "sk-returned" }));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const address = server!.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const admin = createGatewayKeyAdminPort(`http://127.0.0.1:${port}`, "admin-value");

    await admin.createKey({ alias: "llm-gateway-key-alpha-agent-a", value: "value-1" });
    const rotated = await admin.rotateKey({ alias: "llm-gateway-key-alpha-agent-a", value: "value-2" });

    expect(rotated).toBe(true);
    expect(seen.map((entry) => entry.path)).toEqual(["/key/generate", "/key/update"]);
    expect(seen[0]!.body).toEqual({ key_alias: "llm-gateway-key-alpha-agent-a", key: "value-1" });
    expect(seen[1]!.body).toEqual({ key_alias: "llm-gateway-key-alpha-agent-a", key: "value-2" });
    expect(seen.every((entry) => entry.auth === "Bearer admin-value")).toBe(true);
  });

  it("maps a gateway error to a 422 instead of a silent success", async () => {
    server = createServer((_req, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "boom" }));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const address = server!.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const admin = createGatewayKeyAdminPort(`http://127.0.0.1:${port}`, "admin-value");
    await expect(admin.createKey({ alias: "a", value: "b" })).rejects.toMatchObject({ status: 422 });
  });
});