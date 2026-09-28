// myrmidon(G2): compile a bot container's Hermes profile from its agent
// card and instance settings. Pure function, no filesystem or network
// access — the reconciler (G3) is the one that writes these files into a
// bot's volume and restarts its gateway.
//
// Card field -> profile mapping follows containers-plan-senior-2026-09-28.md
// §2.1. The model/provider/effort/auxiliary-model mapping repeats the one
// already implemented for single-run overlays in
// packages/adapters/hermes/src/server/myrmidon-profile-config.ts (M1): same
// Hermes keys, same validation (reasoning effort levels, fallback chain
// needs an explicit non-"auto" provider). That module edits an existing
// profile's config.yaml in place for one run; this one builds a fresh
// config.yaml for the whole container from scratch, so the mapping is
// repeated here rather than imported — see docs/myrmidon/DIVERGENCE.md (G2).
//
// Known gaps, decided here rather than left unspecified (see the PR's
// "Решения без владельца" section):
//   - stt/tts models: the agent card has no stt/tts *provider* field (only
//     a model name — see ui/src/components/myrmidon/AgentCardModelsFields.tsx),
//     and Hermes needs `stt.<provider>.model` / `tts.<provider>.model`, i.e.
//     the provider segment of the key. Without a provider this compiler
//     cannot place the model name anywhere; it warns and drops it, exactly
//     like M1 does when the profile it edits has no provider set either.
//   - hindsight connection (mode/api_url/api_key): out of scope for this
//     input — HermesProfileInput only carries the per-bot settings
//     (bankId/tags/recallBudget/mission). Connection details are instance-
//     wide, not per-card, and are expected to be merged in by the caller
//     that builds HermesProfileInput (G3), not by this function.
import { createHash } from "node:crypto";

import type { CompiledProfile, CompiledProfileFile } from "./types.js";
import { writeYamlDocument, type YamlMapping } from "./deterministic-yaml.js";

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** The subset of adapterConfig (agent card, hermes_local/hermes_gateway shape) this compiler reads. */
export interface HermesProfileAdapterConfig {
  /** adapterConfig.model — "provider/model" or a bare model name. */
  model?: string;
  /** adapterConfig.provider — a Hermes provider id, or "auto". */
  provider?: string;
  /** adapterConfig.effort — the vendor "Thinking effort" field (reasoning level). */
  effort?: string;
  /** adapterConfig.models.{vision,video,stt,tts,fallbacks} — the M1 "Additional models" block. */
  models?: {
    vision?: string;
    video?: string;
    stt?: string;
    tts?: string;
    fallbacks?: string[];
  };
  /** adapterConfig.toolsets — comma-separated Hermes toolset names. */
  toolsets?: string;
}

export interface HermesProfileEnvEntry {
  /** Already resolved: plain value or a resolved secret_ref/user_secret_ref value. */
  value: string;
  secret: boolean;
}

export interface HermesProfileSkillFile {
  /** Path relative to the skill's own directory, e.g. "SKILL.md", "scripts/run.py". */
  path: string;
  content: string;
}

export interface HermesProfileHindsightSettings {
  bankId: string;
  /** Default tags applied when a memory is retained (hindsight's `retain_tags`, not `recall_tags`). */
  tags?: string[];
  recallBudget?: "low" | "mid" | "high";
  /** The memory bank's mission/purpose text (hindsight's `bank_mission`). */
  mission?: string;
}

export interface HermesProfileMcpServer {
  name: string;
  url: string;
  /**
   * Extra HTTP headers sent to the MCP server. Prefer `${VAR}`/`${env:VAR}`
   * references that Hermes resolves from `hermes/.env` at load time
   * (`_interpolate_env_vars` in the vendor's `tools/mcp_tool_config.py`)
   * over a raw credential — a header value here lands in `hermes/config.yaml`,
   * which this compiler writes as non-secret (0o644) unless at least one
   * server carries headers, in which case the whole file is marked secret
   * as a conservative default (see `hasMcpServerHeaders` below).
   */
  headers?: Record<string, string>;
}

export interface HermesProfileCompressionDefaults {
  enabled?: boolean;
  /** Fraction of the context window (0-1) that triggers compression. */
  threshold?: number;
  /** Fraction of the context window (0-1) compression aims to leave behind. */
  targetRatio?: number;
}

export interface HermesProfileInstanceDefaults {
  compression?: HermesProfileCompressionDefaults;
  sessionsRetentionDays?: number;
}

