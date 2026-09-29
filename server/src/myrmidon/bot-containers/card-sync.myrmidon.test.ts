import { describe, expect, it } from "vitest";

import {
  BOT_GATEWAY_PORT,
  createBotCardSync,
  gatewayApiBaseUrl,
  planGatewayCardSync,
  type BotCardSyncPorts,
} from "./card-sync.js";
import type { BotProfileAgentRecord } from "./profile-compile.js";

// Placeholder ids only.

const SECRET_ID = "secret-api-server-key-agent-a";
const TARGET = { botKey: "agent-a", apiKeySecretId: SECRET_ID };
const LATEST_REF = { type: "secret_ref", secretId: SECRET_ID, version: "latest" };
const INSECURE_HTTP = "dangerouslyAllowInsecureRemoteHttp";
// myrmidon(H3): the sync owns two connection fields now — the adapter trusts
// the myrmidon-bot-* container name for plain http by itself, so the card the
// sync aims at carries no insecure-http flag.
/** A card that already matches on every field the sync owns. */
const MATCHING_CARD = {
  apiBaseUrl: "http://myrmidon-bot-agent-a:8642",
  apiKey: LATEST_REF,
};

describe("myrmidon(W2a) gatewayApiBaseUrl", () => {
  it("is the container's name on the bot network plus the gateway port", () => {
    expect(BOT_GATEWAY_PORT).toBe(8642);
    expect(gatewayApiBaseUrl("agent-a")).toBe("http://myrmidon-bot-agent-a:8642");
  });
});

describe("myrmidon(W2a) planGatewayCardSync", () => {
  it("fills the two connection fields into an empty card", () => {
    const plan = planGatewayCardSync({ model: "anthropic/claude-sonnet-5" }, TARGET);
    expect(plan.changed).toBe(true);
    expect(plan.changedKeys).toEqual(["apiBaseUrl", "apiKey"]);
    expect(plan.adapterConfig).toEqual({
      model: "anthropic/claude-sonnet-5",
      apiBaseUrl: "http://myrmidon-bot-agent-a:8642",
      apiKey: LATEST_REF,
    });
  });

  // myrmidon(H3), release 1.1.2: the adapter trusts the fleet's own
  // myrmidon-bot-* container names for plain http by itself
  // (transport-security.ts isBotContainerHostname), so the sync writes no
  // escape hatch — the container address passes the adapter's transport
  // check with no flag in the card.
  it("writes no insecure-http flag: the adapter trusts the bot-container name itself", () => {
    const plan = planGatewayCardSync({}, TARGET);
    expect(plan.adapterConfig[INSECURE_HTTP]).toBeUndefined();
    // The address really is a remote plain-http host to the adapter, which is
    // exactly why the adapter-side hostname trust (H3) is what covers it.
    const url = new URL(String(plan.adapterConfig.apiBaseUrl));
    expect(url.protocol).toBe("http:");
    expect(url.hostname).not.toBe("localhost");
    expect(url.hostname).toBe("myrmidon-bot-agent-a");
  });

  // myrmidon(H3): a leftover flag from the pre-H3 wiring is stripped, not
  // kept: while present it widened trust to ANY remote plain-http host.
  it("strips a leftover insecure-http flag from the pre-H3 wiring", () => {
    for (const value of [true, false, "true", "yes", 1, null]) {
      const plan = planGatewayCardSync({ ...MATCHING_CARD, [INSECURE_HTTP]: value }, TARGET);
      expect(plan.changedKeys, JSON.stringify(value)).toEqual([INSECURE_HTTP]);
      expect(plan.adapterConfig[INSECURE_HTTP]).toBeUndefined();
    }
  });

  it("does not mutate the card it was given", () => {
    const card = { model: "anthropic/claude-sonnet-5" };
    planGatewayCardSync(card, TARGET);
    expect(card).toEqual({ model: "anthropic/claude-sonnet-5" });
  });

  it("changes nothing on a card that already matches on every field the sync owns", () => {
    const card = { model: "m", ...MATCHING_CARD };
    const plan = planGatewayCardSync(card, TARGET);
    expect(plan.changed).toBe(false);
    expect(plan.changedKeys).toEqual([]);
    expect(plan.adapterConfig).toEqual(card);
  });

  it("keeps the extra fields of a secret_ref that already points at the right secret", () => {
    const ref = { ...LATEST_REF, projectionClass: "runtime", projectionAllowlistKey: "gateway" };
    const plan = planGatewayCardSync({ ...MATCHING_CARD, apiKey: ref }, TARGET);
    expect(plan.changed).toBe(false);
    expect(plan.adapterConfig.apiKey).toEqual(ref);
  });

  it("replaces a plain-string key a person typed, keeping the rest of the card", () => {
    const plan = planGatewayCardSync({ ...MATCHING_CARD, apiKey: "typed-by-hand", toolsets: "web" }, TARGET);
    expect(plan.changedKeys).toEqual(["apiKey"]);
    expect(plan.adapterConfig).toEqual({ ...MATCHING_CARD, toolsets: "web" });
  });

  it("replaces a ref to another secret and a ref pinned to a version", () => {
    for (const apiKey of [
      { type: "secret_ref", secretId: "some-other-secret", version: "latest" },
      { type: "secret_ref", secretId: SECRET_ID, version: 3 },
      { type: "plain", value: "x" },
    ]) {
      const plan = planGatewayCardSync({ ...MATCHING_CARD, apiKey }, TARGET);
      expect(plan.changedKeys, JSON.stringify(apiKey)).toEqual(["apiKey"]);
      expect(plan.adapterConfig.apiKey).toEqual(LATEST_REF);
    }
  });

  it("replaces an address left over from another deployment", () => {
    const plan = planGatewayCardSync({ ...MATCHING_CARD, apiBaseUrl: "http://old-host.example.com:8642" }, TARGET);
    expect(plan.changedKeys).toEqual(["apiBaseUrl"]);
    expect(plan.adapterConfig.apiBaseUrl).toBe("http://myrmidon-bot-agent-a:8642");
  });
});

