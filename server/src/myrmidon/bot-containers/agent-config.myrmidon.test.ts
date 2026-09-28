import { describe, expect, it } from "vitest";
import {
  BOT_CONTAINERS_ENV,
  botContainerConfigsMatch,
  botContainerSpec,
  botKeyForAgent,
  groupByBotKey,
  isBotContainersEnabled,
  pickCanonicalGroupMember,
  readBotContainerAgentConfig,
  type BotContainerAgentConfig,
} from "./agent-config.js";

describe("isBotContainersEnabled", () => {
  it("is off unless explicitly enabled", () => {
    expect(isBotContainersEnabled({})).toBe(false);
    expect(isBotContainersEnabled({ [BOT_CONTAINERS_ENV]: "false" })).toBe(false);
    expect(isBotContainersEnabled({ [BOT_CONTAINERS_ENV]: "0" })).toBe(false);
  });

  it.each(["1", "true", "TRUE", "yes", "on"])("accepts %j", (value) => {
    expect(isBotContainersEnabled({ [BOT_CONTAINERS_ENV]: value })).toBe(true);
  });
});

const VALID_CONTAINER_CONFIG = {
  enabled: true,
  image: "myrmidon-hermes:1.1.0",
  memoryMb: 1536,
  cpus: 1,
  pidsLimit: 256,
};

describe("readBotContainerAgentConfig", () => {
  it("is not applicable to any adapter type other than hermes_gateway", () => {
    const result = readBotContainerAgentConfig("process", { container: VALID_CONTAINER_CONFIG });
    expect(result.ok).toBe(false);
  });

  it("is not applicable when container.enabled is not true", () => {
    expect(readBotContainerAgentConfig("hermes_gateway", {}).ok).toBe(false);
    expect(
      readBotContainerAgentConfig("hermes_gateway", { container: { ...VALID_CONTAINER_CONFIG, enabled: false } }).ok,
    ).toBe(false);
  });

  it("parses a valid config for a hermes_gateway agent", () => {
    const result = readBotContainerAgentConfig("hermes_gateway", { container: VALID_CONTAINER_CONFIG });
    expect(result).toEqual({
      ok: true,
      config: { group: undefined, image: "myrmidon-hermes:1.1.0", memoryMb: 1536, cpus: 1, pidsLimit: 256 },
    });
  });

  it("accepts an optional group for a shared project container", () => {
    const result = readBotContainerAgentConfig("hermes_gateway", {
      container: { ...VALID_CONTAINER_CONFIG, group: "team-b" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.group).toBe("team-b");
  });

  it.each([
    { ...VALID_CONTAINER_CONFIG, image: "" },
    { ...VALID_CONTAINER_CONFIG, image: 123 },
    { ...VALID_CONTAINER_CONFIG, memoryMb: 0 },
    { ...VALID_CONTAINER_CONFIG, memoryMb: "1536" },
    { ...VALID_CONTAINER_CONFIG, cpus: -1 },
    { ...VALID_CONTAINER_CONFIG, pidsLimit: 1.5 },
    { ...VALID_CONTAINER_CONFIG, group: "Not-Lowercase" },
    { ...VALID_CONTAINER_CONFIG, group: "has spaces" },
  ])("rejects an invalid container block: %j", (container) => {
    const result = readBotContainerAgentConfig("hermes_gateway", { container });
    expect(result.ok).toBe(false);
  });
});

describe("botKeyForAgent / botContainerSpec", () => {
  it("defaults the bot key to the agent id, and uses the group when set", () => {
    expect(botKeyForAgent("agent-a", { image: "x", memoryMb: 1, cpus: 1, pidsLimit: 1 })).toBe("agent-a");
    expect(botKeyForAgent("agent-a", { group: "team-b", image: "x", memoryMb: 1, cpus: 1, pidsLimit: 1 })).toBe("team-b");
  });

  it("builds a spec that carries the driver's network through unchanged", () => {
    const spec = botContainerSpec("agent-a", { image: "myrmidon-hermes:1.1.0", memoryMb: 1536, cpus: 1, pidsLimit: 256 }, "myrmidon-bots");
    expect(spec).toEqual({
      botKey: "agent-a",
      image: "myrmidon-hermes:1.1.0",
      memoryMb: 1536,
      cpus: 1,
      pidsLimit: 256,
      network: "myrmidon-bots",
    });
  });
});

describe("botContainerConfigsMatch", () => {
  function config(overrides: Partial<BotContainerAgentConfig> = {}): BotContainerAgentConfig {
    return { image: "myrmidon-hermes:1.1.0", memoryMb: 512, cpus: 1, pidsLimit: 128, ...overrides };
  }

  it("is true for two configs with identical image/memoryMb/cpus/pidsLimit", () => {
    expect(botContainerConfigsMatch(config(), config())).toBe(true);
  });

  it("ignores `group` — two configs in the same group with different group spellings still match on template", () => {
    expect(botContainerConfigsMatch(config({ group: "team-a" }), config({ group: "team-b" }))).toBe(true);
  });

  it.each([
    { image: "myrmidon-hermes:1.2.0" },
    { memoryMb: 1024 },
    { cpus: 2 },
    { pidsLimit: 256 },
  ])("is false when %j differs", (overrides) => {
    expect(botContainerConfigsMatch(config(), config(overrides))).toBe(false);
  });
});

describe("groupByBotKey / pickCanonicalGroupMember", () => {
  interface FakeAgent {
    agentId: string;
  }

  function member(agentId: string, config: Partial<BotContainerAgentConfig> = {}): { agent: FakeAgent; config: BotContainerAgentConfig } {
    return {
      agent: { agentId },
      config: { image: "myrmidon-hermes:1.1.0", memoryMb: 512, cpus: 1, pidsLimit: 128, ...config },
    };
  }

  it("groups agents with the same resolved botKey (shared container.group) together, and keeps unrelated agents in their own singleton groups", () => {
    const groups = groupByBotKey([
      member("agent-a", { group: "team-b" }),
      member("agent-c"), // no group: keyed by its own agentId
      member("agent-b", { group: "team-b" }),
    ]);
    expect([...groups.keys()].sort()).toEqual(["agent-c", "team-b"]);
    expect(groups.get("team-b")?.map((m) => m.agent.agentId).sort()).toEqual(["agent-a", "agent-b"]);
    expect(groups.get("agent-c")?.map((m) => m.agent.agentId)).toEqual(["agent-c"]);
  });

  it("picks the member whose agentId sorts first, regardless of input order", () => {
    const membersInOrderB = [member("agent-b", { group: "g" }), member("agent-a", { group: "g" })];
    const membersInOrderA = [member("agent-a", { group: "g" }), member("agent-b", { group: "g" })];
    expect(pickCanonicalGroupMember(membersInOrderB).agent.agentId).toBe("agent-a");
    expect(pickCanonicalGroupMember(membersInOrderA).agent.agentId).toBe("agent-a");
  });

  it("is a no-op for a group of one", () => {
    const solo = member("agent-a", { group: "g" });
    expect(pickCanonicalGroupMember([solo])).toBe(solo);
  });
});
