/**
 * Myrmidon (P4): run-scoped MCP servers and spawn envelope checks for the
 * hermes_local adapter.
 *
 * The server builds a run-scoped MCP gateway for the agent's assigned tool
 * connections and hands it to the adapter as `ctx.runtimeMcp`. The Hermes CLI
 * reads MCP servers only from `<HERMES_HOME>/config.yaml`, and the agent profile
 * is shared between runs while the gateway token is short-lived. So each run
 * gets a temporary HERMES_HOME: symlinks to every entry of the real profile plus
 * its own `config.yaml` copy (0600) that carries the run-scoped servers. The
 * directory is removed when the child process exits.
 *
 * `-t/--toolsets` doubles as the Hermes MCP spawn allowlist (a configured server
 * starts only when its name is in the list), so the run-scoped names, and the
 * names the profile already declares, are appended to it.
 *
 * The gateway URL is built by the server from its public origin. When that
 * origin is not reachable from the run (for example behind a client-certificate
 * proxy), the origin can be rewritten to an internal base; path, query and token
 * are kept. The rewrite is off unless configured.
 */

import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";

type LogFn = (stream: "stdout" | "stderr", chunk: string) => Promise<void>;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Instance-level internal base for run-scoped MCP gateway URLs. Unset = no rewrite. */
export const RUNTIME_MCP_URL_BASE_ENV = "MYRMIDON_HERMES_RUNTIME_MCP_URL_BASE";

/**
 * Internal base the run-scoped gateway URL origin is rewritten to, or null when
 * the server-supplied URL must be handed through untouched (the default).
 *
 * Precedence: `adapterConfig.runtimeMcpUrlRewrite: false` turns the rewrite off
 * for the agent; `adapterConfig.runtimeMcpUrlBase` overrides the base for the
 * agent; otherwise the instance setting `MYRMIDON_HERMES_RUNTIME_MCP_URL_BASE`.
 */
export function resolveRuntimeMcpUrlBase(input: {
  configUrlBase?: unknown;
  configRewrite?: unknown;
  instanceEnv?: Record<string, string | undefined>;
}): string | null {
  if (input.configRewrite === false) return null;
  const agentBase = typeof input.configUrlBase === "string" ? input.configUrlBase.trim() : "";
  if (agentBase) return agentBase.replace(/\/+$/, "");
  const instanceBase = (input.instanceEnv?.[RUNTIME_MCP_URL_BASE_ENV] ?? "").trim();
  if (instanceBase) return instanceBase.replace(/\/+$/, "");
  return null;
}

/** Replace a gateway URL's origin with `internalBase`, keeping path and query. */
export function rewriteRuntimeMcpServerUrl(url: string, internalBase: string): string {
  try {
    const parsed = new URL(url);
    const base = new URL(internalBase);
    if (parsed.origin === base.origin) return url;
    return `${base.origin}${parsed.pathname}${parsed.search}`;
  } catch {
    // Unparseable URL or base: leave the URL exactly as the server supplied it.
    return url;
  }
}

// ---------------------------------------------------------------------------
// config.yaml merge (line-oriented; the adapter ships no YAML library)
// ---------------------------------------------------------------------------

const MANAGED_MCP_BLOCK_START = "  # BEGIN PAPERCLIP MANAGED MCP";
const MANAGED_MCP_BLOCK_END = "  # END PAPERCLIP MANAGED MCP";
/** Top-level `mcp_servers:` key of a Hermes config.yaml (never indented). */
const MCP_KEY_LINE = /^mcp_servers[ \t]*:/;
/** Exactly two spaces of indent = a direct child key of `mcp_servers`. */
const MCP_CHILD_LINE = /^ {2}([^#\s][^:]*):/;
const RUN_HOME_PREFIX = "paperclip-hermes-home-";
/**
 * Directories the Hermes CLI creates lazily inside HERMES_HOME and keeps across
 * runs (filesystem checkpoints). They are created in the real profile and
 * linked, so a run does not drop them just because the profile lacks them yet.
 */
const PROFILE_DIRS_TO_ENSURE = ["checkpoints"];

export interface HermesRuntimeMcpEntry {
  name: string;
  url: string;
  token: string;
  connectionId: string;
}

export interface HermesRunScopedMcpMaterialization {
  hermesHome: string;
  configPath: string;
  serverNames: string[];
  toolsetNames: string[];
  cleanup: () => Promise<void>;
}

function sanitizeServerName(value: string, fallback: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return sanitized || fallback;
}

function pathToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "").slice(0, 48) || "run";
}

