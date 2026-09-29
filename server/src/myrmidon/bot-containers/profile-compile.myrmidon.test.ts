import { describe, expect, it } from "vitest";

import {
  BOT_BOARD_URL_ENV,
  BOT_HINDSIGHT_API_URL_ENV,
  BOT_HINDSIGHT_BANK_ENV,
  BOT_LLM_API_KEY_ENV_ENV,
  BOT_LLM_API_KEY_SECRET_ENV,
  BOT_LLM_BASE_URL_ENV,
  BOT_MCP_SERVERS_ENV,
  BOT_RUNTIME_MCP_URL_BASE_ENV,
  BotProfileInputError,
} from "./profile-input.js";
import {
  createActivityWarningSink,
  createBotProfileCompile,
  HERMES_GATEWAY_ADAPTER_TYPE,
  NO_BOARD_GATEWAY_WARNING,
  type BotProfileAgentRecord,
  type BotProfilePorts,
} from "./profile-compile.js";
import { classifyProfileChange, type CompiledProfile } from "./types.js";

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
      return { files: [], warnings: [] };
    },
    // A quiet board: the gateway port is present (and has nothing to hand out), so the
    // "no board gateway" warning is not raised; the tests that want it override this.
    async listMcpServers() {
      calls.push("listMcpServers");
      return [];
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
    ]);
    const env = fileContent(profile, "hermes/.env");
    expect(env).toContain('FLEET_LLM_API_KEY="fake-llm-key-0001"');
    expect(env).toContain('PAPERCLIP_API_URL="http://board.example.com:3100"');
    expect(env).toMatch(/API_SERVER_KEY="fake-api-server-key-\d+"/);
    expect(env).toMatch(/PAPERCLIP_API_KEY="fake-paperclip-api-key-\d+"/);
    expect(fileContent(profile, "hermes/config.yaml")).not.toContain("fake-llm-key-0001");
    expect(fileContent(profile, "hermes/hindsight/config.json")).toContain("fleet-default");
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

  describe("instance-wide MCP servers (MYRMIDON_BOT_MCP_SERVERS)", () => {
    const RAGFLOW = [{ name: "ragflow", url: "https://example.com/ragflow/mcp", tokenSecret: "fleet-ragflow-token" }];
    const withMcp = (servers: unknown): NodeJS.ProcessEnv => ({
      ...INSTANCE_ENV,
      [BOT_MCP_SERVERS_ENV]: JSON.stringify(servers),
    });

    it("gives every bot the declared server: header in config.yaml, token in .env, read from the company secret", async () => {
      const board = fakeBoard();
      board.secrets.set("fleet-ragflow-token", "fake-ragflow-token-0001");
      const profile = await createBotProfileCompile(board.ports, { env: withMcp(RAGFLOW) })("agent-a", "agent-a");
      const config = fileContent(profile, "hermes/config.yaml");
      expect(config).toContain("ragflow:");
      expect(config).toContain("https://example.com/ragflow/mcp");
      expect(config).toContain("Bearer ${MYRMIDON_MCP_TOKEN_RAGFLOW}");
      expect(config).not.toContain("fake-ragflow-token-0001");
      expect(fileContent(profile, "hermes/.env")).toContain('MYRMIDON_MCP_TOKEN_RAGFLOW="fake-ragflow-token-0001"');
      expect(board.calls).toContain("readCompanySecret:fleet-ragflow-token");
    });

    it("keeps the declared URL as given: the board-gateway origin rewrite is not for it", async () => {
      const board = fakeBoard();
      board.secrets.set("fleet-ragflow-token", "fake-ragflow-token-0001");
      const profile = await createBotProfileCompile(board.ports, {
        env: { ...withMcp(RAGFLOW), [BOT_RUNTIME_MCP_URL_BASE_ENV]: "http://board.example.com:3100" },
      })("agent-a", "agent-a");
      expect(fileContent(profile, "hermes/config.yaml")).toContain("https://example.com/ragflow/mcp");
      expect(fileContent(profile, "hermes/config.yaml")).not.toContain("board.example.com:3100/ragflow");
    });

    it("honors a custom header and a raw (scheme-less) token", async () => {
      const board = fakeBoard();
      board.secrets.set("fleet-ragflow-token", "fake-ragflow-token-0001");
      const profile = await createBotProfileCompile(board.ports, {
        env: withMcp([{ ...RAGFLOW[0], header: "X-Api-Key", scheme: "" }]),
      })("agent-a", "agent-a");
      const config = fileContent(profile, "hermes/config.yaml");
      expect(config).toContain('X-Api-Key: "${MYRMIDON_MCP_TOKEN_RAGFLOW}"');
      expect(config).not.toContain("Bearer");
      expect(config).not.toContain("Authorization");
    });

    it("passes a server that takes no token, with no header and no .env variable", async () => {
      const board = fakeBoard();
      const profile = await createBotProfileCompile(board.ports, {
        env: withMcp([{ name: "docs", url: "https://example.com/docs/mcp", noAuth: true }]),
      })("agent-a", "agent-a");
      expect(fileContent(profile, "hermes/config.yaml")).toContain("https://example.com/docs/mcp");
      expect(fileContent(profile, "hermes/config.yaml")).not.toContain("headers");
      expect(fileContent(profile, "hermes/.env")).not.toContain("MYRMIDON_MCP_TOKEN_DOCS");
      expect(board.calls.filter((call) => call.startsWith("readCompanySecret"))).toEqual(["readCompanySecret:FLEET_LLM_API_KEY"]);
    });

    it("fails loudly, creating nothing, when the token's company secret is missing", async () => {
      const board = fakeBoard();
      const secretsBefore = board.secrets.size;
      const compile = createBotProfileCompile(board.ports, { env: withMcp(RAGFLOW) });
      await expect(compile("agent-a", "agent-a")).rejects.toThrow(BotProfileInputError);
      await expect(compile("agent-a", "agent-a")).rejects.toThrow("fleet-ragflow-token");
      expect(board.calls).not.toContain("ensureApiServerKey");
      expect(board.calls).not.toContain("ensureAgentApiKey");
      expect(board.secrets.size).toBe(secretsBefore);
    });

    it("fails loudly when the secret exists but is empty", async () => {
      const board = fakeBoard();
      board.secrets.set("fleet-ragflow-token", "   ");
      await expect(createBotProfileCompile(board.ports, { env: withMcp(RAGFLOW) })("agent-a", "agent-a")).rejects.toThrow(
        "missing or empty",
      );
    });

    it("fails before any lookup on a broken declaration, naming the setting and never a value", async () => {
      for (const raw of ["not json", "{}", JSON.stringify([{ name: "ragflow", url: "https://example.com/mcp" }])]) {
        const board = fakeBoard();
        const compile = createBotProfileCompile(board.ports, { env: { ...INSTANCE_ENV, [BOT_MCP_SERVERS_ENV]: raw } });
        await expect(compile("agent-a", "agent-a")).rejects.toThrow(BOT_MCP_SERVERS_ENV);
        expect(board.calls).toEqual([]);
      }
    });

    it("puts the declared servers ahead of the gateway port's: a same-named one loses, with a warning", async () => {
      const board = fakeBoard({
        async listMcpServers() {
          return [
            { name: "ragflow", url: "https://example.com/other/mcp", token: "fake-other-token" },
            { name: "board", url: "https://example.com/api/mcp/gateway/abc", token: "fake-mcp-token-0001" },
          ];
        },
      });
      board.secrets.set("fleet-ragflow-token", "fake-ragflow-token-0001");
      const reported: string[][] = [];
      const profile = await createBotProfileCompile(board.ports, {
        env: withMcp(RAGFLOW),
        onWarnings: (_botKey, warnings) => {
          reported.push([...warnings]);
        },
      })("agent-a", "agent-a");
      const config = fileContent(profile, "hermes/config.yaml");
      expect(config).toContain("https://example.com/ragflow/mcp");
      expect(config).not.toContain("https://example.com/other/mcp");
      expect(config).toContain("board:");
      expect(reported.flat().some((warning) => warning.includes("ragflow") && warning.includes("duplicate"))).toBe(true);
    });

    it("is stable across ticks", async () => {
      const board = fakeBoard();
      board.secrets.set("fleet-ragflow-token", "fake-ragflow-token-0001");
      const compile = createBotProfileCompile(board.ports, { env: withMcp(RAGFLOW) });
      const first = await compile("agent-a", "agent-a");
      const second = await compile("agent-a", "agent-a");
      expect(second.restartHash).toBe(first.restartHash);
    });
  });

  describe("the board tool gateway", () => {
    it("says so in the warnings while the gateway port is not provided", async () => {
      const board = fakeBoard({ listMcpServers: undefined });
      const reported: string[][] = [];
      await createBotProfileCompile(board.ports, {
        env: INSTANCE_ENV,
        onWarnings: (_botKey, warnings) => {
          reported.push([...warnings]);
        },
      })("agent-a", "agent-a");
      expect(reported).toHaveLength(1);
      expect(reported[0]).toContain(NO_BOARD_GATEWAY_WARNING);
    });

    it("stays quiet once the port is provided", async () => {
      const board = fakeBoard();
      const reported: string[][] = [];
      await createBotProfileCompile(board.ports, {
        env: INSTANCE_ENV,
        onWarnings: (_botKey, warnings) => {
          reported.push([...warnings]);
        },
      })("agent-a", "agent-a");
      expect(reported).toEqual([]);
    });

    it("reaches the activity log as one info entry per change, carrying the agent and bot", async () => {
      const board = fakeBoard({ listMcpServers: undefined });
      const entries: Array<Record<string, unknown>> = [];
      const compile = createBotProfileCompile(board.ports, {
        env: INSTANCE_ENV,
        onWarnings: createActivityWarningSink({
          record(entry) {
            entries.push(entry);
          },
        }),
      });
      await compile("agent-a", "bot-a");
      await compile("agent-a", "bot-a");
      expect(entries).toEqual([
        {
          level: "info",
          agentId: "agent-a",
          botKey: "bot-a",
          message: "bot profile warnings",
          details: { warnings: [NO_BOARD_GATEWAY_WARNING] },
        },
      ]);
    });

    it("carries the instructions bundle's and the board key's warnings too", async () => {
      const board = fakeBoard({
        async loadInstructions() {
          return { files: [], warnings: ["instructions bundle: big.md is larger than 262144 bytes, skipped"] };
        },
        async ensureAgentApiKey() {
          return { value: "fake-paperclip-api-key-0001", warnings: ["board API key key-1: replaced by a new key, revoke failed (x)"] };
        },
      });
      const reported: string[][] = [];
      await createBotProfileCompile(board.ports, {
        env: INSTANCE_ENV,
        onWarnings: (_botKey, warnings) => {
          reported.push([...warnings]);
        },
      })("agent-a", "agent-a");
      expect(reported.flat()).toEqual(
        expect.arrayContaining([
          "instructions bundle: big.md is larger than 262144 bytes, skipped",
          "board API key key-1: replaced by a new key, revoke failed (x)",
        ]),
      );
    });
  });

  describe("instructions: not compiled into the workspace", () => {
    const CARD_MARKER = "CARD-MARKER-91be";
    // What tripped the gateway's injection scan on real bundles: a curl example that names a key variable.
    const CURL_EXAMPLE = 'Post it with: curl -X POST -H "Authorization: Bearer $PAPERCLIP_API_KEY" https://example.com/api/comments';

    function occurrences(profile: CompiledProfile, marker: string): string[] {
      return profile.files.filter((file) => file.content.includes(marker)).map((file) => file.path);
    }

    it("writes no AGENTS.md and carries no instruction text into the profile: the run request delivers it", async () => {
      const board = fakeBoard();
      board.agent.current = agentRecord({
        adapterConfig: { model: "anthropic/claude-sonnet-5", provider: "anthropic", instructions: `Stay polite. ${CARD_MARKER}` },
      });
      const profile = await createBotProfileCompile(board.ports, { env: INSTANCE_ENV })("agent-a", "agent-a");
      expect(occurrences(profile, CARD_MARKER)).toEqual([]);
      expect(profile.files.filter((file) => file.path.toLowerCase().endsWith("agents.md"))).toEqual([]);
    });

    it("cannot be blinded by an instruction text the gateway's injection scan would block", async () => {
      const board = fakeBoard();
      board.agent.current = agentRecord({
        adapterConfig: {
          model: "anthropic/claude-sonnet-5",
          provider: "anthropic",
          instructions: `Report through the board. ${CURL_EXAMPLE}`,
          payloadTemplate: { instructions: CURL_EXAMPLE },
        },
      });
      const profile = await createBotProfileCompile(board.ports, { env: INSTANCE_ENV })("agent-a", "agent-a");
      // No file the gateway loads as project context: nothing for the scanner to replace with a stub.
      expect(occurrences(profile, "curl")).toEqual([]);
      expect(profile.files.filter((file) => file.path.startsWith("workspace/"))).toEqual([]);
    });

    it("does not read the card's instructions at all: the same profile whatever they say", async () => {
      const compileWith = async (instructions: string) => {
        const board = fakeBoard();
        board.agent.current = agentRecord({ adapterConfig: { model: "anthropic/claude-sonnet-5", provider: "anthropic", instructions } });
        return createBotProfileCompile(board.ports, { env: INSTANCE_ENV })("agent-a", "agent-a");
      };
      const one = await compileWith("First version.");
      const two = await compileWith("Second version, quite different.");
      expect(two.restartHash).toBe(one.restartHash);
      expect(two.filesHash).toBe(one.filesHash);
    });
  });

  describe("instructions bundle files", () => {
    const bundle = {
      files: [
        { path: "HEARTBEAT.md", content: "# Heartbeat\n" },
        { path: "SOUL.md", content: "# Soul\n" },
        { path: "docs/style.md", content: "# Style\n" },
      ],
      warnings: [] as string[],
    };

    it("places the bundle's files into the workspace under their relative paths, and no AGENTS.md", async () => {
      const board = fakeBoard({
        async loadInstructions() {
          return bundle;
        },
      });
      const profile = await createBotProfileCompile(board.ports, { env: INSTANCE_ENV })("agent-a", "agent-a");
      const workspacePaths = profile.files.map((file) => file.path).filter((path) => path.startsWith("workspace/"));
      expect(workspacePaths.sort()).toEqual([
        "workspace/HEARTBEAT.md",
        "workspace/SOUL.md",
        "workspace/docs/style.md",
      ]);
      expect(fileContent(profile, "workspace/HEARTBEAT.md")).toBe("# Heartbeat\n");
      expect(fileContent(profile, "workspace/docs/style.md")).toBe("# Style\n");
    });

    it("drops a file the gateway would load as project context, with a warning, and keeps the rest", async () => {
      const board = fakeBoard({
        async loadInstructions() {
          return {
            files: [
              { path: "CLAUDE.md", content: "# Impostor\n" },
              { path: "docs/AGENTS.md", content: "# Impostor\n" },
              { path: "SOUL.md", content: "# Soul\n" },
            ],
            warnings: [],
          };
        },
      });
      const reported: string[][] = [];
      const profile = await createBotProfileCompile(board.ports, {
        env: INSTANCE_ENV,
        onWarnings: (_botKey, warnings) => {
          reported.push([...warnings]);
        },
      })("agent-a", "agent-a");
      expect(profile.files.map((file) => file.path).filter((path) => path.startsWith("workspace/"))).toEqual(["workspace/SOUL.md"]);
      expect(reported.flat().filter((warning) => warning.includes("project context"))).toHaveLength(2);
    });

    it("treats an edit of a sibling as a files-class change: applied without a restart", async () => {
      let files = bundle.files;
      const board = fakeBoard({
        async loadInstructions() {
          return { ...bundle, files };
        },
      });
      const compile = createBotProfileCompile(board.ports, { env: INSTANCE_ENV });
      const before = await compile("agent-a", "agent-a");
      files = files.map((file) => (file.path === "SOUL.md" ? { ...file, content: "# Soul, edited\n" } : file));
      const after = await compile("agent-a", "agent-a");
      expect(after.restartHash).toBe(before.restartHash);
      expect(after.filesHash).not.toBe(before.filesHash);
      expect(classifyProfileChange({ restartHash: before.restartHash, filesHash: before.filesHash }, after)).toBe("files");
    });

    it("counts a removed sibling as a change too, and an unchanged bundle as none", async () => {
      let files = bundle.files;
      const board = fakeBoard({
        async loadInstructions() {
          return { ...bundle, files };
        },
      });
      const compile = createBotProfileCompile(board.ports, { env: INSTANCE_ENV });
      const before = await compile("agent-a", "agent-a");
      const same = await compile("agent-a", "agent-a");
      expect(classifyProfileChange({ restartHash: before.restartHash, filesHash: before.filesHash }, same)).toBe("none");
      files = files.filter((file) => file.path !== "docs/style.md");
      const fewer = await compile("agent-a", "agent-a");
      expect(classifyProfileChange({ restartHash: before.restartHash, filesHash: before.filesHash }, fewer)).toBe("files");
    });
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

    describe("a card whose provider goes through the LLM gateway", () => {
      const withoutLlm = (drop: string[]): NodeJS.ProcessEnv => {
        const env: NodeJS.ProcessEnv = { ...INSTANCE_ENV };
        for (const name of drop) delete env[name];
        return env;
      };

      it.each([
        ["custom", { provider: "custom", model: "some-model" }],
        ["a named custom provider", { provider: "custom:gateway", model: "some-model" }],
        ["auto", { provider: "auto", model: "some-model" }],
        ["no provider", { model: "some-model" }],
      ])("fails, creating nothing, naming the missing setting, for %s", async (_label, adapterConfig) => {
        for (const missing of [BOT_LLM_BASE_URL_ENV, BOT_LLM_API_KEY_ENV_ENV]) {
          const board = fakeBoard();
          board.agent.current = agentRecord({ adapterConfig });
          const compile = createBotProfileCompile(board.ports, { env: withoutLlm([missing]) });
          await expect(compile("agent-a", "agent-a")).rejects.toThrow(BotProfileInputError);
          await expect(compile("agent-a", "agent-a")).rejects.toThrow(missing);
          expect(board.calls).toEqual(["loadAgent", "loadAgent"]);
          expect(board.secrets.size).toBe(1);
        }
      });

      it("compiles a card with a native provider without either setting, and reads no gateway key", async () => {
        const board = fakeBoard();
        const profile = await createBotProfileCompile(board.ports, {
          env: withoutLlm([BOT_LLM_BASE_URL_ENV, BOT_LLM_API_KEY_ENV_ENV]),
        })("agent-a", "agent-a");
        expect(profile.botKey).toBe("agent-a");
        expect(board.calls.filter((call) => call.startsWith("readCompanySecret"))).toEqual([]);
      });
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
