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
    hindsight: { bankId: "agent-a" },
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
});

describe("myrmidon(G2) compileHermesProfile — hindsight settings", () => {
  it("writes bank_id, mission, recall_budget and tags, sorted, no connection details", () => {
    const profile = compileHermesProfile(
      baseInput({
        hindsight: { bankId: "agent-a", mission: "Keep the shop running.", recallBudget: "high", tags: [" ops ", "shop", ""] },
      }),
    );
    const json = JSON.parse(fileByPath(profile.files, "hermes/hindsight/config.json").content);
    expect(json).toEqual({
      bank_id: "agent-a",
      mission: "Keep the shop running.",
      recall_budget: "high",
      tags: ["ops", "shop"],
    });
  });

  it("omits mission, recall_budget and tags when unset", () => {
    const profile = compileHermesProfile(baseInput({ hindsight: { bankId: "agent-a" } }));
    const json = JSON.parse(fileByPath(profile.files, "hermes/hindsight/config.json").content);
    expect(json).toEqual({ bank_id: "agent-a" });
  });

  it("drops an unrecognized recall budget with a warning", () => {
    const { profile, warnings } = compileHermesProfileDetailed(
      baseInput({ hindsight: { bankId: "agent-a", recallBudget: "extreme" as never } }),
    );
    const json = JSON.parse(fileByPath(profile.files, "hermes/hindsight/config.json").content);
    expect(json.recall_budget).toBeUndefined();
    expect(warnings.some((w) => w.includes("recall_budget") && w.includes("extreme"))).toBe(true);
  });

  it("rejects an empty bank id", () => {
    expect(() => compileHermesProfile(baseInput({ hindsight: { bankId: "  " } }))).toThrow();
  });

  it("always sets memory.provider to hindsight in config.yaml, regardless of the hindsight settings given", () => {
    const yaml = fileByPath(
      compileHermesProfile(baseInput({ hindsight: { bankId: "agent-a" } })).files,
      "hermes/config.yaml",
    ).content;
    expect(yaml).toContain('memory:\n  provider: "hindsight"');
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

  it("reports \"files\" when only a files-class field changes (a skill's content)", () => {
    const before = compileHermesProfile(
      baseInput({ skills: { "code-review": [{ path: "SKILL.md", content: "v1" }] } }),
    );
    const after = compileHermesProfile(
      baseInput({ skills: { "code-review": [{ path: "SKILL.md", content: "v2" }] } }),
    );
    expect(before.restartHash).toBe(after.restartHash);
    expect(before.filesHash).not.toBe(after.filesHash);
    expect(classifyProfileChange({ restartHash: before.restartHash, filesHash: before.filesHash }, after)).toBe(
      "files",
    );
  });
});