export interface HermesProfileInput {
  /** The agent's slug/id — becomes CompiledProfile.botKey, unchanged. */
  botKey: string;
  adapterConfig: HermesProfileAdapterConfig;
  /** Already-resolved env (plain values and resolved secret refs), keyed by variable name. */
  env: Record<string, HermesProfileEnvEntry>;
  /** Skill name -> its files, already read from the board's skill catalog. */
  skills: Record<string, readonly HermesProfileSkillFile[]>;
  /** The AGENTS.md instruction bundle text, already assembled by the caller. */
  instructions: string;
  hindsight: HermesProfileHindsightSettings;
  mcpServers: readonly HermesProfileMcpServer[];
  /** gateway.api_server.max_concurrent_runs — must be a positive integer. */
  maxConcurrentRuns: number;
  instanceDefaults: HermesProfileInstanceDefaults;
  /** Becomes API_SERVER_KEY in .env — the token runs authenticate to this bot's gateway with. */
  apiServerKey: string;
  /** Becomes PAPERCLIP_API_URL in .env — the board's address reachable from inside the bot container. */
  paperclipApiUrl: string;
  /** Becomes PAPERCLIP_API_KEY in .env — this bot's board API key. */
  paperclipApiKey: string;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface CompileHermesProfileResult {
  profile: CompiledProfile;
  /** Non-fatal issues: an unsupported field, a value dropped for lack of a home, a size limit crossed. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HERMES_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const HINDSIGHT_RECALL_BUDGETS = ["low", "mid", "high"];

/**
 * Hermes's CONTEXT_FILE_MAX_CHARS floor (agent/prompt_builder.py), used as a
 * heads-up threshold here, not the effective truncation limit: at runtime
 * Hermes picks `max(CONTEXT_FILE_MAX_CHARS, min(context_length * 4 * 0.06,
 * 500_000))` off the bot's configured model context window (unless
 * config.yaml sets an explicit `context_file_max_chars`), so a large-context
 * model's real cutoff can be far above this number. HermesProfileInput
 * carries no model context length to compute that dynamic value, so this
 * compiler can only warn against the floor — see the warning text below.
 */
const AGENTS_MD_WARN_CHARS = 20_000;

/** In-container mount point of the skills-board volume subtree (containers-plan-senior §2.1). */
const SKILLS_BOARD_CONTAINER_DIR = "/data/hermes/skills-board";

/** env variable names the image itself sets; a card can never override them. */
const RESERVED_ENV_NAMES = new Set(["HOME", "PATH", "HERMES_HOME"]);

const MODE_SECRET = 0o600;
const MODE_PLAIN = 0o644;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function requireNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`compileHermesProfile: ${field} must not be empty`);
  return trimmed;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function hashEntries(entries: ReadonlyArray<{ path: string; content: string }>): string {
  const hash = createHash("sha256");
  // JSON-encoding path/content pairs (rather than plain concatenation) rules
  // out the classic "ab"+"c" === "a"+"bc" boundary collision.
  hash.update(JSON.stringify(entries.map((entry) => [entry.path, entry.content])));
  return hash.digest("hex");
}

function file(path: string, content: string, opts: { secret: boolean }): CompiledProfileFile {
  return { path, content, mode: opts.secret ? MODE_SECRET : MODE_PLAIN, secret: opts.secret };
}

// ---------------------------------------------------------------------------
// config.yaml
// ---------------------------------------------------------------------------

function buildFallbackModelSequence(
  fallbacks: readonly string[] | undefined,
  provider: string | undefined,
  warnings: string[],
): YamlMapping[] | undefined {
  if (!fallbacks || fallbacks.length === 0) return undefined;
  if (!provider || provider === "auto") {
    warnings.push(
      "fallback_model: the card sets no explicit provider (or leaves it \"auto\"); Hermes needs a provider per fallback entry, so the fallback chain was dropped",
    );
    return undefined;
  }
  const resolvedProvider = provider;
  return fallbacks.map((model): YamlMapping => ({ provider: resolvedProvider, model }));
}

function buildReasoningEffort(effort: string | undefined, warnings: string[]): string | undefined {
  const trimmed = nonEmpty(effort);
  if (!trimmed) return undefined;
  const lowered = trimmed.toLowerCase();
  if (!HERMES_REASONING_EFFORTS.includes(lowered)) {
    warnings.push(`agent.reasoning_effort: "${trimmed}" is not a Hermes effort level; dropped`);
    return undefined;
  }
  return lowered;
}

function buildToolsets(toolsets: string | undefined): string[] | undefined {
  const raw = nonEmpty(toolsets);
  if (!raw) return undefined;
  const seen = new Set<string>();
  const list: string[] = [];
  for (const item of raw.split(",")) {
    const name = item.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    list.push(name);
  }
  return list.length > 0 ? list : undefined;
}

function buildMcpServers(
  servers: readonly HermesProfileMcpServer[],
  warnings: string[],
): YamlMapping | undefined {
  const byName = new Map<string, HermesProfileMcpServer>();
  for (const server of servers) {
    const name = nonEmpty(server.name);
    if (!name) {
      warnings.push("mcp_servers: an entry with an empty name was dropped");
      continue;
    }
    if (byName.has(name)) {
      warnings.push(`mcp_servers.${name}: duplicate entry, keeping the first one`);
      continue;
    }
    byName.set(name, server);
  }
  if (byName.size === 0) return undefined;
  // Object.create(null), not `{}` + bracket assignment: a server literally
  // named "__proto__" would otherwise set the object's prototype instead of
  // an own property (`{}["__proto__"] = x` never adds a key `Object.keys`
  // can see), silently vanishing from the compiled config with no warning.
  const mapping: Record<string, YamlMapping> = Object.create(null);
  for (const [name, server] of byName) {
    mapping[name] = {
      url: requireNonEmpty(server.url, `mcp_servers.${name}.url`),
      headers: server.headers && Object.keys(server.headers).length > 0 ? { ...server.headers } : undefined,
    };
  }
  return mapping;
}

/**
 * True when at least one MCP server carries headers. A header value may be
 * a `${VAR}` reference (see `HermesProfileMcpServer.headers`) or, if a
 * caller doesn't follow that convention, an already-resolved credential —
 * this compiler has no way to tell which, so it conservatively marks
 * `hermes/config.yaml` as secret whenever headers are present, the same
 * way `hermes/.env` always is.
 */
function hasMcpServerHeaders(servers: readonly HermesProfileMcpServer[]): boolean {
  return servers.some((server) => server.headers && Object.keys(server.headers).length > 0);
}

function buildAuxiliary(vision: string | undefined): YamlMapping | undefined {
  const model = nonEmpty(vision);
  if (!model) return undefined;
  return { vision: { model } };
}

/** stt/tts: the card carries only a model name, never a provider — see module docstring. */
function warnUnplacedVoiceModels(
  models: HermesProfileAdapterConfig["models"],
  warnings: string[],
): void {
  for (const field of ["stt", "tts"] as const) {
    const model = nonEmpty(models?.[field]);
    if (!model) continue;
    warnings.push(
      `${field}.model: the card sets "${model}" but carries no ${field} provider, so Hermes has no key to place it under (needs "${field}.<provider>.model"); dropped`,
    );
  }
  const video = nonEmpty(models?.video);
  if (video) {
    warnings.push(`models.video: "${video}" was set, but Hermes has no separate video model setting; not applied`);
  }
}

function buildCompression(defaults: HermesProfileCompressionDefaults | undefined): YamlMapping | undefined {
  if (!defaults) return undefined;
  const mapping: YamlMapping = {
    enabled: defaults.enabled,
    threshold: defaults.threshold,
    target_ratio: defaults.targetRatio,
  };
  return mapping;
}

function buildConfigYaml(input: HermesProfileInput, warnings: string[]): string {
  const { adapterConfig } = input;
  warnUnplacedVoiceModels(adapterConfig.models, warnings);

  const root: YamlMapping = {
    approvals: { mode: "off" },
    agent: { reasoning_effort: buildReasoningEffort(adapterConfig.effort, warnings) },
    auxiliary: buildAuxiliary(adapterConfig.models?.vision),
    compression: buildCompression(input.instanceDefaults.compression),
    fallback_model: buildFallbackModelSequence(adapterConfig.models?.fallbacks, adapterConfig.provider, warnings),
    gateway: { api_server: { max_concurrent_runs: input.maxConcurrentRuns } },
    mcp_servers: buildMcpServers(input.mcpServers, warnings),
    memory: { provider: "hindsight" },
    model: {
      default: nonEmpty(adapterConfig.model),
      provider: nonEmpty(adapterConfig.provider),
    },
    platform_toolsets: { api_server: buildToolsets(adapterConfig.toolsets) },
    platforms: { api_server: { enabled: true } },
    skills: { external_dirs: [SKILLS_BOARD_CONTAINER_DIR] },
    sessions: { retention_days: input.instanceDefaults.sessionsRetentionDays },
    terminal: { cwd: "/workspace" },
  };
  return writeYamlDocument(root);
}

// ---------------------------------------------------------------------------
// .env
// ---------------------------------------------------------------------------

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Matches python-dotenv's `${NAME}` / `${NAME:-default}` interpolation
 * syntax (dotenv/variables.py `_posix_variable`). The vendor gateway loads
 * `hermes/.env` with `load_dotenv(...)`, whose `interpolate` parameter
 * defaults to `True` and is never overridden by
 * `hermes_cli/env_loader.py::_load_dotenv_with_fallback` — so this runs
 * regardless of whether the value was double-quoted, and there is no escape
 * for a literal `$` in this dotenv version (see `renderEnvValue` below).
 */
const DOTENV_INTERPOLATION_PATTERN = /\$\{[^}\r\n]*\}/;

