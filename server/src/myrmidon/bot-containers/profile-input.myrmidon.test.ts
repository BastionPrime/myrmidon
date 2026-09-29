import { AGENT_DEFAULT_MAX_CONCURRENT_RUNS } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";

import { compileHermesProfile } from "./profile-compiler.js";
import {
  BOT_BOARD_URL_ENV,
  BOT_HINDSIGHT_API_URL_ENV,
  BOT_HINDSIGHT_BANK_ENV,
  BOT_LLM_API_KEY_ENV_ENV,
  BOT_LLM_API_KEY_SECRET_ENV,
  BOT_LLM_BASE_URL_ENV,
  BOT_RUNTIME_MCP_URL_BASE_ENV,
  BotProfileInputError,
  assertBotProfileSettings,
  buildHermesProfileInput,
  readBotProfileSettings,
  readMaxConcurrentRuns,
  rewriteMcpServerUrl,
  type BotProfileSettings,
  type BotProfileSource,
} from "./profile-input.js";

// Everything here is placeholder data: fake bot keys, example.com URLs and
// obviously-fake secrets.

function settings(overrides: Partial<BotProfileSettings> = {}): BotProfileSettings {
  return {
    hindsightApiUrl: "https://example.com/hindsight",
    hindsightBank: "fleet-default",
    llmBaseUrl: "https://example.com/llm/v1",
    llmApiKeyEnv: "FLEET_LLM_API_KEY",
    llmApiKeySecret: "FLEET_LLM_API_KEY",
    boardUrl: "http://board.example.com:3100",
    runtimeMcpUrlBase: null,
    ...overrides,
  };
}

function source(overrides: Partial<BotProfileSource> = {}): BotProfileSource {
  return {
    botKey: "agent-a",
    adapterConfig: {},
    runtimeConfig: {},
    env: {},
    skills: {},
    instructions: "# Role\n\nYou are agent-a.\n",
    llmApiKey: "fake-llm-key-0001",
    apiServerKey: "fake-api-server-key-0001",
    paperclipApiKey: "fake-paperclip-api-key-0001",
    mcpServers: [],
    ...overrides,
  };
}

function fileContent(profile: ReturnType<typeof compileHermesProfile>, path: string): string {
  const found = profile.files.find((file) => file.path === path);
  if (!found) throw new Error(`no compiled file at ${path}`);
  return found.content;
}

describe("myrmidon(W2a) readBotProfileSettings", () => {
  it("reads the MYRMIDON_BOT_* variables, trimming them and treating blanks as unset", () => {
    expect(
      readBotProfileSettings({
        [BOT_HINDSIGHT_API_URL_ENV]: "  https://example.com/hindsight  ",
        [BOT_HINDSIGHT_BANK_ENV]: "fleet",
        [BOT_LLM_BASE_URL_ENV]: "https://example.com/llm/v1",
        [BOT_LLM_API_KEY_ENV_ENV]: "FLEET_LLM_API_KEY",
        [BOT_BOARD_URL_ENV]: "http://board.example.com:3100",
        [BOT_RUNTIME_MCP_URL_BASE_ENV]: "http://board.example.com:3100/",
      }),
    ).toEqual({
      hindsightApiUrl: "https://example.com/hindsight",
      hindsightBank: "fleet",
      llmBaseUrl: "https://example.com/llm/v1",
      llmApiKeyEnv: "FLEET_LLM_API_KEY",
      llmApiKeySecret: "FLEET_LLM_API_KEY",
      boardUrl: "http://board.example.com:3100",
      runtimeMcpUrlBase: "http://board.example.com:3100",
    });
    expect(readBotProfileSettings({ [BOT_BOARD_URL_ENV]: "   " }).boardUrl).toBeNull();
    expect(readBotProfileSettings({}).hindsightApiUrl).toBeNull();
  });

  it("lets MYRMIDON_BOT_LLM_API_KEY_SECRET name a secret other than the variable", () => {
    const read = readBotProfileSettings({
      [BOT_LLM_API_KEY_ENV_ENV]: "FLEET_LLM_API_KEY",
      [BOT_LLM_API_KEY_SECRET_ENV]: "fleet-llm-gateway-key",
    });
    expect(read.llmApiKeyEnv).toBe("FLEET_LLM_API_KEY");
    expect(read.llmApiKeySecret).toBe("fleet-llm-gateway-key");
  });
});

