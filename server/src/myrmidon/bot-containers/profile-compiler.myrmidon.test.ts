import { describe, expect, it } from "vitest";

import { classifyProfileChange } from "./types.js";
import {
  compileHermesProfile,
  compileHermesProfileDetailed,
  type HermesProfileInput,
} from "./profile-compiler.js";

// Everything here is placeholder data: fake bot keys, example.com URLs,
// 192.0.2.0/24 addresses (TEST-NET-1, RFC 5737) and obviously-fake secrets.

function baseInput(overrides: Partial<HermesProfileInput> = {}): HermesProfileInput {
  return {
    botKey: "agent-a",
    adapterConfig: {},
    env: {},
    skills: {},
    instructions: "# Role\n\nYou are agent-a.\n",
    hindsight: { bankId: "agent-a", apiUrl: "https://example.com/hindsight" },
    llm: {},
    mcpServers: [],
    maxConcurrentRuns: 2,
    instanceDefaults: {},
    apiServerKey: "fake-api-server-key-0001",
    paperclipApiUrl: "https://example.com",
    paperclipApiKey: "fake-paperclip-api-key-0001",
    ...overrides,
  };
}

function fileByPath(files: ReturnType<typeof compileHermesProfile>["files"], path: string) {
  const found = files.find((f) => f.path === path);
  if (!found) throw new Error(`no compiled file at ${path}`);
  return found;
}

describe("myrmidon(G2) compileHermesProfile — shape and determinism", () => {
  it("always produces config.yaml, .env, hindsight/config.json and workspace/AGENTS.md", () => {
    const profile = compileHermesProfile(baseInput());
    const paths = profile.files.map((f) => f.path).sort();
    expect(paths).toEqual(["hermes/.env", "hermes/config.yaml", "hermes/hindsight/config.json", "workspace/AGENTS.md"]);
  });

  it("passes botKey through unchanged", () => {
    const profile = compileHermesProfile(baseInput({ botKey: "agent-b" }));
    expect(profile.botKey).toBe("agent-b");
  });

  it("is deterministic: the same input compiles to byte-identical files and hashes", () => {
    const input = baseInput({
      adapterConfig: { model: "anthropic/claude-sonnet-5", provider: "anthropic", effort: "high" },
      mcpServers: [
        { name: "ragflow", url: "https://example.com/mcp/ragflow" },
        { name: "board", url: "https://example.com/mcp/board", headers: { "X-Token": "t" } },
      ],
      skills: { "code-review": [{ path: "SKILL.md", content: "# Code review\n" }] },
    });
    const a = compileHermesProfile(input);
    const b = compileHermesProfile(structuredClone(input));
    expect(a).toEqual(b);
  });

  it("MCP server input order does not change the compiled output (rendered keys are sorted)", () => {
    const servers = [
      { name: "zeta", url: "https://example.com/mcp/zeta" },
      { name: "alpha", url: "https://example.com/mcp/alpha" },
    ];
    const forward = compileHermesProfile(baseInput({ mcpServers: servers }));
    const reversed = compileHermesProfile(baseInput({ mcpServers: [...servers].reverse() }));
    expect(forward).toEqual(reversed);
  });

  it("env map key order does not change the compiled .env content", () => {
    const forward = compileHermesProfile(
      baseInput({ env: { AAA: { value: "1", secret: false }, ZZZ: { value: "2", secret: false } } }),
    );
    const reversed = compileHermesProfile(
      baseInput({ env: { ZZZ: { value: "2", secret: false }, AAA: { value: "1", secret: false } } }),
    );
    expect(forward).toEqual(reversed);
  });

  it("files come out in a fixed order: config.yaml, .env, hindsight config, then sorted skills, then AGENTS.md", () => {
    const profile = compileHermesProfile(
      baseInput({
        skills: {
          zeta: [{ path: "SKILL.md", content: "z" }],
          alpha: [{ path: "SKILL.md", content: "a" }],
        },
      }),
    );
    expect(profile.files.map((f) => f.path)).toEqual([
      "hermes/config.yaml",
      "hermes/.env",
      "hermes/hindsight/config.json",
      "hermes/skills-board/alpha/SKILL.md",
      "hermes/skills-board/zeta/SKILL.md",
      "workspace/AGENTS.md",
    ]);
  });
});