/**
 * Always double-quoted: simpler than a "safe enough to leave bare"
 * heuristic, and it sidesteps whatever a given .env parser does with a bare
 * leading `#` or trailing whitespace. Note this only escapes backslash,
 * quote and newline/CR — python-dotenv's double-quote escape set
 * (`\\[\\'"abfnrtv]`) has no entry for `$`, so a literal `${...}` substring
 * survives unescaped and is interpolated on load; see
 * `DOTENV_INTERPOLATION_PATTERN` and its call site in `buildEnvFile`.
 */
function renderEnvValue(value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r");
  return `"${escaped}"`;
}

function buildEnvFile(input: HermesProfileInput, warnings: string[]): string {
  const entries = new Map<string, string>();

  for (const [name, entry] of Object.entries(input.env)) {
    if (RESERVED_ENV_NAMES.has(name)) {
      warnings.push(`.env: "${name}" is set by the bot image and cannot be overridden by the card; dropped`);
      continue;
    }
    if (!ENV_NAME_PATTERN.test(name)) {
      warnings.push(`.env: "${name}" is not a valid environment variable name; dropped`);
      continue;
    }
    entries.set(name, entry.value);
  }

  // These three are generated by the compiler, not read from the card's env
  // map, and always win over a same-named card entry.
  const reserved: Record<string, string> = {
    API_SERVER_KEY: requireNonEmpty(input.apiServerKey, "apiServerKey"),
    PAPERCLIP_API_URL: requireNonEmpty(input.paperclipApiUrl, "paperclipApiUrl"),
    PAPERCLIP_API_KEY: requireNonEmpty(input.paperclipApiKey, "paperclipApiKey"),
  };
  for (const [name, value] of Object.entries(reserved)) {
    if (entries.has(name)) {
      warnings.push(`.env: "${name}" is reserved for the compiler's own value; the card's value was dropped`);
    }
    entries.set(name, value);
  }

  // No quoting style escapes this: warn rather than fail silently, the same
  // way RESERVED_ENV_NAMES / ENV_NAME_PATTERN violations are surfaced above.
  for (const [name, value] of entries) {
    if (DOTENV_INTERPOLATION_PATTERN.test(value)) {
      warnings.push(
        `.env: "${name}" contains a literal \${...} sequence; Hermes' dotenv loader will interpolate it as a variable reference and silently corrupt the value`,
      );
    }
  }

  const lines = [...entries.keys()].sort().map((name) => `${name}=${renderEnvValue(entries.get(name)!)}`);
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

// ---------------------------------------------------------------------------
// hindsight/config.json
// ---------------------------------------------------------------------------

function buildHindsightConfigJson(hindsight: HermesProfileHindsightSettings, warnings: string[]): string {
  const bankId = requireNonEmpty(hindsight.bankId, "hindsight.bankId");
  let recallBudget = nonEmpty(hindsight.recallBudget);
  if (recallBudget && !HINDSIGHT_RECALL_BUDGETS.includes(recallBudget)) {
    warnings.push(`hindsight.recall_budget: "${recallBudget}" is not one of low/mid/high; dropped`);
    recallBudget = undefined;
  }
  const tags = (hindsight.tags ?? []).map((tag) => tag.trim()).filter((tag) => tag.length > 0);
  const mission = nonEmpty(hindsight.mission);

  // Key order fixed and sorted for the same determinism reason as the YAML.
  // Key names match what the vendor's hindsight plugin actually reads from
  // this file (/opt/hermes-agent/src/plugins/memory/hindsight/__init__.py:
  // cfg.get("bank_mission") and _cfg_or_env("retain_tags", ...)) — not the
  // HermesProfileHindsightSettings field names, which are generic on
  // purpose (see DIVERGENCE.md-style note above: this module doesn't own
  // the hindsight connection, only the per-bot bank/mission/tags values).
  const ordered: Record<string, unknown> = {};
  ordered.bank_id = bankId;
  if (mission) ordered.bank_mission = mission;
  if (recallBudget) ordered.recall_budget = recallBudget;
  if (tags.length > 0) ordered.retain_tags = tags;
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Skill files
// ---------------------------------------------------------------------------

function isSafeRelativeSegment(segment: string): boolean {
  return segment.length > 0 && segment !== "." && segment !== "..";
}

function isSafeSkillPath(path: string): boolean {
  if (path.startsWith("/")) return false;
  return path.split("/").every(isSafeRelativeSegment);
}

function buildSkillFiles(
  skills: Record<string, readonly HermesProfileSkillFile[]>,
  warnings: string[],
): CompiledProfileFile[] {
  const out: CompiledProfileFile[] = [];
  const skillNames = Object.keys(skills).sort();
  for (const name of skillNames) {
    if (!isSafeSkillPath(name)) {
      warnings.push(`skills.${name}: unsafe skill name, dropped`);
      continue;
    }
    const files = [...(skills[name] ?? [])].sort((a, b) => a.path.localeCompare(b.path));
    for (const skillFile of files) {
      if (!isSafeSkillPath(skillFile.path)) {
        warnings.push(`skills.${name}: file path "${skillFile.path}" escapes the skill directory, dropped`);
        continue;
      }
      out.push(file(`hermes/skills-board/${name}/${skillFile.path}`, skillFile.content, { secret: false }));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Compile
// ---------------------------------------------------------------------------

/**
 * Compile a bot's Hermes container profile from its agent card and instance
 * settings. Deterministic: the same input always produces byte-identical
 * files and hashes, so the reconciler (G3) can diff `restartHash`/`filesHash`
 * against a container's applied labels to decide whether anything changed.
 */
export function compileHermesProfileDetailed(input: HermesProfileInput): CompileHermesProfileResult {
  const warnings: string[] = [];
  const botKey = requireNonEmpty(input.botKey, "botKey");
  if (!Number.isInteger(input.maxConcurrentRuns) || input.maxConcurrentRuns <= 0) {
    throw new Error("compileHermesProfile: maxConcurrentRuns must be a positive integer");
  }

  const configYaml = buildConfigYaml(input, warnings);
  const envFile = buildEnvFile(input, warnings);
  const hindsightConfigJson = buildHindsightConfigJson(input.hindsight, warnings);

  const restartFiles = [
    file("hermes/config.yaml", configYaml, { secret: hasMcpServerHeaders(input.mcpServers) }),
    file("hermes/.env", envFile, { secret: true }),
    file("hermes/hindsight/config.json", hindsightConfigJson, { secret: false }),
  ];

  const skillFiles = buildSkillFiles(input.skills, warnings);
  if (input.instructions.length > AGENTS_MD_WARN_CHARS) {
    warnings.push(
      `workspace/AGENTS.md: ${input.instructions.length} characters, over Hermes's ${AGENTS_MD_WARN_CHARS}-character context-file floor; Hermes may truncate it at runtime, depending on the bot's model context window (the floor, not necessarily the effective limit for this bot)`,
    );
  }
  const agentsMdFile = file("workspace/AGENTS.md", input.instructions, { secret: false });
  const filesTrackedFiles = [...skillFiles, agentsMdFile];

  const restartHash = hashEntries(restartFiles);
  const filesHash = hashEntries(filesTrackedFiles);

  const profile: CompiledProfile = {
    botKey,
    files: [...restartFiles, ...filesTrackedFiles],
    restartHash,
    filesHash,
  };
  return { profile, warnings };
}

/** Convenience wrapper matching the reconciler's expected signature exactly. Warnings: see {@link compileHermesProfileDetailed}. */
export function compileHermesProfile(input: HermesProfileInput): CompiledProfile {
  return compileHermesProfileDetailed(input).profile;
}
