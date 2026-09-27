/**
 * Myrmidon (P4): run-scoped MCP delivery, prompt on stdin and spawn envelope
 * check for the hermes_local adapter.
 *
 * The execute()-level cases run the real filesystem path with a mocked
 * runChildProcess, so the assertions read exactly what the child process would
 * have seen at spawn time.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
    })),
  };
});

import { execute } from "./execute.js";
import {
  MAX_SPAWN_ARG_BYTES,
  RUNTIME_MCP_URL_BASE_ENV,
  applyRuntimeMcpToolsetsToArgs,
  assertSpawnEnvelopeFits,
  materializeRunScopedHermesMcp,
  mergeRuntimeMcpIntoConfigYaml,
  mergeRuntimeMcpIntoToolsets,
  planRuntimeMcpEntries,
  readConfiguredMcpServerNames,
  resolveRuntimeMcpUrlBase,
  rewriteRuntimeMcpServerUrl,
  type HermesRuntimeMcpEntry,
} from "./myrmidon-runtime-mcp.js";
import type { AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";
import * as serverUtils from "@paperclipai/adapter-utils/server-utils";

const PROFILE_CONFIG = [
  "model:",
  "  default: test-model",
  "  provider: custom",
  "memory:",
  "  provider: hindsight",
  "mcp_servers:",
  "  docs-search:",
  "    url: http://192.0.2.10:9385/mcp",
  "    connect_timeout: 30.0",
  "    enabled: true",
  "",
].join("\n");

const RUNTIME_SERVER: AdapterRuntimeMcpServer = {
  name: "paperclip-assigned",
  url: "https://board.example.com/mcp/gateways/gw-public-id",
  token: "run-scoped-token-value",
  connectionId: "assignment:connection-a",
};

const tempDirs: string[] = [];

async function makeRealHermesHome(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "myrmidon-p4-test-"));
  tempDirs.push(root);
  const home = path.join(root, "profiles", "agent-a");
  await fs.mkdir(path.join(home, "skills"), { recursive: true });
  await fs.writeFile(path.join(home, "config.yaml"), PROFILE_CONFIG, "utf8");
  await fs.writeFile(path.join(home, ".env"), "EXISTING=1\n", "utf8");
  await fs.writeFile(path.join(home, "state.db"), "db", "utf8");
  return home;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// Line-oriented config merge
// ---------------------------------------------------------------------------

describe("P4 config.yaml merge", () => {
  it("reads the server names declared in the profile config", () => {
    expect(readConfiguredMcpServerNames(PROFILE_CONFIG)).toEqual(["docs-search"]);
    // Nested per-server keys (deeper indent) are not server names.
    expect(readConfiguredMcpServerNames(PROFILE_CONFIG)).not.toContain("url");
    expect(readConfiguredMcpServerNames("model:\n  default: x\n")).toEqual([]);
  });

  it("stops at the next top-level key", () => {
    const configYaml = [
      "mcp_servers:",
      "  docs-search:",
      "    enabled: true",
      "plugins:",
      "  enabled:",
      "    - rag-search",
      "",
    ].join("\n");
    expect(readConfiguredMcpServerNames(configYaml)).toEqual(["docs-search"]);
  });

  it("keeps the existing servers and adds the run-scoped one", () => {
    const entries = planRuntimeMcpEntries([RUNTIME_SERVER], readConfiguredMcpServerNames(PROFILE_CONFIG));
    const merged = mergeRuntimeMcpIntoConfigYaml(PROFILE_CONFIG, entries);
    expect(merged).not.toBeNull();
    const lines = (merged as string).split("\n");
    expect(readConfiguredMcpServerNames(merged as string)).toEqual(["paperclip-assigned", "docs-search"]);
    // insert, not append: children of the existing block stay inside it
    const keyIndex = lines.indexOf("mcp_servers:");
    expect(lines[keyIndex + 1]).toBe("  # BEGIN PAPERCLIP MANAGED MCP");
    expect(lines[keyIndex + 2]).toBe("  paperclip-assigned:");
    expect(lines[keyIndex + 3]).toBe('    url: "https://board.example.com/mcp/gateways/gw-public-id"');
    expect(merged as string).toContain("  docs-search:");
    expect(merged as string).toContain(`url: "https://board.example.com/mcp/gateways/gw-public-id"`);
    expect(merged as string).toContain(`Authorization: "Bearer run-scoped-token-value"`);
  });

  it("creates the block when the profile has none", () => {
    const merged = mergeRuntimeMcpIntoConfigYaml("model:\n  default: x\n", [
      { name: "paperclip-assigned", url: "https://example.com/mcp", token: "t", connectionId: "c" },
    ]);
    expect(merged).not.toBeNull();
    expect(readConfiguredMcpServerNames(merged as string)).toEqual(["paperclip-assigned"]);
  });

  it("is idempotent (a repeated materialization does not stack blocks)", () => {
    const entries = planRuntimeMcpEntries([RUNTIME_SERVER]);
    const once = mergeRuntimeMcpIntoConfigYaml(PROFILE_CONFIG, entries) as string;
    const twice = mergeRuntimeMcpIntoConfigYaml(once, entries) as string;
    expect(twice).toBe(once);
  });

  it("renames instead of shadowing a profile server with the same name", () => {
    const entries = planRuntimeMcpEntries(
      [{ ...RUNTIME_SERVER, name: "docs-search" }],
      ["docs-search"],
    );
    expect(entries[0]?.name).toBe("paperclip-docs-search");
  });

  it("bails out on a flow-style value instead of writing invalid YAML", () => {
    expect(mergeRuntimeMcpIntoConfigYaml("mcp_servers: {docs-search: {url: x}}\n", [
      { name: "paperclip-assigned", url: "https://example.com/mcp", token: "t", connectionId: "c" },
    ])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// `-t/--toolsets` spawn allowlist
// ---------------------------------------------------------------------------

describe("P4 toolset allowlist", () => {
  it("appends the run-scoped and profile-declared server names", () => {
    expect(mergeRuntimeMcpIntoToolsets("terminal,web", ["paperclip-assigned", "docs-search"])).toBe(
      "terminal,web,paperclip-assigned,docs-search",
    );
  });

  it("leaves the flag untouched when there is no toolsets list", () => {
    // No `-t` => no MCP filter => every configured server spawns; adding a list
    // here would silently restrict the built-in tool surface.
    expect(mergeRuntimeMcpIntoToolsets(undefined, ["paperclip-assigned"])).toBeUndefined();
    expect(mergeRuntimeMcpIntoToolsets("", ["paperclip-assigned"])).toBeUndefined();
  });

  it("does not duplicate names already present", () => {
    expect(mergeRuntimeMcpIntoToolsets("terminal,paperclip-assigned", ["paperclip-assigned"])).toBe(
      "terminal,paperclip-assigned",
    );
  });
});

// ---------------------------------------------------------------------------
// Run-scoped home materialization (real filesystem)
// ---------------------------------------------------------------------------

describe("P4 materializeRunScopedHermesMcp", () => {
  it("builds a temporary profile home that links the real one and keeps the token out of it", async () => {
    const realHome = await makeRealHermesHome();
    const logs: string[] = [];
    const materialized = await materializeRunScopedHermesMcp({
      servers: [RUNTIME_SERVER],
      hermesHome: realHome,
      runId: "run-a",
      onLog: async (_stream, chunk) => {
        logs.push(chunk);
      },
    });

    expect(materialized).not.toBeNull();
    const runHome = materialized!.hermesHome;
    expect(path.basename(path.dirname(runHome))).toBe("profiles");
    expect(path.basename(runHome)).toBe("agent-a");
    expect(path.basename(path.dirname(path.dirname(runHome)))).toContain("paperclip-hermes-home-");

    // profile state is reachable through symlinks; only config.yaml is real
    expect(await fs.readlink(path.join(runHome, "skills"))).toBe(path.join(realHome, "skills"));
    expect(await fs.readlink(path.join(runHome, "state.db"))).toBe(path.join(realHome, "state.db"));
    expect((await fs.readFile(path.join(runHome, ".env"), "utf8")).trim()).toBe("EXISTING=1");

    const configPath = path.join(runHome, "config.yaml");
    const stat = await fs.stat(configPath);
    expect(stat.mode & 0o777).toBe(0o600);
    const materializedConfig = await fs.readFile(configPath, "utf8");
    expect(readConfiguredMcpServerNames(materializedConfig)).toEqual([
      "paperclip-assigned",
      "docs-search",
    ]);

    // the shared profile config is never written to
    expect(await fs.readFile(path.join(realHome, "config.yaml"), "utf8")).toBe(PROFILE_CONFIG);
    expect(materialized!.toolsetNames).toEqual(["paperclip-assigned", "docs-search"]);

    // the token is not logged
    expect(logs.join("")).not.toContain(RUNTIME_SERVER.token);
    expect(logs.join("")).toContain("paperclip-assigned");

    await materialized!.cleanup();
    expect(fsSync.existsSync(path.dirname(path.dirname(runHome)))).toBe(false);
  });

  it("does nothing without runtime MCP servers", async () => {
    const realHome = await makeRealHermesHome();
    expect(
      await materializeRunScopedHermesMcp({ servers: [], hermesHome: realHome, runId: "r" }),
    ).toBeNull();
  });

  it("does nothing (and says why) without a HERMES_HOME", async () => {
    const logs: string[] = [];
    const result = await materializeRunScopedHermesMcp({
      servers: [RUNTIME_SERVER],
      hermesHome: undefined,
      runId: "r",
      onLog: async (_stream, chunk) => {
        logs.push(chunk);
      },
    });
    expect(result).toBeNull();
    expect(logs.join("")).toContain("HERMES_HOME is not set");
  });

  it("can drop the profile-declared names from the allowlist", async () => {
    const realHome = await makeRealHermesHome();
    const materialized = await materializeRunScopedHermesMcp({
      servers: [RUNTIME_SERVER],
      hermesHome: realHome,
      runId: "r",
      includeConfiguredServerNames: false,
    });
    expect(materialized!.toolsetNames).toEqual(["paperclip-assigned"]);
    await materialized!.cleanup();
  });
});

// ---------------------------------------------------------------------------
// execute(): what the spawned CLI actually receives
// ---------------------------------------------------------------------------

function makeCtx(input: {
  realHome: string;
  toolsets?: string;
  servers?: AdapterRuntimeMcpServer[];
  extraConfig?: Record<string, unknown>;
  logs?: string[];
}) {
  const onLog = vi.fn(async (_stream: "stdout" | "stderr", chunk: string) => {
    input.logs?.push(chunk);
  });
  const runtimeMcp =
    input.servers === undefined ? undefined : { getServers: () => input.servers as AdapterRuntimeMcpServer[] };
  return {
    ctx: {
      runId: "run-execute-a",
      agent: {
        id: "agent-a",
        companyId: "company-a",
        name: "agent-a",
        adapterType: "hermes_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      runtimeMcp,
      config: {
        command: "/usr/bin/hermes",
        provider: "custom",
        quiet: true,
        timeoutSec: 60,
        graceSec: 5,
        env: { HERMES_HOME: input.realHome },
        ...(input.toolsets === undefined ? {} : { toolsets: input.toolsets }),
        ...(input.extraConfig ?? {}),
      },
      context: { issueId: "issue-a", wakeReason: "manual", paperclipWake: null },
      onLog,
    } as unknown as Record<string, unknown>,
    onLog,
  };
}

describe("P4 execute() spawn contract", () => {
  const observed: {
    args?: string[];
    hermesHome?: string;
    configYaml?: string;
    configMode?: number;
    logs: string[];
  } = { logs: [] };

  beforeEach(() => {
    observed.args = undefined;
    observed.hermesHome = undefined;
    observed.configYaml = undefined;
    observed.configMode = undefined;
    observed.logs = [];
    vi.mocked(serverUtils.runChildProcess).mockImplementation(async (_runId, _cmd, args, opts) => {
      const spawnOpts = opts as { env: Record<string, string> };
      observed.args = args as string[];
      observed.hermesHome = spawnOpts.env.HERMES_HOME;
      const configPath = path.join(spawnOpts.env.HERMES_HOME ?? "", "config.yaml");
      try {
        observed.configYaml = await fs.readFile(configPath, "utf8");
        observed.configMode = (await fs.stat(configPath)).mode & 0o777;
      } catch {
        // no run-scoped config in this scenario
      }
      return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", pid: null, startedAt: null };
    });
  });

  it("hands the run-scoped server to the CLI and cleans the temporary home up", async () => {
    const realHome = await makeRealHermesHome();
    const { ctx, onLog } = makeCtx({
      realHome,
      toolsets: "terminal,web",
      servers: [RUNTIME_SERVER],
      extraConfig: { runtimeMcpUrlBase: "http://127.0.0.1:3100" },
    });

    await execute(ctx as never);

    // `-t` carries the run-scoped name: with a toolsets list the CLI treats it
    // as the MCP spawn allowlist and would otherwise never start the gateway.
    const toolsetsIndex = observed.args?.indexOf("-t") ?? -1;
    expect(toolsetsIndex).toBeGreaterThan(-1);
    expect(observed.args?.[toolsetsIndex + 1]).toBe("terminal,web,paperclip-assigned,docs-search");

    // the child sees a temporary HERMES_HOME, not the shared profile
    expect(observed.hermesHome).toBeTruthy();
    expect(observed.hermesHome).not.toBe(realHome);
    expect(observed.configMode).toBe(0o600);
    expect(readConfiguredMcpServerNames(observed.configYaml ?? "")).toEqual([
      "paperclip-assigned",
      "docs-search",
    ]);
    // the gateway must be reachable from inside the run container
    expect(observed.configYaml ?? "").toContain('url: "http://127.0.0.1:3100/mcp/gateways/gw-public-id"');

    // the shared profile config is untouched and the token is nowhere in the log
    expect(await fs.readFile(path.join(realHome, "config.yaml"), "utf8")).toBe(PROFILE_CONFIG);
    const logged = onLog.mock.calls.map((call) => String(call[1])).join("");
    expect(logged).not.toContain(RUNTIME_SERVER.token);

    // both run-scoped artifacts are removed once the child is gone
    expect(fsSync.existsSync(observed.hermesHome as string)).toBe(false);
  });

  it("keeps the previous behavior for an agent without MCP connections", async () => {
    const realHome = await makeRealHermesHome();
    const { ctx } = makeCtx({ realHome, toolsets: "terminal", logs: observed.logs });

    await execute(ctx as never);

    const toolsetsIndex = observed.args?.indexOf("-t") ?? -1;
    expect(observed.args?.[toolsetsIndex + 1]).toBe("terminal");
    expect(observed.hermesHome).toBe(realHome);
    const logged = observed.logs.join("");
    expect(logged).not.toContain("Run-scoped MCP");
  });

  it("honors includeConfiguredMcpServers: false", async () => {
    const realHome = await makeRealHermesHome();
    const { ctx } = makeCtx({
      realHome,
      toolsets: "terminal",
      servers: [RUNTIME_SERVER],
      extraConfig: { includeConfiguredMcpServers: false },
    });

    await execute(ctx as never);

    const toolsetsIndex = observed.args?.indexOf("-t") ?? -1;
    expect(observed.args?.[toolsetsIndex + 1]).toBe("terminal,paperclip-assigned");
  });

  it("runs without the connection tools when materialization fails", async () => {
    const realHome = await makeRealHermesHome();
    // Flow-style mcp_servers: the merge refuses to touch it.
    await fs.writeFile(path.join(realHome, "config.yaml"), "mcp_servers: {docs-search: {url: x}}\n", "utf8");
    const { ctx, onLog } = makeCtx({
      realHome,
      toolsets: "terminal",
      servers: [RUNTIME_SERVER],
    });

    const result = await execute(ctx as never);

    expect(result.exitCode).toBe(0);
    const toolsetsIndex = observed.args?.indexOf("-t") ?? -1;
    expect(observed.args?.[toolsetsIndex + 1]).toBe("terminal");
    expect(observed.hermesHome).toBe(realHome);
    const logged = onLog.mock.calls.map((call) => String(call[1])).join("");
    expect(logged).toContain("run-scoped MCP servers were not materialized");
  });
});

// ---------------------------------------------------------------------------
// Gateway origin rewrite (public mTLS origin -> in-container listener)
// ---------------------------------------------------------------------------

describe("P4 gateway origin", () => {
  it("does not rewrite by default and honors the instance setting and agent overrides", () => {
    // Fork default: same as the vendor, the server-supplied URL is used as is.
    expect(resolveRuntimeMcpUrlBase({ instanceEnv: {} })).toBeNull();
    expect(resolveRuntimeMcpUrlBase({ instanceEnv: { PORT: "3100" } })).toBeNull();
    // Instance-level setting turns the rewrite on.
    expect(
      resolveRuntimeMcpUrlBase({ instanceEnv: { [RUNTIME_MCP_URL_BASE_ENV]: " http://127.0.0.1:3100/ " } }),
    ).toBe("http://127.0.0.1:3100");
    // Agent override wins over the instance setting.
    expect(
      resolveRuntimeMcpUrlBase({
        configUrlBase: " https://internal.example.com:9443/ ",
        instanceEnv: { [RUNTIME_MCP_URL_BASE_ENV]: "http://127.0.0.1:3100" },
      }),
    ).toBe("https://internal.example.com:9443");
    // Agent opt-out wins over both.
    expect(
      resolveRuntimeMcpUrlBase({
        configUrlBase: "https://internal.example.com:9443",
        configRewrite: false,
        instanceEnv: { [RUNTIME_MCP_URL_BASE_ENV]: "http://127.0.0.1:3100" },
      }),
    ).toBeNull();
  });

  it("keeps path and query, and leaves other shapes alone", () => {
    expect(
      rewriteRuntimeMcpServerUrl(
        "https://board.example.com:8443/mcp/gateways/gw-1?x=1",
        "http://127.0.0.1:3100",
      ),
    ).toBe("http://127.0.0.1:3100/mcp/gateways/gw-1?x=1");
    expect(
      rewriteRuntimeMcpServerUrl("http://127.0.0.1:3100/mcp/gateways/gw-1", "http://127.0.0.1:3100"),
    ).toBe("http://127.0.0.1:3100/mcp/gateways/gw-1");
    expect(rewriteRuntimeMcpServerUrl("not a url", "http://127.0.0.1:3100")).toBe("not a url");
  });

  it("rewrites the materialized entry but keeps the run token", async () => {
    const realHome = await makeRealHermesHome();
    const logs: string[] = [];
    const materialized = await materializeRunScopedHermesMcp({
      servers: [{ ...RUNTIME_SERVER, url: "https://board.example.com:8443/mcp/gateways/gw-public-id" }],
      hermesHome: realHome,
      runId: "r",
      urlBase: "http://127.0.0.1:3100",
      onLog: async (_stream, chunk) => {
        logs.push(chunk);
      },
    });
    const configYaml = await fs.readFile(materialized!.configPath, "utf8");
    expect(configYaml).toContain('url: "http://127.0.0.1:3100/mcp/gateways/gw-public-id"');
    expect(configYaml).not.toContain("board.example.com");
    expect(configYaml).toContain(`Authorization: "Bearer ${RUNTIME_SERVER.token}"`);
    expect(logs.join("")).toContain(
      "gateway origin rewritten https://board.example.com:8443 -> http://127.0.0.1:3100",
    );
    expect(logs.join("")).not.toContain(RUNTIME_SERVER.token);
    await materialized!.cleanup();
  });

  it("hands the server URL through without an internal base", async () => {
    const realHome = await makeRealHermesHome();
    const materialized = await materializeRunScopedHermesMcp({
      servers: [{ ...RUNTIME_SERVER, url: "https://board.example.com:8443/mcp/gateways/gw-public-id" }],
      hermesHome: realHome,
      runId: "r",
      urlBase: null,
    });
    const configYaml = await fs.readFile(materialized!.configPath, "utf8");
    expect(configYaml).toContain('url: "https://board.example.com:8443/mcp/gateways/gw-public-id"');
    await materialized!.cleanup();
  });
});

// ---------------------------------------------------------------------------
// execute(): gateway URL, stdin prompt, spawn envelope
// ---------------------------------------------------------------------------

describe("P4 execute() gateway URL, prompt and envelope", () => {
  const observed: { args?: string[]; stdin?: string; env?: Record<string, string>; configYaml?: string } = {};
  let previousInstanceBase: string | undefined;

  beforeEach(() => {
    observed.args = undefined;
    observed.stdin = undefined;
    observed.env = undefined;
    observed.configYaml = undefined;
    previousInstanceBase = process.env[RUNTIME_MCP_URL_BASE_ENV];
    delete process.env[RUNTIME_MCP_URL_BASE_ENV];
    vi.mocked(serverUtils.runChildProcess).mockReset();
    vi.mocked(serverUtils.runChildProcess).mockImplementation(async (_runId, _cmd, args, opts) => {
      const spawnOpts = opts as { env: Record<string, string>; stdin?: string };
      observed.args = args as string[];
      observed.stdin = spawnOpts.stdin;
      observed.env = spawnOpts.env;
      try {
        observed.configYaml = await fs.readFile(path.join(spawnOpts.env.HERMES_HOME ?? "", "config.yaml"), "utf8");
      } catch {
        // no config in this scenario
      }
      return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", pid: null, startedAt: null };
    });
  });

  afterEach(() => {
    if (previousInstanceBase === undefined) delete process.env[RUNTIME_MCP_URL_BASE_ENV];
    else process.env[RUNTIME_MCP_URL_BASE_ENV] = previousInstanceBase;
  });

  it("keeps the gateway URL unchanged without the setting", async () => {
    const realHome = await makeRealHermesHome();
    const { ctx, onLog } = makeCtx({ realHome, servers: [RUNTIME_SERVER] });

    await execute(ctx as never);

    expect(observed.configYaml ?? "").toContain(`url: "${RUNTIME_SERVER.url}"`);
    const logged = onLog.mock.calls.map((call) => String(call[1])).join("");
    expect(logged).not.toContain("gateway origin rewritten");
  });

  it("rewrites the gateway origin when the instance setting is set", async () => {
    process.env[RUNTIME_MCP_URL_BASE_ENV] = "http://127.0.0.1:3100";
    const realHome = await makeRealHermesHome();
    const { ctx, onLog } = makeCtx({ realHome, servers: [RUNTIME_SERVER] });

    await execute(ctx as never);

    expect(observed.configYaml ?? "").toContain('url: "http://127.0.0.1:3100/mcp/gateways/gw-public-id"');
    const logged = onLog.mock.calls.map((call) => String(call[1])).join("");
    expect(logged).toContain("gateway origin rewritten https://board.example.com -> http://127.0.0.1:3100");
    expect(logged).not.toContain(RUNTIME_SERVER.token);
  });

  it("lets an agent opt out of the instance rewrite", async () => {
    process.env[RUNTIME_MCP_URL_BASE_ENV] = "http://127.0.0.1:3100";
    const realHome = await makeRealHermesHome();
    const { ctx } = makeCtx({ realHome, servers: [RUNTIME_SERVER], extraConfig: { runtimeMcpUrlRewrite: false } });

    await execute(ctx as never);

    expect(observed.configYaml ?? "").toContain(`url: "${RUNTIME_SERVER.url}"`);
  });

  it("sends the prompt on stdin and keeps it out of the process arguments", async () => {
    const realHome = await makeRealHermesHome();
    const bigBrief = `Task brief ${"x".repeat(300 * 1024)}`;
    const { ctx } = makeCtx({ realHome, extraConfig: { promptTemplate: bigBrief } });

    await execute(ctx as never);

    expect(observed.args?.slice(0, 3)).toEqual(["chat", "--query-file", "-"]);
    expect(observed.args).not.toContain("-q");
    expect(observed.stdin).toContain("Task brief");
    expect(observed.stdin!.length).toBeGreaterThan(300 * 1024);
    for (const arg of observed.args ?? []) {
      expect(arg).not.toContain("Task brief");
      expect(Buffer.byteLength(arg, "utf8")).toBeLessThan(MAX_SPAWN_ARG_BYTES);
    }
  });

  it("refuses to spawn with a clear error when the envelope is too large", async () => {
    const realHome = await makeRealHermesHome();
    const { ctx } = makeCtx({
      realHome,
      servers: [RUNTIME_SERVER],
      extraConfig: { env: { HERMES_HOME: realHome, HUGE_VALUE: "y".repeat(200 * 1024) } },
    });

    await expect(execute(ctx as never)).rejects.toMatchObject({
      name: "HermesSpawnEnvelopeTooLargeError",
      code: "spawn_envelope_too_large",
    });
    expect(serverUtils.runChildProcess).not.toHaveBeenCalled();
    // The run-scoped home is removed even though nothing was spawned.
    const leftovers = (await fs.readdir(os.tmpdir())).filter((name) => name.startsWith("paperclip-hermes-home-run-execute-a-"));
    expect(leftovers).toEqual([]);
  });

  it("removes the run-scoped home when the child process fails", async () => {
    const realHome = await makeRealHermesHome();
    let seenHome: string | undefined;
    vi.mocked(serverUtils.runChildProcess).mockImplementation(async (_runId, _cmd, _args, opts) => {
      seenHome = (opts as { env: Record<string, string> }).env.HERMES_HOME;
      throw new Error("spawn failed");
    });
    const { ctx } = makeCtx({ realHome, servers: [RUNTIME_SERVER] });

    await expect(execute(ctx as never)).rejects.toThrow("spawn failed");
    expect(seenHome).toBeTruthy();
    expect(seenHome).not.toBe(realHome);
    expect(fsSync.existsSync(seenHome as string)).toBe(false);
  });
});

describe("P4 spawn envelope check", () => {
  it("accepts a normal envelope", () => {
    expect(() => assertSpawnEnvelopeFits(["chat", "--query-file", "-"], { PATH: "/usr/bin" })).not.toThrow();
  });

  it("rejects a single oversized argument", () => {
    expect(() => assertSpawnEnvelopeFits(["chat", "z".repeat(MAX_SPAWN_ARG_BYTES + 1)], {})).toThrow(
      /spawn_envelope_too_large: refusing to start Hermes - argv\[1\]/,
    );
  });

  it("rejects a single oversized environment variable", () => {
    expect(() => assertSpawnEnvelopeFits(["chat"], { BIG: "z".repeat(MAX_SPAWN_ARG_BYTES) })).toThrow(
      /environment variable BIG/,
    );
  });

  it("rejects an oversized combined envelope", () => {
    const env: Record<string, string> = {};
    for (let i = 0; i < 12; i++) env[`VAR_${i}`] = "z".repeat(100 * 1024);
    expect(() => assertSpawnEnvelopeFits(["chat"], env)).toThrow(/combined argv and environment/);
  });
});

describe("P4 -t argument rewrite", () => {
  it("rewrites only the adapter's own -t value", () => {
    const args = ["chat", "--query-file", "-", "-t", "terminal", "--source", "tool", "-t", "extra"];
    applyRuntimeMcpToolsetsToArgs(args, "terminal", ["paperclip-assigned"]);
    expect(args).toEqual(["chat", "--query-file", "-", "-t", "terminal,paperclip-assigned", "--source", "tool", "-t", "extra"]);
  });

  it("adds no -t when the agent has no toolsets list", () => {
    const args = ["chat", "--query-file", "-"];
    applyRuntimeMcpToolsetsToArgs(args, undefined, ["paperclip-assigned"]);
    expect(args).toEqual(["chat", "--query-file", "-"]);
  });
});

// Type-level guard: the helper contract stays usable from the execute() wiring.
const _entryTypeGuard: HermesRuntimeMcpEntry = {
  name: "x",
  url: "https://example.com/mcp",
  token: "t",
  connectionId: "c",
};
void _entryTypeGuard;