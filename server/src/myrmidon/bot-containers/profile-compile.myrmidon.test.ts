import { describe, expect, it } from "vitest";

import {
  BOT_BOARD_URL_ENV,
  BOT_HINDSIGHT_API_URL_ENV,
  BOT_HINDSIGHT_BANK_ENV,
  BOT_LLM_API_KEY_ENV_ENV,
  BOT_LLM_API_KEY_SECRET_ENV,
  BOT_LLM_BASE_URL_ENV,
  BotProfileInputError,
} from "./profile-input.js";
import {
  createBotProfileCompile,
  HERMES_GATEWAY_ADAPTER_TYPE,
  type BotProfileAgentRecord,
  type BotProfilePorts,
} from "./profile-compile.js";
import type { CompiledProfile } from "./types.js";

// Placeholder data only: fake ids, example.com URLs, obviously-fake secrets.

const INSTANCE_ENV: NodeJS.ProcessEnv = {
  [BOT_HINDSIGHT_API_URL_ENV]: "https://example.com/hindsight",
  [BOT_HINDSIGHT_BANK_ENV]: "fleet-default",
  [BOT_LLM_BASE_URL_ENV]: "https://example.com/llm/v1",
  [BOT_LLM_API_KEY_ENV_ENV]: "FLEET_LLM_API_KEY",
  [BOT_BOARD_URL_ENV]: "http://board.example.com:3100",
};

function agentRecord(overrides: Partial<BotProfileAgentRecord> = {}): BotProfileAgentRecord {
  return {
    id: "agent-a",
    companyId: "company-1",
    name: "Agent A",
    adapterType: HERMES_GATEWAY_ADAPTER_TYPE,
    adapterConfig: { model: "anthropic/claude-sonnet-5", provider: "anthropic" },
    runtimeConfig: { heartbeat: { maxConcurrentRuns: 2 } },
    ...overrides,
  };
}

interface FakeBoard {
  ports: BotProfilePorts;
  calls: string[];
  secrets: Map<string, string>;
  agent: { current: BotProfileAgentRecord | null };
}

/** In-memory board: get-or-create secrets by deterministic name, like profile-ports.ts. */
function fakeBoard(overrides: Partial<BotProfilePorts> = {}): FakeBoard {
  const calls: string[] = [];
  const secrets = new Map<string, string>([["FLEET_LLM_API_KEY", "fake-llm-key-0001"]]);
  const agent = { current: agentRecord() as BotProfileAgentRecord | null };
  const ports: BotProfilePorts = {
    async loadAgent() {
      calls.push("loadAgent");
      return agent.current;
    },
    async resolveCardEnv() {
      calls.push("resolveCardEnv");
      return { env: {}, warnings: [] };
    },
    async readCompanySecret(_companyId, name) {
      calls.push(`readCompanySecret:${name}`);
      return secrets.get(name) ?? null;
    },
    async ensureApiServerKey(record) {
      calls.push("ensureApiServerKey");
      const name = `api-server-key-${record.id}`;
      if (!secrets.has(name)) secrets.set(name, `fake-api-server-key-${secrets.size}`);
      return { value: secrets.get(name) as string, secretId: `secret-${name}` };
    },
    async ensureAgentApiKey(record) {
      calls.push("ensureAgentApiKey");
      const name = `agent-api-key-${record.id}`;
      if (!secrets.has(name)) secrets.set(name, `fake-paperclip-api-key-${secrets.size}`);
      return { value: secrets.get(name) as string };
    },
    async loadSkills() {
      calls.push("loadSkills");
      return { skills: {}, warnings: [] };
    },
    async loadInstructions() {
      calls.push("loadInstructions");
      return "# Role\n\nYou are agent-a.\n";
    },
    ...overrides,
  };
  return { ports, calls, secrets, agent };
}

function fileContent(profile: CompiledProfile, path: string): string {
  const found = profile.files.find((file) => file.path === path);
  if (!found) throw new Error(`no compiled file at ${path}`);
  return found.content;
}

