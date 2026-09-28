import { describe, expect, it } from "vitest";
import {
  BOT_CONTAINERS_ENV,
  botContainerSpec,
  botKeyForAgent,
  isBotContainersEnabled,
  readBotContainerAgentConfig,
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