describe("myrmidon(W2a) assertBotProfileSettings", () => {
  it("accepts a complete configuration", () => {
    expect(() => assertBotProfileSettings(settings())).not.toThrow();
    expect(() => assertBotProfileSettings(settings({ llmBaseUrl: null, llmApiKeyEnv: null, llmApiKeySecret: null }))).not.toThrow();
  });

  it("names the missing setting, never a value", () => {
    expect(() => assertBotProfileSettings(settings({ hindsightApiUrl: null }))).toThrow(BOT_HINDSIGHT_API_URL_ENV);
    expect(() => assertBotProfileSettings(settings({ boardUrl: null }))).toThrow(BOT_BOARD_URL_ENV);
  });

  it("rejects a URL that is not http(s)", () => {
    expect(() => assertBotProfileSettings(settings({ boardUrl: "not a url" }))).toThrow(BOT_BOARD_URL_ENV);
    expect(() => assertBotProfileSettings(settings({ llmBaseUrl: "ftp://example.com" }))).toThrow(BOT_LLM_BASE_URL_ENV);
  });

  it("rejects a key variable the compiler or the image owns", () => {
    for (const name of ["HOME", "PATH", "HERMES_HOME", "API_SERVER_KEY", "PAPERCLIP_API_KEY", "not valid"]) {
      expect(() => assertBotProfileSettings(settings({ llmApiKeyEnv: name })), name).toThrow(BOT_LLM_API_KEY_ENV_ENV);
    }
  });
});

describe("myrmidon(W2a) readMaxConcurrentRuns", () => {
  it("defaults to the board's own default and clamps to the board's own range", () => {
    expect(readMaxConcurrentRuns({})).toBe(AGENT_DEFAULT_MAX_CONCURRENT_RUNS);
    expect(readMaxConcurrentRuns({ heartbeat: {} })).toBe(AGENT_DEFAULT_MAX_CONCURRENT_RUNS);
    expect(readMaxConcurrentRuns({ heartbeat: { maxConcurrentRuns: 3 } })).toBe(3);
    expect(readMaxConcurrentRuns({ heartbeat: { maxConcurrentRuns: 3.9 } })).toBe(3);
    expect(readMaxConcurrentRuns({ heartbeat: { maxConcurrentRuns: "4" } })).toBe(4);
    expect(readMaxConcurrentRuns({ heartbeat: { maxConcurrentRuns: 0 } })).toBe(1);
    expect(readMaxConcurrentRuns({ heartbeat: { maxConcurrentRuns: -5 } })).toBe(1);
    expect(readMaxConcurrentRuns({ heartbeat: { maxConcurrentRuns: 500 } })).toBe(50);
    expect(readMaxConcurrentRuns({ heartbeat: { maxConcurrentRuns: "many" } })).toBe(AGENT_DEFAULT_MAX_CONCURRENT_RUNS);
    expect(readMaxConcurrentRuns({ heartbeat: "nope" })).toBe(AGENT_DEFAULT_MAX_CONCURRENT_RUNS);
  });
});