/** JSON string escaping is valid YAML double-quoted escaping. */
function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function yamlKey(name: string): string {
  return /^[a-z_][a-z0-9_-]*$/.test(name) ? name : yamlScalar(name);
}

/**
 * Server names declared under the top-level `mcp_servers` key. The block carries
 * server entries at two spaces of indent (their settings sit deeper), so its
 * direct child keys are the server names.
 */
export function readConfiguredMcpServerNames(configYaml: string): string[] {
  const names: string[] = [];
  let inBlock = false;
  for (const line of configYaml.split("\n")) {
    if (MCP_KEY_LINE.test(line)) {
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    // Any new top-level key (or document marker) ends the mcp_servers block.
    if (/^[^\s#]/.test(line)) break;
    const match = MCP_CHILD_LINE.exec(line);
    if (!match?.[1]) continue;
    const name = match[1].trim().replace(/^["']|["']$/g, "");
    if (name) names.push(name);
  }
  return names;
}

/**
 * Collision-free names for the run-scoped servers: a name the profile already
 * declares gets the `paperclip-` prefix instead of shadowing that entry.
 */
export function planRuntimeMcpEntries(
  servers: AdapterRuntimeMcpServer[],
  reservedNames: readonly string[] = [],
): HermesRuntimeMcpEntry[] {
  const reserved = new Set(reservedNames);
  const used = new Set<string>();
  return servers.map((server, index) => {
    const base = sanitizeServerName(server.name, `paperclip-gateway-${index + 1}`);
    let name = reserved.has(base) || used.has(base) ? `paperclip-${base}` : base;
    let suffix = 2;
    while (used.has(name) || reserved.has(name)) {
      name = `paperclip-${base}-${suffix}`;
      suffix += 1;
    }
    used.add(name);
    return { name, url: server.url, token: server.token, connectionId: server.connectionId };
  });
}

/** Managed block: children of `mcp_servers` at two spaces of indent. */
export function renderRuntimeMcpYamlBlock(entries: HermesRuntimeMcpEntry[]): string[] {
  const lines = [MANAGED_MCP_BLOCK_START];
  for (const entry of entries) {
    lines.push(
      `  ${yamlKey(entry.name)}:`,
      `    url: ${yamlScalar(entry.url)}`,
      "    headers:",
      `      Authorization: ${yamlScalar(`Bearer ${entry.token}`)}`,
      "    connect_timeout: 30.0",
      "    enabled: true",
    );
  }
  lines.push(MANAGED_MCP_BLOCK_END);
  return lines;
}

function stripManagedBlock(configYaml: string): string {
  const lines = configYaml.split("\n");
  const start = lines.findIndex((line) => line.trim() === MANAGED_MCP_BLOCK_START.trim());
  if (start === -1) return configYaml;
  const end = lines.findIndex((line, index) => index >= start && line.trim() === MANAGED_MCP_BLOCK_END.trim());
  lines.splice(start, (end === -1 ? lines.length - 1 : end) - start + 1);
  return lines.join("\n");
}

/**
 * Merge the run-scoped servers into a copy of the profile config.yaml.
 *
 * Returns null for any shape this line-oriented merge does not understand: a
 * broken config.yaml keeps the CLI from starting at all, so the caller runs the
 * agent without the run-scoped servers instead.
 */
export function mergeRuntimeMcpIntoConfigYaml(
  configYaml: string,
  entries: HermesRuntimeMcpEntry[],
): string | null {
  const stripped = stripManagedBlock(configYaml);
  if (entries.length === 0) return `${stripped.replace(/\s+$/, "")}\n`;
  const lines = stripped.split("\n");
  const block = renderRuntimeMcpYamlBlock(entries);
  const keyIndex = lines.findIndex((line) => MCP_KEY_LINE.test(line));
  if (keyIndex === -1) {
    const head = stripped.replace(/\s+$/, "");
    return `${head ? `${head}\n` : ""}${["mcp_servers:", ...block].join("\n")}\n`;
  }
  const keyLine = lines[keyIndex] ?? "";
  const inlineValue = (keyLine.slice(keyLine.indexOf(":") + 1).split("#")[0] ?? "").trim();
  if (inlineValue.length > 0 && inlineValue !== "{}") {
    // Flow-style or scalar `mcp_servers` value: indented children appended after
    // it would not be valid YAML.
    return null;
  }
  lines[keyIndex] = "mcp_servers:";
  lines.splice(keyIndex + 1, 0, ...block);
  return `${lines.join("\n").replace(/\s+$/, "")}\n`;
}

/**
 * Append MCP server names to a `-t/--toolsets` list. Without a list the CLI
 * spawns every configured server, and an MCP-only list would silently restrict
 * the built-in tool surface, so no list stays no list.
 */
export function mergeRuntimeMcpIntoToolsets(
  toolsets: string | undefined,
  names: readonly string[],
): string | undefined {
  const base = (toolsets ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (base.length === 0) return undefined;
  if (names.length === 0) return toolsets;
  const merged = [...base];
  for (const name of names) {
    if (name.length > 0 && !merged.includes(name)) merged.push(name);
  }
  return merged.join(",");
}

/**
 * Rewrite the value of the adapter's own `-t` argument in place. The adapter
 * pushes `-t <toolsets>` before any `extraArgs`, so the first `-t` is its own.
 */
export function applyRuntimeMcpToolsetsToArgs(
  args: string[],
  toolsets: string | undefined,
  names: readonly string[],
): void {
  if (!toolsets || names.length === 0) return;
  const index = args.indexOf("-t");
  if (index === -1 || args[index + 1] !== toolsets) return;
  const merged = mergeRuntimeMcpIntoToolsets(toolsets, names);
  if (merged) args[index + 1] = merged;
}

/**
 * Materialize the run-scoped MCP servers for one run. Returns null (and logs
 * why) whenever that is not possible or not safe; the run then proceeds exactly
 * as without run-scoped servers.
 */
export async function materializeRunScopedHermesMcp(input: {
  servers: AdapterRuntimeMcpServer[];
  hermesHome: string | undefined;
  runId: string;
  includeConfiguredServerNames?: boolean;
  /** Internal base to rewrite gateway URL origins to; null/empty = no rewrite. */
  urlBase?: string | null;
  onLog?: LogFn;
}): Promise<HermesRunScopedMcpMaterialization | null> {
  const servers = Array.isArray(input.servers) ? input.servers : [];
  if (servers.length === 0) return null;
  const log: LogFn = input.onLog ?? (async () => undefined);
  const warn = async (message: string) => {
    await log("stdout", `[hermes] Warning: ${message}\n`);
  };

  const realHome = (input.hermesHome ?? "").trim();
  if (!realHome) {
    await warn(
      "ctx.runtimeMcp has servers but HERMES_HOME is not set for this run; the run-scoped MCP servers were not materialized.",
    );
    return null;
  }

  let configYaml = "";
  const realConfigPath = path.join(realHome, "config.yaml");
  try {
    configYaml = await fs.readFile(realConfigPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      await warn(`cannot read ${realConfigPath} (${code ?? String(err)}); the run-scoped MCP servers were not materialized.`);
      return null;
    }
  }

  let profileEntries: string[];
  try {
    profileEntries = await fs.readdir(realHome);
  } catch (err) {
    await warn(
      `cannot list the Hermes home ${realHome} (${(err as NodeJS.ErrnoException)?.code ?? String(err)}); the run-scoped MCP servers were not materialized.`,
    );
    return null;
  }

  const configuredNames = readConfiguredMcpServerNames(configYaml);
  const internalBase = (input.urlBase ?? "").trim();
  const originRewrites = new Set<string>();
  const entries = planRuntimeMcpEntries(servers, configuredNames).map((entry) => {
    if (!internalBase) return entry;
    const rewritten = rewriteRuntimeMcpServerUrl(entry.url, internalBase);
    if (rewritten !== entry.url) {
      try {
        originRewrites.add(`${new URL(entry.url).origin} -> ${new URL(rewritten).origin}`);
      } catch {
        // Unparseable URLs are handed through untouched.
      }
    }
    return { ...entry, url: rewritten };
  });
  const mergedConfig = mergeRuntimeMcpIntoConfigYaml(configYaml, entries);
  if (mergedConfig === null) {
    await warn(
      `the mcp_servers section of ${realConfigPath} is not a plain block mapping; the run-scoped MCP servers were not materialized.`,
    );
    return null;
  }

  const tempRoot = await fs.mkdtemp(path.join(tmpdir(), `${RUN_HOME_PREFIX}${pathToken(input.runId || "run")}-`));
  const cleanup = async () => {
    // Never remove anything but the directory created here.
    if (!tempRoot.startsWith(path.join(tmpdir(), RUN_HOME_PREFIX))) return;
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  };

  try {
    const resolvedRealHome = path.resolve(realHome);
    // Keep the `<root>/profiles/<name>` shape: Hermes derives the profile root
    // and the profile name from HERMES_HOME.
    const runHome =
      path.basename(path.dirname(resolvedRealHome)) === "profiles"
        ? path.join(tempRoot, "profiles", path.basename(resolvedRealHome))
        : tempRoot;
    await fs.mkdir(runHome, { recursive: true, mode: 0o700 });

    for (const entry of profileEntries) {
      if (entry === "config.yaml") continue;
      try {
        await fs.symlink(path.join(resolvedRealHome, entry), path.join(runHome, entry));
      } catch (err) {
        await warn(
          `could not link ${entry} into the run-scoped Hermes home (${(err as NodeJS.ErrnoException)?.code ?? String(err)}); this run may miss profile state.`,
        );
      }
    }
    for (const name of PROFILE_DIRS_TO_ENSURE) {
      if (profileEntries.includes(name)) continue;
      try {
        const real = path.join(resolvedRealHome, name);
        await fs.mkdir(real, { recursive: true, mode: 0o700 });
        await fs.symlink(real, path.join(runHome, name));
      } catch {
        // Best effort: without the link the CLI recreates the directory inside
        // the run-scoped home, which cleanup then removes.
      }
    }

    const configPath = path.join(runHome, "config.yaml");
    await fs.writeFile(configPath, mergedConfig, { encoding: "utf8", mode: 0o600 });
    await fs.chmod(configPath, 0o600).catch(() => undefined);

    const serverNames = entries.map((entry) => entry.name);
    const toolsetNames =
      input.includeConfiguredServerNames === false ? serverNames : [...new Set([...serverNames, ...configuredNames])];

    await log(
      "stdout",
      `[hermes] Run-scoped MCP: ${serverNames.join(", ")} materialized into ${runHome} (config 0600, removed after this run)${
        originRewrites.size > 0 ? `; gateway origin rewritten ${[...originRewrites].join(", ")}` : ""
      }.\n`,
    );

    return { hermesHome: runHome, configPath, serverNames, toolsetNames, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Spawn envelope check
// ---------------------------------------------------------------------------

/**
 * Linux caps a single argv/envp string at MAX_ARG_STRLEN (131072 bytes);
 * exceeding it fails execve() with E2BIG before the child can log anything.
 * One byte of margin is kept.
 */
export const MAX_SPAWN_ARG_BYTES = 131071;
/** Cap for argv + envp combined. */
export const MAX_SPAWN_ENVELOPE_BYTES = 1024 * 1024;

export class HermesSpawnEnvelopeTooLargeError extends Error {
  readonly code = "spawn_envelope_too_large";
  readonly details: Record<string, unknown>;
  constructor(details: { reason: string; actualBytes: number; limitBytes: number } & Record<string, unknown>) {
    super(
      `spawn_envelope_too_large: refusing to start Hermes - ${details.reason} ` +
        `(${details.actualBytes} bytes, limit ${details.limitBytes} bytes)`,
    );
    this.name = "HermesSpawnEnvelopeTooLargeError";
    this.details = details;
  }
}

/** Throw a clear error instead of letting spawn() fail with E2BIG. */
export function assertSpawnEnvelopeFits(args: readonly string[], env: Record<string, string | undefined>): void {
  for (let i = 0; i < args.length; i++) {
    const bytes = Buffer.byteLength(args[i] ?? "", "utf8");
    if (bytes > MAX_SPAWN_ARG_BYTES) {
      throw new HermesSpawnEnvelopeTooLargeError({
        reason: `argv[${i}] exceeds the per-argument limit`,
        actualBytes: bytes,
        limitBytes: MAX_SPAWN_ARG_BYTES,
        argIndex: i,
      });
    }
  }
  for (const [key, value] of Object.entries(env)) {
    const bytes = Buffer.byteLength(`${key}=${value ?? ""}`, "utf8");
    if (bytes > MAX_SPAWN_ARG_BYTES) {
      throw new HermesSpawnEnvelopeTooLargeError({
        reason: `environment variable ${key} exceeds the per-string limit`,
        actualBytes: bytes,
        limitBytes: MAX_SPAWN_ARG_BYTES,
        envKey: key,
      });
    }
  }
  const argvBytes = args.reduce((sum, arg) => sum + Buffer.byteLength(arg ?? "", "utf8") + 1, 0);
  const envBytes = Object.entries(env).reduce(
    (sum, [key, value]) => sum + Buffer.byteLength(`${key}=${value ?? ""}`, "utf8") + 1,
    0,
  );
  const totalBytes = argvBytes + envBytes;
  if (totalBytes > MAX_SPAWN_ENVELOPE_BYTES) {
    throw new HermesSpawnEnvelopeTooLargeError({
      reason: "combined argv and environment exceed the spawn envelope limit",
      actualBytes: totalBytes,
      limitBytes: MAX_SPAWN_ENVELOPE_BYTES,
      argvBytes,
      envBytes,
    });
  }
}