function agentRecord(adapterConfig: Record<string, unknown>): BotProfileAgentRecord {
  return {
    id: "agent-a",
    companyId: "company-1",
    name: "Agent A",
    adapterType: "hermes_gateway",
    adapterConfig,
    runtimeConfig: {},
  };
}

function fakePorts(initial: Record<string, unknown> | null) {
  const state = { agent: initial ? agentRecord(initial) : null };
  const saved: Array<Record<string, unknown>> = [];
  const calls: string[] = [];
  const ports: BotCardSyncPorts = {
    async loadAgent() {
      calls.push("loadAgent");
      return state.agent;
    },
    async ensureApiServerKey() {
      calls.push("ensureApiServerKey");
      return { value: "fake-api-server-key-0001", secretId: SECRET_ID };
    },
    async saveAdapterConfig(agent, adapterConfig) {
      calls.push("saveAdapterConfig");
      saved.push(adapterConfig);
      state.agent = { ...agent, adapterConfig };
    },
  };
  return { ports, saved, calls };
}

describe("myrmidon(W2a) createBotCardSync", () => {
  it("writes the card once, then finds nothing left to do", async () => {
    const { ports, saved } = fakePorts({ model: "m", toolsets: "web" });
    const syncCard = createBotCardSync(ports);

    expect(await syncCard("agent-a", "agent-a")).toEqual({ changedKeys: ["apiBaseUrl", "apiKey"] });
    expect(saved).toEqual([{ model: "m", toolsets: "web", ...MATCHING_CARD }]);

    expect(await syncCard("agent-a", "agent-a")).toEqual({ changedKeys: [] });
    expect(saved).toHaveLength(1);
  });

  it("never writes when the card already matches (no config revision per tick)", async () => {
    const { ports, saved, calls } = fakePorts({ ...MATCHING_CARD });
    expect(await createBotCardSync(ports)("agent-a", "agent-a")).toEqual({ changedKeys: [] });
    expect(saved).toEqual([]);
    expect(calls).not.toContain("saveAdapterConfig");
  });

  it("does nothing for an agent that is gone", async () => {
    const { ports, calls } = fakePorts(null);
    expect(await createBotCardSync(ports)("agent-a", "agent-a")).toEqual({ changedKeys: [] });
    expect(calls).toEqual(["loadAgent"]);
  });

  it("reads the card fresh on every call, so it builds on the card as it is now", async () => {
    const { ports, saved } = fakePorts({ model: "m" });
    const syncCard = createBotCardSync(ports);
    await syncCard("agent-a", "agent-a");
    // A person edits another field between two ticks; the next sync starts from that edit.
    const state = await ports.loadAgent("agent-a");
    if (!state) throw new Error("agent vanished");
    await ports.saveAdapterConfig(state, { ...state.adapterConfig, toolsets: "web,terminal", apiKey: "typed-by-hand" });
    expect(await syncCard("agent-a", "agent-a")).toEqual({ changedKeys: ["apiKey"] });
    expect(saved.at(-1)).toMatchObject({ model: "m", toolsets: "web,terminal", apiKey: LATEST_REF });
  });

  it("lets a failing write reach the caller (index.ts records it and keeps the outcome)", async () => {
    const { ports } = fakePorts({});
    ports.saveAdapterConfig = async () => {
      throw new Error("database is read-only");
    };
    await expect(createBotCardSync(ports)("agent-a", "agent-a")).rejects.toThrow("database is read-only");
  });
});