describe("myrmidon(W2a) buildHermesProfileInput — card mapping", () => {
  it("maps model, provider, effort, additional models and toolsets off the card", () => {
    const { input } = buildHermesProfileInput(
      source({
        adapterConfig: {
          model: "anthropic/claude-sonnet-5",
          provider: "anthropic",
          effort: "high",
          models: { vision: "vision-model", fallbacks: ["a/b", " ", "c/d"] },
          toolsets: "web,terminal",
        },
      }),
      settings(),
    );
    expect(input.adapterConfig).toMatchObject({
      model: "anthropic/claude-sonnet-5",
      provider: "anthropic",
      effort: "high",
      toolsets: "web,terminal",
      models: { vision: "vision-model", fallbacks: ["a/b", "c/d"] },
    });
  });

  it("accepts toolsets as a list and ignores fields of the wrong type", () => {
    const { input } = buildHermesProfileInput(
      source({ adapterConfig: { model: 42, toolsets: ["web", "terminal"], models: "nope" } }),
      settings(),
    );
    expect(input.adapterConfig.model).toBeUndefined();
    expect(input.adapterConfig.toolsets).toBe("web,terminal");
    expect(input.adapterConfig.models?.fallbacks).toBeUndefined();
  });

  it("passes instructions, skills, botKey and the generated credentials through", () => {
    const skills = { "code-review": [{ path: "SKILL.md", content: "# Code review\n" }] };
    const { input } = buildHermesProfileInput(source({ skills, instructions: "# Custom\n" }), settings());
    expect(input.botKey).toBe("agent-a");
    expect(input.instructions).toBe("# Custom\n");
    expect(input.skills).toEqual(skills);
    expect(input.apiServerKey).toBe("fake-api-server-key-0001");
    expect(input.paperclipApiKey).toBe("fake-paperclip-api-key-0001");
    expect(input.paperclipApiUrl).toBe("http://board.example.com:3100");
  });

  it("takes maxConcurrentRuns from the agent's heartbeat policy", () => {
    const { input } = buildHermesProfileInput(source({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 2 } } }), settings());
    expect(input.maxConcurrentRuns).toBe(2);
  });

  it("keeps the card's own env entries, secret flags included", () => {
    const { input } = buildHermesProfileInput(
      source({ env: { TZ: { value: "UTC", secret: false }, SERVICE_TOKEN: { value: "fake-token", secret: true } } }),
      settings(),
    );
    expect(input.env.TZ).toEqual({ value: "UTC", secret: false });
    expect(input.env.SERVICE_TOKEN).toEqual({ value: "fake-token", secret: true });
  });
});

describe("myrmidon(W2a) buildHermesProfileInput — hindsight", () => {
  it("uses the shared service and always local_external", () => {
    const { input } = buildHermesProfileInput(source({ adapterConfig: { hindsight: { mode: "cloud" } } }), settings());
    expect(input.hindsight.mode).toBe("local_external");
    expect(input.hindsight.apiUrl).toBe("https://example.com/hindsight");
  });

  it("takes the bank from the card, else from MYRMIDON_BOT_HINDSIGHT_BANK", () => {
    const fromCard = buildHermesProfileInput(source({ adapterConfig: { hindsight: { bankId: "agent-a-bank" } } }), settings());
    expect(fromCard.input.hindsight.bankId).toBe("agent-a-bank");
    const fromSetting = buildHermesProfileInput(source(), settings());
    expect(fromSetting.input.hindsight.bankId).toBe("fleet-default");
  });

  it("fails, naming both places, when there is no bank anywhere", () => {
    expect(() => buildHermesProfileInput(source(), settings({ hindsightBank: null }))).toThrow(BOT_HINDSIGHT_BANK_ENV);
  });

  it("passes the card's tags, mission and recall tuning, dropping values outside the allowed sets", () => {
    const { input } = buildHermesProfileInput(
      source({
        adapterConfig: {
          hindsight: { tags: ["fleet", "agent-a"], mission: "Remember decisions.", recallBudget: "high", memoryMode: "bogus", autoRetain: true },
        },
      }),
      settings(),
    );
    expect(input.hindsight).toMatchObject({
      tags: ["fleet", "agent-a"],
      mission: "Remember decisions.",
      recallBudget: "high",
      autoRetain: true,
    });
    expect(input.hindsight.memoryMode).toBeUndefined();
  });
});