describe("myrmidon(G2) compileHermesProfile — file modes and secrecy", () => {
  it("marks only .env as secret, with 0o600; everything else is 0o644 and not secret", () => {
    const profile = compileHermesProfile(baseInput());
    for (const f of profile.files) {
      if (f.path === "hermes/.env") {
        expect(f.secret).toBe(true);
        expect(f.mode).toBe(0o600);
      } else {
        expect(f.secret).toBe(false);
        expect(f.mode).toBe(0o644);
      }
    }
  });

  it("marks config.yaml secret (0o600) whenever an MCP server carries headers: a header value may be an already-resolved credential, not a ${VAR} reference", () => {
    const profile = compileHermesProfile(
      baseInput({
        mcpServers: [{ name: "board", url: "https://example.com/mcp/board", headers: { Authorization: "Bearer t" } }],
      }),
    );
    const configYaml = fileByPath(profile.files, "hermes/config.yaml");
    expect(configYaml.secret).toBe(true);
    expect(configYaml.mode).toBe(0o600);
  });

  it("leaves config.yaml non-secret when MCP servers have no headers, or no MCP servers at all", () => {
    const profile = compileHermesProfile(
      baseInput({ mcpServers: [{ name: "board", url: "https://example.com/mcp/board" }] }),
    );
    const configYaml = fileByPath(profile.files, "hermes/config.yaml");
    expect(configYaml.secret).toBe(false);
    expect(configYaml.mode).toBe(0o644);
  });

  it("never writes secret env values into config.yaml or hindsight/config.json", () => {
    const secretValue = "sk-very-secret-token-0001";
    const profile = compileHermesProfile(
      baseInput({ env: { OPENROUTER_API_KEY: { value: secretValue, secret: true } } }),
    );
    const configYaml = fileByPath(profile.files, "hermes/config.yaml").content;
    const hindsightJson = fileByPath(profile.files, "hermes/hindsight/config.json").content;
    const agentsMd = fileByPath(profile.files, "workspace/AGENTS.md").content;
    expect(configYaml).not.toContain(secretValue);
    expect(hindsightJson).not.toContain(secretValue);
    expect(agentsMd).not.toContain(secretValue);
    expect(fileByPath(profile.files, "hermes/.env").content).toContain(secretValue);
  });

  it("puts apiServerKey, paperclipApiUrl and paperclipApiKey into .env under their fixed names", () => {
    const profile = compileHermesProfile(
      baseInput({
        apiServerKey: "fake-gateway-key-0002",
        paperclipApiUrl: "https://example.com/board",
        paperclipApiKey: "fake-board-key-0002",
      }),
    );
    const env = fileByPath(profile.files, "hermes/.env").content;
    expect(env).toContain('API_SERVER_KEY="fake-gateway-key-0002"');
    expect(env).toContain('PAPERCLIP_API_URL="https://example.com/board"');
    expect(env).toContain('PAPERCLIP_API_KEY="fake-board-key-0002"');
  });

  it("drops HOME, PATH and HERMES_HOME from the card's env, with a warning, even if the card sets them", () => {
    const { profile, warnings } = compileHermesProfileDetailed(
      baseInput({
        env: {
          HOME: { value: "/root", secret: false },
          PATH: { value: "/usr/bin", secret: false },
          HERMES_HOME: { value: "/data/hermes", secret: false },
          KEPT: { value: "kept-value", secret: false },
        },
      }),
    );
    const env = fileByPath(profile.files, "hermes/.env").content;
    expect(env).not.toMatch(/^HOME=/m);
    expect(env).not.toMatch(/^PATH=/m);
    expect(env).not.toMatch(/^HERMES_HOME=/m);
    expect(env).toContain('KEPT="kept-value"');
    expect(warnings.filter((w) => w.includes("cannot be overridden"))).toHaveLength(3);
  });

  it("a card env entry named API_SERVER_KEY is overridden by the compiler's own value, with a warning", () => {
    const { profile, warnings } = compileHermesProfileDetailed(
      baseInput({
        env: { API_SERVER_KEY: { value: "card-supplied-value", secret: true } },
        apiServerKey: "compiler-owned-value",
      }),
    );
    const env = fileByPath(profile.files, "hermes/.env").content;
    expect(env).toContain('API_SERVER_KEY="compiler-owned-value"');
    expect(env).not.toContain("card-supplied-value");
    expect(warnings.some((w) => w.includes("reserved for the compiler's own value"))).toBe(true);
  });

  it("escapes quotes, backslashes and newlines inside an .env value", () => {
    const profile = compileHermesProfile(
      baseInput({ env: { GREETING: { value: 'hi "there"\nfriend', secret: false } } }),
    );
    const env = fileByPath(profile.files, "hermes/.env").content;
    expect(env).toContain('GREETING="hi \\"there\\"\\nfriend"');
  });

  it("drops an env entry whose name is not a valid environment variable name", () => {
    const { profile, warnings } = compileHermesProfileDetailed(
      baseInput({ env: { "not a name": { value: "x", secret: false } } }),
    );
    const env = fileByPath(profile.files, "hermes/.env").content;
    expect(env).not.toContain("not a name");
    expect(warnings.some((w) => w.includes("not a name") && w.includes("not a valid"))).toBe(true);
  });

  // Hermes loads hermes/.env with python-dotenv's default `interpolate=True`
  // (hermes_cli/env_loader.py never passes `interpolate=`), which resolves a
  // literal "${NAME}"/"${NAME:-default}" substring against the process
  // environment regardless of quoting, and this dotenv version has no escape
  // for a literal "$" in a double-quoted value (its escape set is
  // \\['"abfnrtv], no "$"). The compiler can't prevent this in the .env text
  // format, so it warns instead of failing silently.
  it("warns when a card env value contains a literal ${...} sequence dotenv would interpolate", () => {
    const { profile, warnings } = compileHermesProfileDetailed(
      baseInput({ env: { WEBHOOK_SECRET: { value: "prefix-${SOME_VAR}-suffix", secret: true } } }),
    );
    const env = fileByPath(profile.files, "hermes/.env").content;
    // The value is still written verbatim (this PR doesn't corrupt it) — the
    // corruption happens later, when Hermes' dotenv loader reads the file.
    expect(env).toContain('WEBHOOK_SECRET="prefix-${SOME_VAR}-suffix"');
    expect(
      warnings.some(
        (w) => w.includes("WEBHOOK_SECRET") && w.includes("${") && w.includes("interpolate"),
      ),
    ).toBe(true);
  });

  it("also warns for the ${NAME:-default} form, and for the compiler's own reserved values", () => {
    const { warnings } = compileHermesProfileDetailed(
      baseInput({
        env: { TOKEN: { value: "x${FOO:-bar}y", secret: true } },
        apiServerKey: "value-with-${LITERAL}-in-it",
      }),
    );
    expect(warnings.some((w) => w.includes("TOKEN") && w.includes("interpolate"))).toBe(true);
    expect(warnings.some((w) => w.includes("API_SERVER_KEY") && w.includes("interpolate"))).toBe(true);
  });

  it("does not warn for a plain \"$\" or an unclosed \"${\" with no matching brace", () => {
    const { warnings } = compileHermesProfileDetailed(
      baseInput({ env: { PRICE: { value: "costs $5, formula ${unclosed", secret: false } } }),
    );
    expect(warnings.some((w) => w.includes("interpolate"))).toBe(false);
  });
});