describe("myrmidon(W2a) createBotProfileCompile", () => {
  it("compiles a card into the profile files, credentials in .env only", async () => {
    const board = fakeBoard();
    const compile = createBotProfileCompile(board.ports, { env: INSTANCE_ENV });
    const profile = await compile("agent-a", "agent-a");

    expect(profile.botKey).toBe("agent-a");
    expect(profile.files.map((file) => file.path).sort()).toEqual([
      "hermes/.env",
      "hermes/config.yaml",
      "hermes/hindsight/config.json",
      "workspace/AGENTS.md",
    ]);
    const env = fileContent(profile, "hermes/.env");
    expect(env).toContain('FLEET_LLM_API_KEY="fake-llm-key-0001"');
    expect(env).toContain('PAPERCLIP_API_URL="http://board.example.com:3100"');
    expect(env).toMatch(/API_SERVER_KEY="fake-api-server-key-\d+"/);
    expect(env).toMatch(/PAPERCLIP_API_KEY="fake-paperclip-api-key-\d+"/);
    expect(fileContent(profile, "hermes/config.yaml")).not.toContain("fake-llm-key-0001");
    expect(fileContent(profile, "hermes/hindsight/config.json")).toContain("fleet-default");
    expect(fileContent(profile, "workspace/AGENTS.md")).toContain("You are agent-a.");
  });

  it("is idempotent: a second tick with nothing changed gives the same hashes", async () => {
    const board = fakeBoard();
    const compile = createBotProfileCompile(board.ports, { env: INSTANCE_ENV });
    const first = await compile("agent-a", "agent-a");
    const second = await compile("agent-a", "agent-a");
    expect(second.restartHash).toBe(first.restartHash);
    expect(second.filesHash).toBe(first.filesHash);
    expect(board.secrets.size).toBe(3); // the LLM key plus the two per-bot secrets, created once
  });

  it("puts the company's skills, MCP servers and instance defaults through to the profile", async () => {
    const board = fakeBoard({
      async loadSkills() {
        return { skills: { "code-review": [{ path: "SKILL.md", content: "# Code review\n" }] }, warnings: [] };
      },
      async listMcpServers() {
        return [{ name: "board", url: "https://example.com/api/mcp/gateway/abc", token: "fake-mcp-token-0001" }];
      },
    });
    const profile = await createBotProfileCompile(board.ports, { env: INSTANCE_ENV })("agent-a", "agent-a");
    expect(profile.files.some((file) => file.path.includes("code-review") && file.path.endsWith("SKILL.md"))).toBe(true);
    expect(fileContent(profile, "hermes/config.yaml")).toContain("Bearer ${MYRMIDON_MCP_TOKEN_BOARD}");
    expect(fileContent(profile, "hermes/.env")).toContain('MYRMIDON_MCP_TOKEN_BOARD="fake-mcp-token-0001"');
  });

  it("asks the company secret for the LLM key only when the card's own env lacks it", async () => {
    const withCardKey = fakeBoard({
      async resolveCardEnv() {
        return { env: { FLEET_LLM_API_KEY: { value: "fake-card-key", secret: true } }, warnings: [] };
      },
    });
    const profile = await createBotProfileCompile(withCardKey.ports, { env: INSTANCE_ENV })("agent-a", "agent-a");
    expect(withCardKey.calls.some((call) => call.startsWith("readCompanySecret"))).toBe(false);
    expect(fileContent(profile, "hermes/.env")).toContain('FLEET_LLM_API_KEY="fake-card-key"');

    const fromSecret = fakeBoard();
    await createBotProfileCompile(fromSecret.ports, { env: INSTANCE_ENV })("agent-a", "agent-a");
    expect(fromSecret.calls).toContain("readCompanySecret:FLEET_LLM_API_KEY");
  });

  it("reads the company secret named by MYRMIDON_BOT_LLM_API_KEY_SECRET", async () => {
    const board = fakeBoard();
    board.secrets.set("fleet-llm-gateway-key", "fake-gateway-secret-0002");
    const profile = await createBotProfileCompile(board.ports, {
      env: { ...INSTANCE_ENV, [BOT_LLM_API_KEY_SECRET_ENV]: "fleet-llm-gateway-key" },
    })("agent-a", "agent-a");
    expect(board.calls).toContain("readCompanySecret:fleet-llm-gateway-key");
    expect(fileContent(profile, "hermes/.env")).toContain('FLEET_LLM_API_KEY="fake-gateway-secret-0002"');
  });

  it("a rotated secret changes the restart hash: the next tick restarts the bot", async () => {
    const board = fakeBoard();
    const compile = createBotProfileCompile(board.ports, { env: INSTANCE_ENV });
    const before = await compile("agent-a", "agent-a");
    board.secrets.set("FLEET_LLM_API_KEY", "fake-llm-key-0002");
    const after = await compile("agent-a", "agent-a");
    expect(after.restartHash).not.toBe(before.restartHash);
  });

  it("reads the instance settings on every call, so a corrected variable needs no rebuild", async () => {
    const board = fakeBoard();
    const env: NodeJS.ProcessEnv = { ...INSTANCE_ENV };
    const compile = createBotProfileCompile(board.ports, { env });
    const first = await compile("agent-a", "agent-a");
    env[BOT_HINDSIGHT_BANK_ENV] = "fleet-other";
    const second = await compile("agent-a", "agent-a");
    expect(fileContent(second, "hermes/hindsight/config.json")).toContain("fleet-other");
    expect(second.restartHash).not.toBe(first.restartHash);
  });

  describe("failures", () => {
    it("fails before it looks anything up or creates any secret when the instance is unconfigured", async () => {
      const board = fakeBoard();
      const withoutHindsight: NodeJS.ProcessEnv = { ...INSTANCE_ENV, [BOT_HINDSIGHT_API_URL_ENV]: undefined };
      await expect(createBotProfileCompile(board.ports, { env: withoutHindsight })("agent-a", "agent-a")).rejects.toThrow(
        BOT_HINDSIGHT_API_URL_ENV,
      );
      expect(board.calls).toEqual([]);
      expect(board.secrets.size).toBe(1);
    });

    it("fails when the agent no longer exists", async () => {
      const board = fakeBoard();
      board.agent.current = null;
      const compile = createBotProfileCompile(board.ports, { env: INSTANCE_ENV });
      await expect(compile("agent-a", "agent-a")).rejects.toThrow(BotProfileInputError);
      await expect(compile("agent-a", "agent-a")).rejects.toThrow("no longer exists");
      expect(board.calls).not.toContain("ensureApiServerKey");
    });

    it("fails, creating no secret, when the agent is not a hermes_gateway agent", async () => {
      const board = fakeBoard();
      board.agent.current = agentRecord({ adapterType: "hermes_local" });
      await expect(createBotProfileCompile(board.ports, { env: INSTANCE_ENV })("agent-a", "agent-a")).rejects.toThrow(
        HERMES_GATEWAY_ADAPTER_TYPE,
      );
      expect(board.calls).toEqual(["loadAgent"]);
    });

    it("fails closed when the LLM key exists nowhere, naming the secret", async () => {
      const board = fakeBoard();
      board.secrets.delete("FLEET_LLM_API_KEY");
      await expect(createBotProfileCompile(board.ports, { env: INSTANCE_ENV })("agent-a", "agent-a")).rejects.toThrow(
        "FLEET_LLM_API_KEY",
      );
    });

    it("propagates a failing port instead of compiling a partial profile", async () => {
      const board = fakeBoard({
        async loadInstructions() {
          throw new Error("instructions bundle unreadable");
        },
      });
      await expect(createBotProfileCompile(board.ports, { env: INSTANCE_ENV })("agent-a", "agent-a")).rejects.toThrow(
        "instructions bundle unreadable",
      );
    });
  });

  describe("warnings", () => {
    const warningEnv = { HINT: { value: "has ${REFERENCE} in it", secret: false } };

    it("reports the port and compiler warnings once, not on every tick", async () => {
      const board = fakeBoard({
        async resolveCardEnv() {
          return { env: warningEnv, warnings: ["env.OTHER: dropped, secret is missing"] };
        },
      });
      const reported: Array<{ botKey: string; warnings: readonly string[] }> = [];
      const compile = createBotProfileCompile(board.ports, {
        env: INSTANCE_ENV,
        onWarnings: (botKey, warnings) => {
          reported.push({ botKey, warnings });
        },
      });
      await compile("agent-a", "agent-a");
      await compile("agent-a", "agent-a");
      await compile("agent-a", "agent-a");
      expect(reported).toHaveLength(1);
      expect(reported[0]?.botKey).toBe("agent-a");
      expect(reported[0]?.warnings[0]).toBe("env.OTHER: dropped, secret is missing");
      expect(reported[0]?.warnings.length).toBeGreaterThan(1);
    });

    it("reports again when the set of warnings changes", async () => {
      let warnings = ["env.OTHER: dropped"];
      const board = fakeBoard({
        async resolveCardEnv() {
          return { env: {}, warnings };
        },
      });
      const reported: string[][] = [];
      const compile = createBotProfileCompile(board.ports, {
        env: INSTANCE_ENV,
        onWarnings: (_botKey, list) => {
          reported.push([...list]);
        },
      });
      await compile("agent-a", "agent-a");
      warnings = ["env.OTHER: dropped", "env.THIRD: dropped"];
      await compile("agent-a", "agent-a");
      await compile("agent-a", "agent-a");
      expect(reported).toEqual([["env.OTHER: dropped"], ["env.OTHER: dropped", "env.THIRD: dropped"]]);
    });

    it("tracks warnings per bot", async () => {
      const board = fakeBoard({
        async resolveCardEnv() {
          return { env: {}, warnings: ["env.OTHER: dropped"] };
        },
      });
      const reported: string[] = [];
      const compile = createBotProfileCompile(board.ports, {
        env: INSTANCE_ENV,
        onWarnings: (botKey) => {
          reported.push(botKey);
        },
      });
      await compile("agent-a", "agent-a");
      await compile("agent-a", "agent-a");
      await compile("agent-b", "agent-b");
      expect(reported).toEqual(["agent-a", "agent-b"]);
    });

    it("says nothing when there is nothing to say, and never fails a compile over a broken sink", async () => {
      const quiet = fakeBoard();
      const reported: string[] = [];
      await createBotProfileCompile(quiet.ports, {
        env: INSTANCE_ENV,
        onWarnings: (botKey) => {
          reported.push(botKey);
        },
      })("agent-a", "agent-a");
      expect(reported).toEqual([]);

      const noisy = fakeBoard({
        async resolveCardEnv() {
          return { env: {}, warnings: ["env.OTHER: dropped"] };
        },
      });
      const profile = await createBotProfileCompile(noisy.ports, {
        env: INSTANCE_ENV,
        onWarnings: () => {
          throw new Error("sink is down");
        },
      })("agent-a", "agent-a");
      expect(profile.botKey).toBe("agent-a");
    });
  });
});