describe("myrmidon(W2a) buildHermesProfileInput — LLM gateway key", () => {
  it("places the instance/company secret in .env under the configured name, as a secret", () => {
    const { input } = buildHermesProfileInput(source(), settings());
    expect(input.llm).toEqual({ baseUrl: "https://example.com/llm/v1", apiKeyEnv: "FLEET_LLM_API_KEY" });
    expect(input.env.FLEET_LLM_API_KEY).toEqual({ value: "fake-llm-key-0001", secret: true });
  });

  it("lets the card's own env value win over the company secret", () => {
    const { input } = buildHermesProfileInput(
      source({ env: { FLEET_LLM_API_KEY: { value: "fake-card-key", secret: true } } }),
      settings(),
    );
    expect(input.env.FLEET_LLM_API_KEY?.value).toBe("fake-card-key");
  });

  it("fails closed when neither the card nor the company secret has a value", () => {
    const build = () => buildHermesProfileInput(source({ llmApiKey: null }), settings());
    expect(build).toThrow(BotProfileInputError);
    expect(build).toThrow("FLEET_LLM_API_KEY");
    expect(() => buildHermesProfileInput(source({ llmApiKey: "  " }), settings())).toThrow(BotProfileInputError);
  });

  it("names the secret, not its value, in the error", () => {
    expect(() =>
      buildHermesProfileInput(source({ llmApiKey: null }), settings({ llmApiKeySecret: "fleet-llm-gateway-key" })),
    ).toThrow("fleet-llm-gateway-key");
  });

  it("asks for no key and sets no endpoint when the instance configures no gateway", () => {
    const { input } = buildHermesProfileInput(
      source({ llmApiKey: null }),
      settings({ llmBaseUrl: null, llmApiKeyEnv: null, llmApiKeySecret: null }),
    );
    expect(input.llm).toEqual({ baseUrl: undefined, apiKeyEnv: undefined });
  });
});

describe("myrmidon(W2a) buildHermesProfileInput — MCP servers", () => {
  const board = { name: "Paperclip board", url: "https://public.example.com/api/mcp/gateway/abc", token: "fake-mcp-token-0001" };

  it("references the token as ${VAR} in the server's header and puts the value in .env", () => {
    const { input, warnings } = buildHermesProfileInput(source({ mcpServers: [board] }), settings());
    expect(warnings).toEqual([]);
    expect(input.mcpServers).toEqual([
      {
        name: "paperclip-board",
        url: "https://public.example.com/api/mcp/gateway/abc",
        headers: { Authorization: "Bearer ${MYRMIDON_MCP_TOKEN_PAPERCLIP_BOARD}" },
      },
    ]);
    expect(input.env.MYRMIDON_MCP_TOKEN_PAPERCLIP_BOARD).toEqual({ value: "fake-mcp-token-0001", secret: true });
  });

  it("rewrites the gateway URL's origin to the instance's internal base, keeping path and query", () => {
    const withQuery = { ...board, url: "https://public.example.com/api/mcp/gateway/abc?x=1" };
    const { input } = buildHermesProfileInput(
      source({ mcpServers: [withQuery] }),
      settings({ runtimeMcpUrlBase: "http://board.internal:3100" }),
    );
    expect(input.mcpServers[0]?.url).toBe("http://board.internal:3100/api/mcp/gateway/abc?x=1");
  });

  it("honors the card's own base and its rewrite switch, like the P4 adapter", () => {
    const base = settings({ runtimeMcpUrlBase: "http://board.internal:3100" });
    const own = buildHermesProfileInput(
      source({ mcpServers: [board], adapterConfig: { runtimeMcpUrlBase: "http://other.internal:3100/" } }),
      base,
    );
    expect(own.input.mcpServers[0]?.url).toBe("http://other.internal:3100/api/mcp/gateway/abc");
    const off = buildHermesProfileInput(
      source({ mcpServers: [board], adapterConfig: { runtimeMcpUrlRewrite: false } }),
      base,
    );
    expect(off.input.mcpServers[0]?.url).toBe(board.url);
  });

  it("skips a server without a token or a usable name, and a duplicate, with a warning", () => {
    const { input, warnings } = buildHermesProfileInput(
      source({
        mcpServers: [
          board,
          { ...board, url: "https://public.example.com/other" },
          { name: "no token", url: "https://public.example.com/x", token: " " },
          { name: "!!!", url: "https://public.example.com/y", token: "fake-token" },
        ],
      }),
      settings(),
    );
    expect(input.mcpServers.map((server) => server.name)).toEqual(["paperclip-board"]);
    expect(input.mcpServers[0]?.url).toBe(board.url);
    expect(warnings).toEqual([
      "mcp.paperclip-board: duplicate server name, the first one is kept",
      "mcp.no-token: no token, the server was skipped",
      "mcp: a server with an empty name was skipped",
    ]);
  });

  it("rewriteMcpServerUrl leaves an unparseable URL or base as it was", () => {
    expect(rewriteMcpServerUrl("not a url", "http://board.internal:3100")).toBe("not a url");
    expect(rewriteMcpServerUrl("https://public.example.com/a", "nope")).toBe("https://public.example.com/a");
    expect(rewriteMcpServerUrl("http://board.internal:3100/a", "http://board.internal:3100")).toBe("http://board.internal:3100/a");
  });
});