describe("myrmidon(G2) compileHermesProfile — always-set config.yaml fields", () => {
  it("always sets approvals.mode off, platforms.api_server.enabled true, terminal.cwd /workspace, memory.provider hindsight and skills.external_dirs", () => {
    const profile = compileHermesProfile(baseInput());
    const yaml = fileByPath(profile.files, "hermes/config.yaml").content;
    expect(yaml).toContain('approvals:\n  mode: "off"');
    expect(yaml).toContain("platforms:\n  api_server:\n    enabled: true");
    expect(yaml).toContain('terminal:\n  cwd: "/workspace"');
    expect(yaml).toContain('memory:\n  provider: "hindsight"');
    expect(yaml).toContain('skills:\n  external_dirs:\n  - "/data/hermes/skills-board"');
  });

  it("sets gateway.api_server.max_concurrent_runs from maxConcurrentRuns", () => {
    const profile = compileHermesProfile(baseInput({ maxConcurrentRuns: 7 }));
    const yaml = fileByPath(profile.files, "hermes/config.yaml").content;
    expect(yaml).toContain("gateway:\n  api_server:\n    max_concurrent_runs: 7");
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects a non-positive-integer maxConcurrentRuns (%s)", (value) => {
    expect(() => compileHermesProfile(baseInput({ maxConcurrentRuns: value }))).toThrow();
  });

  it("rejects an empty botKey", () => {
    expect(() => compileHermesProfile(baseInput({ botKey: "  " }))).toThrow();
  });
});

describe("myrmidon(G2) compileHermesProfile — model mapping (repeats the M1 mapping)", () => {
  it("maps model, provider and a valid reasoning effort", () => {
    const profile = compileHermesProfile(
      baseInput({ adapterConfig: { model: "anthropic/claude-sonnet-5", provider: "anthropic", effort: "High" } }),
    );
    const yaml = fileByPath(profile.files, "hermes/config.yaml").content;
    expect(yaml).toContain('model:\n  default: "anthropic/claude-sonnet-5"\n  provider: "anthropic"');
    expect(yaml).toContain('agent:\n  reasoning_effort: "high"');
  });

  it("drops an unrecognized reasoning effort with a warning, leaving agent: out of the document", () => {
    const { profile, warnings } = compileHermesProfileDetailed(
      baseInput({ adapterConfig: { effort: "super-high" } }),
    );
    const yaml = fileByPath(profile.files, "hermes/config.yaml").content;
    expect(yaml).not.toContain("reasoning_effort");
    expect(yaml).not.toContain("agent:");
    expect(warnings.some((w) => w.includes('"super-high"') && w.includes("not a Hermes effort level"))).toBe(true);
  });

  it("maps models.vision to auxiliary.vision.model", () => {
    const profile = compileHermesProfile(baseInput({ adapterConfig: { models: { vision: "vendor/vision-1" } } }));
    const yaml = fileByPath(profile.files, "hermes/config.yaml").content;
    expect(yaml).toContain('auxiliary:\n  vision:\n    model: "vendor/vision-1"');
  });

  it("warns and drops an stt model: the card carries no stt provider for Hermes's stt.<provider>.model key", () => {
    const { profile, warnings } = compileHermesProfileDetailed(
      baseInput({ adapterConfig: { models: { stt: "vendor/stt-1" } } }),
    );
    const yaml = fileByPath(profile.files, "hermes/config.yaml").content;
    expect(yaml).not.toContain("stt");
    expect(warnings.some((w) => w.startsWith("stt.model:") && w.includes("vendor/stt-1"))).toBe(true);
  });

  it("warns and drops a tts model the same way", () => {
    const { warnings } = compileHermesProfileDetailed(baseInput({ adapterConfig: { models: { tts: "vendor/tts-1" } } }));
    expect(warnings.some((w) => w.startsWith("tts.model:") && w.includes("vendor/tts-1"))).toBe(true);
  });

  it("warns that a video model is not supported and never applies it", () => {
    const { profile, warnings } = compileHermesProfileDetailed(
      baseInput({ adapterConfig: { models: { video: "vendor/video-1" } } }),
    );
    const yaml = fileByPath(profile.files, "hermes/config.yaml").content;
    expect(yaml).not.toContain("video");
    expect(warnings.some((w) => w.includes("models.video") && w.includes("no separate video model setting"))).toBe(
      true,
    );
  });

  it("writes an ordered fallback_model chain when the card gives an explicit non-auto provider", () => {
    const profile = compileHermesProfile(
      baseInput({
        adapterConfig: { provider: "xai", models: { fallbacks: ["grok-4", "grok-3"] } },
      }),
    );
    const yaml = fileByPath(profile.files, "hermes/config.yaml").content;
    expect(yaml).toContain(
      'fallback_model:\n- model: "grok-4"\n  provider: "xai"\n- model: "grok-3"\n  provider: "xai"',
    );
  });

  it.each([undefined, "auto"])("drops the fallback chain with a warning when the provider is %s", (provider) => {
    const { profile, warnings } = compileHermesProfileDetailed(
      baseInput({ adapterConfig: { provider, models: { fallbacks: ["grok-4"] } } }),
    );
    const yaml = fileByPath(profile.files, "hermes/config.yaml").content;
    expect(yaml).not.toContain("fallback_model");
    expect(warnings.some((w) => w.startsWith("fallback_model:"))).toBe(true);
  });

  it("leaves model, agent, auxiliary and fallback_model out of the document entirely when the card sets no models", () => {
    const profile = compileHermesProfile(baseInput({ adapterConfig: {} }));
    const yaml = fileByPath(profile.files, "hermes/config.yaml").content;
    for (const key of ["model:", "agent:", "auxiliary:", "fallback_model:"]) {
      expect(yaml).not.toContain(key);
    }
  });
});

