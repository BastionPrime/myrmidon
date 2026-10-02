import { describe, expect, it } from "vitest";
import {
  BOT_CONTAINERS_ENV,
  CONTAINER_GROUP_UNSUPPORTED_REASON,
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
      config: { image: "myrmidon-hermes:1.1.0", memoryMb: 1536, cpus: 1, pidsLimit: 256, extraMounts: [] },
    });
  });

  it.each(["team-b", "Not-Lowercase", "", 42])(
    "refuses a shared container.group (%j) as not applicable instead of reconciling it per agent",
    (group) => {
      // A shared container reconciled from each member's own card would be
      // recreated/rewritten by every member and restarted under the others' runs.
      const result = readBotContainerAgentConfig("hermes_gateway", { container: { ...VALID_CONTAINER_CONFIG, group } });
      expect(result).toEqual({ ok: false, reason: CONTAINER_GROUP_UNSUPPORTED_REASON });
    },
  );

  it("treats an explicit null group like no group", () => {
    expect(readBotContainerAgentConfig("hermes_gateway", { container: { ...VALID_CONTAINER_CONFIG, group: null } }).ok).toBe(true);
  });

  it.each([
    { ...VALID_CONTAINER_CONFIG, image: "" },
    { ...VALID_CONTAINER_CONFIG, image: 123 },
    { ...VALID_CONTAINER_CONFIG, memoryMb: 0 },
    { ...VALID_CONTAINER_CONFIG, memoryMb: "1536" },
    { ...VALID_CONTAINER_CONFIG, cpus: -1 },
    { ...VALID_CONTAINER_CONFIG, pidsLimit: 1.5 },
  ])("rejects an invalid container block: %j", (container) => {
    const result = readBotContainerAgentConfig("hermes_gateway", { container });
    expect(result.ok).toBe(false);
  });
});

describe("botKeyForAgent / botContainerSpec", () => {
  it("keys every bot by its own agent id", () => {
    expect(botKeyForAgent("agent-a")).toBe("agent-a");
    expect(botKeyForAgent("3adb3ce4-40a4-4b1e-9c2a-000000000001")).toBe("3adb3ce4-40a4-4b1e-9c2a-000000000001");
  });

  it("returns null for an id that cannot be a bot key", () => {
    expect(botKeyForAgent("Agent_A")).toBeNull();
    expect(botKeyForAgent("../x")).toBeNull();
  });

  it("builds a spec that carries the driver's network through unchanged", () => {
    const spec = botContainerSpec(
      "agent-a",
      { image: "myrmidon-hermes:1.1.0", memoryMb: 1536, cpus: 1, pidsLimit: 256, extraMounts: [] },
      "myrmidon-bots",
    );
    expect(spec).toEqual({
      botKey: "agent-a",
      image: "myrmidon-hermes:1.1.0",
      memoryMb: 1536,
      cpus: 1,
      pidsLimit: 256,
      network: "myrmidon-bots",
      extraMounts: [],
    });
  });

  it("carries the card's extra mounts into the spec", () => {
    const spec = botContainerSpec(
      "agent-a",
      {
        image: "myrmidon-hermes:1.1.0",
        memoryMb: 1536,
        cpus: 1,
        pidsLimit: 256,
        extraMounts: [{ source: "/srv/shared/sources", containerPath: "/srv/shared/sources", readOnly: true }],
      },
      "myrmidon-bots",
    );
    expect(spec.extraMounts).toEqual([
      { source: "/srv/shared/sources", containerPath: "/srv/shared/sources", readOnly: true },
    ]);
  });
});

describe("readBotContainerAgentConfig: container.extraMounts", () => {
  function configWith(extraMounts: unknown) {
    return { container: { ...VALID_CONTAINER_CONFIG, extraMounts } };
  }

  it("reads the allowed entry shape and defaults readOnly to true", () => {
    const result = readBotContainerAgentConfig("hermes_gateway", configWith([{ source: "/srv/shared/sources", path: "/srv/shared/sources" }]));
    expect(result).toEqual({
      ok: true,
      config: {
        image: "myrmidon-hermes:1.1.0",
        memoryMb: 1536,
        cpus: 1,
        pidsLimit: 256,
        extraMounts: [{ source: "/srv/shared/sources", containerPath: "/srv/shared/sources", readOnly: true }],
      },
    });
  });

  it("accepts an explicit readOnly of true and treats a missing list as no extra mounts", () => {
    const explicit = readBotContainerAgentConfig(
      "hermes_gateway",
      configWith([{ source: "/srv/shared/tools", path: "/opt/tools", readOnly: true }]),
    );
    expect(explicit.ok && explicit.config.extraMounts).toEqual([
      { source: "/srv/shared/tools", containerPath: "/opt/tools", readOnly: true },
    ]);
    expect(readBotContainerAgentConfig("hermes_gateway", { container: VALID_CONTAINER_CONFIG }).ok).toBe(true);
  });

  it("refuses a writable extra mount: a shared directory is only mounted read-only", () => {
    const result = readBotContainerAgentConfig(
      "hermes_gateway",
      configWith([{ source: "/srv/shared/sources", path: "/srv/shared/sources", readOnly: false }]),
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("readOnly=false");
  });

  it.each([
    ["not-an-array", { source: "/srv/shared/sources", path: "/x" }],
    ["entry not an object", [42]],
    ["missing source", [{ path: "/srv/shared/sources" }]],
    ["blank source", [{ source: "  ", path: "/srv/shared/sources" }]],
    ["relative path", [{ source: "/srv/shared/sources", path: "srv/shared" }]],
    ["readOnly not a boolean", [{ source: "/srv/shared/sources", path: "/x", readOnly: "yes" }]],
  ])("refuses a malformed list: %s", (_name, extraMounts) => {
    const result = readBotContainerAgentConfig("hermes_gateway", configWith(extraMounts));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("container.extraMounts");
  });
});