describe("myrmidon(W2a) buildHermesProfileInput — through the G2 compiler", () => {
  const board = { name: "board", url: "https://public.example.com/api/mcp/gateway/abc", token: "fake-mcp-token-0001" };

  it("compiles to a profile whose secrets are only in .env", () => {
    const { input } = buildHermesProfileInput(
      source({
        adapterConfig: { model: "anthropic/claude-sonnet-5", provider: "anthropic", hindsight: { bankId: "agent-a-bank" } },
        mcpServers: [board],
      }),
      settings(),
    );
    const profile = compileHermesProfile(input);

    const env = fileContent(profile, "hermes/.env");
    expect(env).toContain('API_SERVER_KEY="fake-api-server-key-0001"');
    expect(env).toContain('PAPERCLIP_API_URL="http://board.example.com:3100"');
    expect(env).toContain('PAPERCLIP_API_KEY="fake-paperclip-api-key-0001"');
    expect(env).toContain('FLEET_LLM_API_KEY="fake-llm-key-0001"');
    expect(env).toContain('MYRMIDON_MCP_TOKEN_BOARD="fake-mcp-token-0001"');

    const config = fileContent(profile, "hermes/config.yaml");
    expect(config).toContain("Bearer ${MYRMIDON_MCP_TOKEN_BOARD}");
    expect(config).toContain("${FLEET_LLM_API_KEY}");
    for (const secret of ["fake-api-server-key-0001", "fake-paperclip-api-key-0001", "fake-llm-key-0001", "fake-mcp-token-0001"]) {
      expect(config, secret).not.toContain(secret);
    }

    const hindsight = JSON.parse(fileContent(profile, "hermes/hindsight/config.json")) as Record<string, unknown>;
    expect(hindsight).toMatchObject({ bank_id: "agent-a-bank", mode: "local_external", api_url: "https://example.com/hindsight" });
    expect(fileContent(profile, "workspace/AGENTS.md")).toContain("You are agent-a.");
  });

  it("is stable: the same card and secrets compile to the same hashes on the next tick", () => {
    const build = () =>
      compileHermesProfile(
        buildHermesProfileInput(
          source({ adapterConfig: { hindsight: { bankId: "agent-a-bank" } }, mcpServers: [board], runtimeConfig: { heartbeat: { maxConcurrentRuns: 2 } } }),
          settings(),
        ).input,
      );
    const first = build();
    const second = build();
    expect(second.restartHash).toBe(first.restartHash);
    expect(second.filesHash).toBe(first.filesHash);
  });

  it("changes only the files hash when only the instructions change, and the restart hash when a secret changes", () => {
    const base = compileHermesProfile(buildHermesProfileInput(source(), settings()).input);
    const editedInstructions = compileHermesProfile(buildHermesProfileInput(source({ instructions: "# New\n" }), settings()).input);
    expect(editedInstructions.restartHash).toBe(base.restartHash);
    expect(editedInstructions.filesHash).not.toBe(base.filesHash);
    const rotatedKey = compileHermesProfile(buildHermesProfileInput(source({ llmApiKey: "fake-llm-key-0002" }), settings()).input);
    expect(rotatedKey.restartHash).not.toBe(base.restartHash);
  });
});