// Regression coverage for the bug this closes: config.yaml used to write
// only model.default/model.provider, never an endpoint. Every live fleet
// profile runs provider=custom against an internal OpenAI-compatible LLM
// gateway, so without model.base_url Hermes either 401s against it (with a
// same-origin API key it isn't meant for) or silently routes to
// OpenRouter's default endpoint instead — see HermesProfileLlmSettings.
describe("myrmidon(G2) compileHermesProfile — LLM gateway (instance-level base_url/api_key)", () => {
  it("provider custom + baseUrl: config.yaml gets model.base_url, and never the key's actual value", () => {
    const profile = compileHermesProfile(
      baseInput({
        adapterConfig: { model: "custom-provider/some-model", provider: "custom" },
        llm: { baseUrl: "https://example.com/llm/v1", apiKeyEnv: "LLM_GATEWAY_API_KEY" },
      }),
    );
    const yaml = fileByPath(profile.files, "hermes/config.yaml").content;
    expect(yaml).toContain('base_url: "https://example.com/llm/v1"');
    // api_key is a "${VAR}" reference, never a resolved value: this
    // compiler never has the actual secret in hand for config.yaml, and
    // must never write one even if it did.
    expect(yaml).toContain('api_key: "${LLM_GATEWAY_API_KEY}"');
    expect(yaml).not.toMatch(/api_key:\s*"(?!\$\{)/);
  });

  it("writes base_url alone, with api_key left out, when apiKeyEnv is not set", () => {
    const profile = compileHermesProfile(
      baseInput({ adapterConfig: { provider: "custom" }, llm: { baseUrl: "https://example.com/llm/v1" } }),
    );
    const yaml = fileByPath(profile.files, "hermes/config.yaml").content;
    expect(yaml).toContain('base_url: "https://example.com/llm/v1"');
    expect(yaml).not.toContain("api_key");
  });

  it("leaves model.base_url/api_key, and the model: key entirely, out of the document when llm is unset", () => {
    const profile = compileHermesProfile(baseInput({ adapterConfig: {} }));
    const yaml = fileByPath(profile.files, "hermes/config.yaml").content;
    expect(yaml).not.toContain("model:");
    expect(yaml).not.toContain("base_url");
    expect(yaml).not.toContain("api_key");
  });

  it("drops an apiKeyEnv that is not a valid environment variable name, with a warning", () => {
    const { profile, warnings } = compileHermesProfileDetailed(
      baseInput({
        adapterConfig: { provider: "custom" },
        llm: { baseUrl: "https://example.com/llm/v1", apiKeyEnv: "not a name" },
      }),
    );
    const yaml = fileByPath(profile.files, "hermes/config.yaml").content;
    expect(yaml).not.toContain("api_key");
    expect(yaml).toContain('base_url: "https://example.com/llm/v1"');
    expect(warnings.some((w) => w.includes("llm.apiKeyEnv") && w.includes("not a name"))).toBe(true);
  });

  // fallback_model entries resolve base_url/key independently of `model`
  // (hermes_cli/fallback_config.py resolve_entry_api_key /
  // _iter_fallback_entries — neither is inherited), so the same instance
  // settings must be repeated onto every entry, not just the main model.
  it("propagates base_url and key_env (never api_key/a resolved value) to every fallback_model entry", () => {
    const profile = compileHermesProfile(
      baseInput({
        adapterConfig: { provider: "custom", models: { fallbacks: ["model-b", "model-c"] } },
        llm: { baseUrl: "https://example.com/llm/v1", apiKeyEnv: "LLM_GATEWAY_API_KEY" },
      }),
    );
    const yaml = fileByPath(profile.files, "hermes/config.yaml").content;
    // The exact-substring match below already proves each entry has only
    // these four keys (base_url, key_env, model, provider) — in particular
    // no "api_key" key, which model.api_key uses instead (asserted above).
    expect(yaml).toContain(
      'fallback_model:\n- base_url: "https://example.com/llm/v1"\n  key_env: "LLM_GATEWAY_API_KEY"\n  model: "model-b"\n  provider: "custom"\n- base_url: "https://example.com/llm/v1"\n  key_env: "LLM_GATEWAY_API_KEY"\n  model: "model-c"\n  provider: "custom"',
    );
  });

  it("still drops the fallback chain (base_url/key_env included) when the provider is auto, same as before", () => {
    const { profile, warnings } = compileHermesProfileDetailed(
      baseInput({
        adapterConfig: { provider: "auto", models: { fallbacks: ["model-b"] } },
        llm: { baseUrl: "https://example.com/llm/v1", apiKeyEnv: "LLM_GATEWAY_API_KEY" },
      }),
    );
    const yaml = fileByPath(profile.files, "hermes/config.yaml").content;
    expect(yaml).not.toContain("fallback_model");
    expect(warnings.some((w) => w.startsWith("fallback_model:"))).toBe(true);
  });
});

describe("myrmidon(G2) compileHermesProfile — toolsets", () => {
  it("splits, trims and de-duplicates the comma-separated toolsets field", () => {
    const profile = compileHermesProfile(
      baseInput({ adapterConfig: { toolsets: " terminal, file ,web,file" } }),
    );
    const yaml = fileByPath(profile.files, "hermes/config.yaml").content;
    expect(yaml).toContain(
      'platform_toolsets:\n  api_server:\n  - "terminal"\n  - "file"\n  - "web"',
    );
  });

  it("leaves platform_toolsets out of the document when toolsets is unset", () => {
    const profile = compileHermesProfile(baseInput());
    expect(fileByPath(profile.files, "hermes/config.yaml").content).not.toContain("platform_toolsets");
  });
});

describe("myrmidon(G2) compileHermesProfile — MCP servers", () => {
  it("renders each server's url and headers, keyed by name", () => {
    const profile = compileHermesProfile(
      baseInput({
        mcpServers: [
          { name: "ragflow", url: "https://example.com/mcp/ragflow", headers: { "X-Token": "t" } },
          { name: "board", url: "https://example.com/mcp/board" },
        ],
      }),
    );
    const yaml = fileByPath(profile.files, "hermes/config.yaml").content;
    expect(yaml).toContain('mcp_servers:\n  board:\n    url: "https://example.com/mcp/board"');
    expect(yaml).toContain(
      'ragflow:\n    headers:\n      X-Token: "t"\n    url: "https://example.com/mcp/ragflow"',
    );
  });

  it("keeps the first entry and warns on a duplicate server name", () => {
    const { profile, warnings } = compileHermesProfileDetailed(
      baseInput({
        mcpServers: [
          { name: "ragflow", url: "https://example.com/mcp/first" },
          { name: "ragflow", url: "https://example.com/mcp/second" },
        ],
      }),
    );
    const yaml = fileByPath(profile.files, "hermes/config.yaml").content;
    expect(yaml).toContain("https://example.com/mcp/first");
    expect(yaml).not.toContain("https://example.com/mcp/second");
    expect(warnings.some((w) => w.includes("ragflow") && w.includes("duplicate"))).toBe(true);
  });

  it("leaves mcp_servers out of the document when there are no servers", () => {
    const profile = compileHermesProfile(baseInput());
    expect(fileByPath(profile.files, "hermes/config.yaml").content).not.toContain("mcp_servers");
  });

  it("rejects an MCP server with an empty url", () => {
    expect(() =>
      compileHermesProfile(baseInput({ mcpServers: [{ name: "ragflow", url: "  " }] })),
    ).toThrow();
  });

  it("drops an MCP server entry with an empty name, with a warning", () => {
    const { profile, warnings } = compileHermesProfileDetailed(
      baseInput({ mcpServers: [{ name: "  ", url: "https://example.com/mcp" }] }),
    );
    expect(fileByPath(profile.files, "hermes/config.yaml").content).not.toContain("mcp_servers");
    expect(warnings.some((w) => w.includes("empty name"))).toBe(true);
  });

  // buildMcpServers used to build the mapping via `{}` + `mapping[name] = ...`
  // bracket assignment: `{}["__proto__"] = x` sets the object's prototype
  // instead of an own property, so Object.keys (what the YAML writer walks)
  // never saw it and the entry silently vanished. Guards against a
  // regression back to that pattern.
  it("does not lose a server literally named \"__proto__\" (prototype-pollution footgun in the name -> object map)", () => {
    const profile = compileHermesProfile(
      baseInput({ mcpServers: [{ name: "__proto__", url: "https://example.com/mcp/proto" }] }),
    );
    const yaml = fileByPath(profile.files, "hermes/config.yaml").content;
    expect(yaml).toContain('__proto__:\n    url: "https://example.com/mcp/proto"');
    // And it must not have leaked onto Object.prototype for any other plain
    // object built in the same compile.
    expect(({} as Record<string, unknown>).url).toBeUndefined();
  });
});

describe("myrmidon(G2) compileHermesProfile — hindsight settings", () => {
  // Key names here must match what the vendor's hindsight plugin actually
  // reads from hermes/hindsight/config.json — cfg.get("bank_mission") and
  // _cfg_or_env("retain_tags", ...) in
  // /opt/hermes-agent/src/plugins/memory/hindsight/__init__.py — not the
  // HermesProfileHindsightSettings field names (`mission`, `tags`), which
  // are generic on purpose.
  it("writes bank_id, bank_mission, recall_budget, retain_tags plus the always-on mode/api_url/memory_mode/auto_retain, sorted", () => {
    const profile = compileHermesProfile(
      baseInput({
        hindsight: {
          bankId: "agent-a",
          apiUrl: "https://example.com/hindsight",
          mission: "Keep the shop running.",
          recallBudget: "high",
          tags: [" ops ", "shop", ""],
        },
      }),
    );
    const json = JSON.parse(fileByPath(profile.files, "hermes/hindsight/config.json").content);
    expect(json).toEqual({
      api_url: "https://example.com/hindsight",
      auto_retain: false,
      bank_id: "agent-a",
      bank_mission: "Keep the shop running.",
      memory_mode: "tools",
      mode: "local_external",
      recall_budget: "high",
      retain_tags: ["ops", "shop"],
    });
  });

  it("still omits bank_mission, recall_budget and retain_tags when unset, but never mode/api_url/memory_mode/auto_retain", () => {
    const profile = compileHermesProfile(baseInput({ hindsight: { bankId: "agent-a", apiUrl: "https://example.com/hindsight" } }));
    const json = JSON.parse(fileByPath(profile.files, "hermes/hindsight/config.json").content);
    expect(json).toEqual({
      api_url: "https://example.com/hindsight",
      auto_retain: false,
      bank_id: "agent-a",
      memory_mode: "tools",
      mode: "local_external",
    });
  });

  it("drops an unrecognized recall budget with a warning", () => {
    const { profile, warnings } = compileHermesProfileDetailed(
      baseInput({ hindsight: { bankId: "agent-a", apiUrl: "https://example.com/hindsight", recallBudget: "extreme" as never } }),
    );
    const json = JSON.parse(fileByPath(profile.files, "hermes/hindsight/config.json").content);
    expect(json.recall_budget).toBeUndefined();
    expect(warnings.some((w) => w.includes("recall_budget") && w.includes("extreme"))).toBe(true);
  });

  it("rejects an empty bank id", () => {
    expect(() => compileHermesProfile(baseInput({ hindsight: { bankId: "  ", apiUrl: "https://example.com/hindsight" } }))).toThrow();
  });

  it("always sets memory.provider to hindsight in config.yaml, regardless of the hindsight settings given", () => {
    const yaml = fileByPath(
      compileHermesProfile(baseInput({ hindsight: { bankId: "agent-a", apiUrl: "https://example.com/hindsight" } })).files,
      "hermes/config.yaml",
    ).content;
    expect(yaml).toContain('memory:\n  provider: "hindsight"');
  });

  // Regression guard for the bug this closes: hermes/hindsight/config.json
  // used to carry only bank_id/bank_mission/recall_budget/retain_tags. Once
  // that file exists on disk the vendor plugin stops consulting
  // HINDSIGHT_MODE (or any other env var) at all and falls back to its own
  // default of mode="cloud" with a public vectorize.io endpoint — so a
  // fleet bot must never be able to end up with an implicit "cloud". This
  // compiler now always writes an explicit mode, defaulting to
  // "local_external" (the fleet's only supported mode), so cloud only ever
  // happens when a caller opts in by name.
  it("defaults mode to local_external without being told to, never cloud", () => {
    const json = JSON.parse(
      fileByPath(
        compileHermesProfile(baseInput({ hindsight: { bankId: "agent-a", apiUrl: "https://example.com/hindsight" } })).files,
        "hermes/hindsight/config.json",
      ).content,
    );
    expect(json.mode).toBe("local_external");
  });

  it("rejects a local_external hindsight profile with no apiUrl (mode's default), rather than silently falling back to Hermes's own localhost default", () => {
    expect(() => compileHermesProfile(baseInput({ hindsight: { bankId: "agent-a" } }))).toThrow(
      /apiUrl.*must not be empty.*local_external/,
    );
  });

  it("also rejects an explicit mode: \"local_external\" with no apiUrl", () => {
    expect(() =>
      compileHermesProfile(baseInput({ hindsight: { bankId: "agent-a", mode: "local_external" } })),
    ).toThrow(/apiUrl/);
  });

  it("allows an explicit mode: \"cloud\" with no apiUrl — cloud has its own vendor default endpoint", () => {
    const json = JSON.parse(
      fileByPath(
        compileHermesProfile(baseInput({ hindsight: { bankId: "agent-a", mode: "cloud" } })).files,
        "hermes/hindsight/config.json",
      ).content,
    );
    expect(json.mode).toBe("cloud");
    expect(json.api_url).toBeUndefined();
  });

  it("falls back to local_external with a warning on an unrecognized mode", () => {
    const { profile, warnings } = compileHermesProfileDetailed(
      baseInput({ hindsight: { bankId: "agent-a", apiUrl: "https://example.com/hindsight", mode: "sky" as never } }),
    );
    const json = JSON.parse(fileByPath(profile.files, "hermes/hindsight/config.json").content);
    expect(json.mode).toBe("local_external");
    expect(warnings.some((w) => w.includes("hindsight.mode") && w.includes("sky"))).toBe(true);
  });

  it("writes memory_mode and auto_retain from the card when given, overriding this compiler's own tools/false defaults", () => {
    const json = JSON.parse(
      fileByPath(
        compileHermesProfile(
          baseInput({
            hindsight: {
              bankId: "agent-a",
              apiUrl: "https://example.com/hindsight",
              memoryMode: "hybrid",
              autoRetain: true,
            },
          }),
        ).files,
        "hermes/hindsight/config.json",
      ).content,
    );
    expect(json.memory_mode).toBe("hybrid");
    expect(json.auto_retain).toBe(true);
  });

  // Never writes hindsight's own api_key/apiKey into config.json — the key
  // goes through hermes/.env (HINDSIGHT_API_KEY) instead, same as every
  // other secret this compiler handles. Once config.json exists, the vendor
  // plugin's _cloud_api_key() still falls back to get_secret("HINDSIGHT_API_KEY")
  // as long as config.json has no "api_key"/"apiKey" key of its own.
  it("never writes an api_key/apiKey field into hindsight/config.json", () => {
    const json = JSON.parse(
      fileByPath(
        compileHermesProfile(
          baseInput({
            hindsight: { bankId: "agent-a", apiUrl: "https://example.com/hindsight" },
            env: { HINDSIGHT_API_KEY: { value: "sk-hindsight-secret-0001", secret: true } },
          }),
        ).files,
        "hermes/hindsight/config.json",
      ).content,
    );
    expect(json.api_key).toBeUndefined();
    expect(json.apiKey).toBeUndefined();
  });
});

describe("myrmidon(G2) compileHermesProfile — skills", () => {
  it("copies each skill file under hermes/skills-board/<skill>/<path>", () => {
    const profile = compileHermesProfile(
      baseInput({
        skills: {
          "code-review": [
            { path: "SKILL.md", content: "# Code review\n" },
            { path: "scripts/run.py", content: "print('ok')\n" },
          ],
        },
      }),
    );
    expect(fileByPath(profile.files, "hermes/skills-board/code-review/SKILL.md").content).toBe("# Code review\n");
    expect(fileByPath(profile.files, "hermes/skills-board/code-review/scripts/run.py").content).toBe(
      "print('ok')\n",
    );
  });

  it("drops a skill file whose path escapes the skill directory, with a warning", () => {
    const { profile, warnings } = compileHermesProfileDetailed(
      baseInput({ skills: { "code-review": [{ path: "../../etc/passwd", content: "x" }] } }),
    );
    expect(profile.files.some((f) => f.path.includes("etc/passwd"))).toBe(false);
    expect(warnings.some((w) => w.includes("code-review") && w.includes("escapes"))).toBe(true);
  });

  it("drops an unsafe skill name, with a warning", () => {
    const { profile, warnings } = compileHermesProfileDetailed(
      baseInput({ skills: { "../evil": [{ path: "SKILL.md", content: "x" }] } }),
    );
    expect(profile.files.some((f) => f.path.includes("evil"))).toBe(false);
    expect(warnings.some((w) => w.includes("unsafe skill name"))).toBe(true);
  });

  it("compiles with no skills at all", () => {
    const profile = compileHermesProfile(baseInput({ skills: {} }));
    expect(profile.files.some((f) => f.path.startsWith("hermes/skills-board/"))).toBe(false);
  });
});

describe("myrmidon(G2) compileHermesProfile — instructions / AGENTS.md", () => {
  it("writes the instructions text verbatim, unwarned, when at or under the Hermes limit", () => {
    const instructions = "x".repeat(20_000);
    const { profile, warnings } = compileHermesProfileDetailed(baseInput({ instructions }));
    expect(fileByPath(profile.files, "workspace/AGENTS.md").content).toBe(instructions);
    expect(warnings.some((w) => w.includes("AGENTS.md"))).toBe(false);
  });

  it("warns, but still writes the full text, when the instructions exceed the Hermes limit", () => {
    const instructions = "x".repeat(20_001);
    const { profile, warnings } = compileHermesProfileDetailed(baseInput({ instructions }));
    expect(fileByPath(profile.files, "workspace/AGENTS.md").content).toBe(instructions);
    expect(warnings.some((w) => w.includes("AGENTS.md") && w.includes("20001"))).toBe(true);
  });

  // 20,000 is only Hermes's CONTEXT_FILE_MAX_CHARS *floor*
  // (agent/prompt_builder.py); the effective runtime limit is
  // max(floor, min(model_context_length * 4 * 0.06, 500_000)), which for a
  // large-context model is far above 20,000. HermesProfileInput carries no
  // model context length, so the warning must not claim 20,000 is the actual
  // cutoff for this bot.
  it("phrases the AGENTS.md warning as a floor, not the bot's actual runtime cutoff", () => {
    const instructions = "x".repeat(20_001);
    const { warnings } = compileHermesProfileDetailed(baseInput({ instructions }));
    const warning = warnings.find((w) => w.includes("AGENTS.md"));
    expect(warning).toBeDefined();
    expect(warning).toContain("floor");
    expect(warning).toContain("may truncate");
    expect(warning).not.toContain("Hermes truncates it at runtime");
  });
});

describe("myrmidon(G2) compileHermesProfile — instance defaults", () => {
  it("maps compression settings", () => {
    const yaml = fileByPath(
      compileHermesProfile(
        baseInput({ instanceDefaults: { compression: { enabled: true, threshold: 0.5, targetRatio: 0.2 } } }),
      ).files,
      "hermes/config.yaml",
    ).content;
    expect(yaml).toContain("compression:\n  enabled: true\n  target_ratio: 0.2\n  threshold: 0.5");
  });

  it("maps sessionsRetentionDays to sessions.retention_days", () => {
    const yaml = fileByPath(
      compileHermesProfile(baseInput({ instanceDefaults: { sessionsRetentionDays: 30 } })).files,
      "hermes/config.yaml",
    ).content;
    expect(yaml).toContain("sessions:\n  retention_days: 30");
  });

  it("leaves compression and sessions out of the document when unset", () => {
    const yaml = fileByPath(compileHermesProfile(baseInput()).files, "hermes/config.yaml").content;
    expect(yaml).not.toContain("compression:");
    expect(yaml).not.toContain("sessions:");
  });
});

describe("myrmidon(G2) classifyProfileChange integration", () => {
  it("reports \"restart\" on first apply (no applied hashes yet)", () => {
    const profile = compileHermesProfile(baseInput());
    expect(classifyProfileChange({}, profile)).toBe("restart");
  });

  it("reports \"none\" once both hashes match the applied state", () => {
    const profile = compileHermesProfile(baseInput());
    expect(classifyProfileChange({ restartHash: profile.restartHash, filesHash: profile.filesHash }, profile)).toBe(
      "none",
    );
  });

  it("reports \"restart\" when a restart-class field changes (the model)", () => {
    const before = compileHermesProfile(baseInput({ adapterConfig: { model: "vendor/model-a" } }));
    const after = compileHermesProfile(baseInput({ adapterConfig: { model: "vendor/model-b" } }));
    expect(
      classifyProfileChange({ restartHash: before.restartHash, filesHash: before.filesHash }, after),
    ).toBe("restart");
  });

  // Skills are restart-class, not files-class: the vendor gateway's skills
  // index is cached in-process (LRU + disk snapshot) and does not watch the
  // skills directory, so a running gateway never picks up an added,
  // removed or edited skill on its own — see the compiler's comment at the
  // skillFiles call site. A files-class classification here (the old
  // behavior) meant the reconciler would write the new files and then never
  // restart the gateway to pick them up.
  it("reports \"restart\" when an existing skill's content changes (skills are restart-class)", () => {
    const before = compileHermesProfile(
      baseInput({ skills: { "code-review": [{ path: "SKILL.md", content: "v1" }] } }),
    );
    const after = compileHermesProfile(
      baseInput({ skills: { "code-review": [{ path: "SKILL.md", content: "v2" }] } }),
    );
    expect(before.restartHash).not.toBe(after.restartHash);
    expect(classifyProfileChange({ restartHash: before.restartHash, filesHash: before.filesHash }, after)).toBe(
      "restart",
    );
  });

  it("reports \"restart\" when a skill is added", () => {
    const before = compileHermesProfile(baseInput({ skills: {} }));
    const after = compileHermesProfile(
      baseInput({ skills: { "new-skill": [{ path: "SKILL.md", content: "# New\n" }] } }),
    );
    expect(before.restartHash).not.toBe(after.restartHash);
    expect(classifyProfileChange({ restartHash: before.restartHash, filesHash: before.filesHash }, after)).toBe(
      "restart",
    );
  });

  it("reports \"restart\" when a skill is removed", () => {
    const before = compileHermesProfile(
      baseInput({ skills: { "old-skill": [{ path: "SKILL.md", content: "# Old\n" }] } }),
    );
    const after = compileHermesProfile(baseInput({ skills: {} }));
    expect(before.restartHash).not.toBe(after.restartHash);
    expect(classifyProfileChange({ restartHash: before.restartHash, filesHash: before.filesHash }, after)).toBe(
      "restart",
    );
  });

  it("reports \"files\" when only AGENTS.md changes (still the one files-class field)", () => {
    const before = compileHermesProfile(baseInput({ instructions: "v1" }));
    const after = compileHermesProfile(baseInput({ instructions: "v2" }));
    expect(before.restartHash).toBe(after.restartHash);
    expect(before.filesHash).not.toBe(after.filesHash);
    expect(classifyProfileChange({ restartHash: before.restartHash, filesHash: before.filesHash }, after)).toBe(
      "files",
    );
  });
});
