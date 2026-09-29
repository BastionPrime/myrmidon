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
//   - hindsight api_key: out of scope for this input, same as the LLM
//     gateway's api key below — it goes into hermes/.env under
//     HINDSIGHT_API_KEY (input.env, handled by buildEnvFile), never into
//     hermes/hindsight/config.json. The vendor plugin still reads it from
//     there via get_secret("HINDSIGHT_API_KEY") even once config.json
//     exists and is otherwise authoritative, because it only ever reads
//     config.json's own "api_key"/"apiKey" keys, which this compiler never
//     writes (plugins/memory/hindsight/__init__.py `_cloud_api_key`).
//     mode/apiUrl/memoryMode/autoRetain, by contrast, ARE this function's
//     job (HermesProfileHindsightSettings) — the previous version of this
//     comment deferred them to the caller (G3), which cannot do it: G3
//     has no such fields to merge in, and hermes/hindsight/config.json is
//     this module's own restart-class output.
//   - LLM gateway endpoint (model.base_url / model.api_key): instance-wide,
//     not per-card — HermesProfileInput.llm (HermesProfileLlmSettings)
//     carries it once per instance, same shape as the hindsight connection
//     details above. The api key itself is never written as a value, only
//     as a "${VAR}" reference Hermes expands from hermes/.env at load
//     (hermes_cli/config.py `_expand_env_vars`); the actual value belongs
//     in input.env under that name.
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

/** A text file placed under /workspace (the sibling files of an instructions bundle). */
export interface HermesProfileWorkspaceFile {
  /**
   * Path relative to /workspace, e.g. "HEARTBEAT.md", "docs/style.md". Never a
   * name the vendor gateway loads as project context (AGENTS.md, CLAUDE.md,
   * .cursorrules, .hermes.md, ...): such a file is dropped, see {@link CONTEXT_FILE_NAMES}.
   */
  path: string;
  content: string;
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

/**
 * hindsight's `mode` (plugins/memory/hindsight/settings.py choices). The
 * fleet only ever runs `local_external` (a shared hindsight service inside
 * the network); `cloud` and `local_embedded` exist here only so a caller can
 * opt into them explicitly — see {@link HermesProfileHindsightSettings.mode}.
 */
export type HermesProfileHindsightMode = "local_external" | "cloud" | "local_embedded";

export interface HermesProfileHindsightSettings {
  bankId: string;
  /** Default tags applied when a memory is retained (hindsight's `retain_tags`, not `recall_tags`). */
  tags?: string[];
  recallBudget?: "low" | "mid" | "high";
  /** The memory bank's mission/purpose text (hindsight's `bank_mission`). */
  mission?: string;
  /**
   * hindsight's `mode`. Defaults to `"local_external"` when unset — this
   * compiler always writes an explicit `mode`, never leaves it out, because
   * once `hermes/hindsight/config.json` exists on disk the vendor plugin
   * stops consulting `HINDSIGHT_MODE`/env entirely and falls back to its own
   * default of `"cloud"` with a public vectorize.io endpoint
   * (`_load_config`/`is_available`/`initialize`: `cfg.get("mode", "cloud")`
   * in plugins/memory/hindsight/__init__.py) — an *implicit* cloud default
   * for a fleet bot is exactly the failure mode this field closes off. Set
   * it to `"cloud"` explicitly if a bot genuinely needs that.
   */
  mode?: HermesProfileHindsightMode;
  /**
   * hindsight's `api_url`. Required (this function throws otherwise) when
   * `mode` is, or defaults to, `"local_external"`: that mode's own runtime
   * fallback is `http://localhost:8888` (settings.py `_DEFAULT_LOCAL_URL`),
   * which is never the fleet's shared hindsight service, so this compiler
   * refuses to emit a `local_external` profile that would silently fall
   * back to it.
   */
  apiUrl?: string;
  /** hindsight's `memory_mode` (`"hybrid" | "context" | "tools"`). Defaults to `"tools"` here — the fleet's own convention — not the vendor's own default of `"hybrid"`. */
  memoryMode?: "hybrid" | "context" | "tools";
  /** hindsight's `auto_retain`. Defaults to `false` here — the fleet's own convention — not the vendor's own default of `true`. */
  autoRetain?: boolean;
  /**
   * hindsight's `observation_scopes`: which tag conjunctions the bot observes
   * (e.g. `[["channel:board"],["channel:telegram"]]`). Currently only the live
   * hermes_local profiles carry it; MEMORY-ISOLATION carries it through the
   * card so it survives the move to containers. Serialized as-is (array of
   * arrays); omitted when unset.
   */
  observationScopes?: readonly (readonly string[])[];
}

/**
 * Instance-wide LLM gateway settings (e.g. an internal OpenAI-compatible
 * gateway endpoint) — not carried by the agent card, merged in once per
 * instance by the caller (G3), the same way
 * {@link HermesProfileHindsightSettings.apiUrl} is.
 * Applied to `model.base_url`/`model.api_key` and to every `fallback_model`
 * entry's `base_url`/`key_env`: Hermes resolves each of those independently
 * (`hermes_cli/runtime_provider_backends.py` for `model`,
 * `hermes_cli/fallback_config.py` for `fallback_model` entries — neither
 * inherits `base_url`/the key from the other). Auxiliary models (vision,
 * compression) are not configured with their own endpoint at all and simply
 * reuse whatever `model.base_url`/`model.api_key` resolve to, so fixing
 * `model` covers them too.
 */
export interface HermesProfileLlmSettings {
  /**
   * OpenAI-compatible base URL for a "custom"-family provider (or any
   * provider that needs an explicit endpoint instead of its built-in
   * default), e.g. `https://example.com/llm/v1`. Written unconditionally
   * whenever set, regardless of `adapterConfig.provider`'s value.
   */
  baseUrl?: string;
  /**
   * Name of the `hermes/.env` variable holding the API key Hermes should
   * send — never the key's value itself. `model.api_key` gets the literal
   * string `"${<apiKeyEnv>}"`, which Hermes expands from `hermes/.env` at
   * config load (`hermes_cli/config.py` `_expand_env_vars`); each
   * `fallback_model` entry gets a plain `key_env: "<apiKeyEnv>"` field
   * instead (`hermes_cli/fallback_config.py` `resolve_entry_api_key` reads
   * `key_env` as a bare name and resolves it itself — it does not go
   * through `_expand_env_vars`, so it must not be `${...}`-wrapped). The
   * caller (G3) must ensure `input.env` actually carries this name; this
   * compiler only ever emits the reference.
   */
  apiKeyEnv?: string;
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
  /**
   * The text of workspace/AGENTS.md, already assembled by the caller; blank
   * means no AGENTS.md is written at all.
   *
   * The vendor gateway injection-scans the project context files it loads and
   * replaces a file that matches a pattern with a "[BLOCKED ...]" stub, so an
   * agent's whole instruction set would vanish because of one `curl ...
   * $KEY` example in its text. The bot wiring therefore leaves this blank and
   * sends the instructions in the run request instead (that field is not
   * scanned). Keep it for a caller whose text is known to pass the scanner.
   */
  instructions: string;
  /**
   * The instructions bundle's other files, placed under /workspace with their
   * relative paths: the instructions refer to their siblings (`./HEARTBEAT.md`,
   * `./SOUL.md`), and the agent resolves those against its working directory.
   * Files-class: read on demand, no restart needed. Optional; omitted means
   * the bundle is the entry file alone.
   */
  workspaceFiles?: readonly HermesProfileWorkspaceFile[];
  hindsight: HermesProfileHindsightSettings;
  /** Instance-wide LLM gateway settings — see {@link HermesProfileLlmSettings}. */
  llm: HermesProfileLlmSettings;
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
const HINDSIGHT_MODES: readonly HermesProfileHindsightMode[] = ["local_external", "cloud", "local_embedded"];
/** The fleet's only supported mode — see {@link HermesProfileHindsightSettings.mode}. */
const HINDSIGHT_DEFAULT_MODE: HermesProfileHindsightMode = "local_external";

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
  // Each fallback_model entry resolves its own base_url/key independently of
  // `model` (hermes_cli/fallback_config.py) — it does not inherit either,
  // so the caller's already-resolved instance-level LLM gateway settings
  // are repeated onto every entry (resolved once by the caller so a bad
  // llm.apiKeyEnv only ever warns a single time per compile).
  llmBaseUrl: string | undefined,
  llmApiKeyEnv: string | undefined,
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
  return fallbacks.map((model): YamlMapping => ({
    provider: resolvedProvider,
    model,
    base_url: llmBaseUrl,
    key_env: llmApiKeyEnv,
  }));
}

/** `input.llm.apiKeyEnv`, validated as an env-var name, or undefined (with a warning) if it isn't one. */
function resolveLlmApiKeyEnv(llm: HermesProfileLlmSettings, warnings: string[]): string | undefined {
  const apiKeyEnv = nonEmpty(llm.apiKeyEnv);
  if (!apiKeyEnv) return undefined;
  if (!ENV_NAME_PATTERN.test(apiKeyEnv)) {
    warnings.push(
      `llm.apiKeyEnv: "${apiKeyEnv}" is not a valid environment variable name; the LLM gateway api key was dropped`,
    );
    return undefined;
  }
  return apiKeyEnv;
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

  // Resolved once (not inline below, and not re-resolved inside
  // buildFallbackModelSequence) so the "not a valid env var name" warning is
  // only ever pushed a single time per compile.
  const llmBaseUrl = nonEmpty(input.llm.baseUrl);
  const llmApiKeyEnv = resolveLlmApiKeyEnv(input.llm, warnings);

  const root: YamlMapping = {
    approvals: { mode: "off" },
    agent: { reasoning_effort: buildReasoningEffort(adapterConfig.effort, warnings) },
    auxiliary: buildAuxiliary(adapterConfig.models?.vision),
    compression: buildCompression(input.instanceDefaults.compression),
    fallback_model: buildFallbackModelSequence(
      adapterConfig.models?.fallbacks,
      adapterConfig.provider,
      llmBaseUrl,
      llmApiKeyEnv,
      warnings,
    ),
    gateway: { api_server: { max_concurrent_runs: input.maxConcurrentRuns } },
    mcp_servers: buildMcpServers(input.mcpServers, warnings),
    memory: { provider: "hindsight" },
    model: {
      default: nonEmpty(adapterConfig.model),
      provider: nonEmpty(adapterConfig.provider),
      // Instance-level LLM gateway settings — see HermesProfileLlmSettings.
      // api_key is a "${VAR}" reference, never the key's value.
      base_url: llmBaseUrl,
      api_key: llmApiKeyEnv ? `\${${llmApiKeyEnv}}` : undefined,
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

  // mode: always written, defaulting to the fleet's only supported mode —
  // see HermesProfileHindsightSettings.mode for why an implicit default is
  // not an option here the way it is for recallBudget/tags/mission above.
  let mode = nonEmpty(hindsight.mode) as HermesProfileHindsightMode | undefined;
  if (mode && !HINDSIGHT_MODES.includes(mode)) {
    warnings.push(
      `hindsight.mode: "${mode}" is not one of ${HINDSIGHT_MODES.join("/")}; using the default "${HINDSIGHT_DEFAULT_MODE}"`,
    );
    mode = undefined;
  }
  mode ??= HINDSIGHT_DEFAULT_MODE;

  // api_url: required once mode resolves to "local_external" — that mode's
  // own runtime fallback is a localhost address, never the fleet's shared
  // service (see HermesProfileHindsightSettings.apiUrl). Thrown, not
  // warned, the same severity as an empty bankId/mcp url elsewhere in this
  // module: a local_external profile with no api_url is not a degraded-but-
  // usable profile, it is a wrong one.
  const apiUrl = nonEmpty(hindsight.apiUrl);
  if (mode === "local_external" && !apiUrl) {
    throw new Error(
      'compileHermesProfile: hindsight.apiUrl must not be empty when hindsight.mode is "local_external" (the default)',
    );
  }

  const memoryMode = hindsight.memoryMode ?? "tools";
  const autoRetain = hindsight.autoRetain ?? false;
  // myrmidon(MEMORY-ISOLATION): observation scopes from the card. Empty scopes
  // and duplicates fold away, so a card cannot smuggle in a scope that is
  // blank or a copy of another; the compiled file stays deterministic.
  const observationScopes: string[][] = [];
  {
    const seen = new Set<string>();
    for (const scope of hindsight.observationScopes ?? []) {
      const tags = scope.map((tag) => tag.trim()).filter((tag) => tag.length > 0);
      if (tags.length === 0) continue;
      const key = JSON.stringify(tags);
      if (seen.has(key)) continue;
      seen.add(key);
      observationScopes.push(tags);
    }
  }

  // Key order fixed and sorted for the same determinism reason as the YAML.
  // Key names match what the vendor's hindsight plugin actually reads from
  // this file (/opt/hermes-agent/src/plugins/memory/hindsight/__init__.py:
  // cfg.get("bank_mission"), cfg.get("mode", "cloud"), cfg.get("api_url"),
  // cfg.get("memory_mode", "hybrid"), cfg.get("auto_retain", True) and
  // _cfg_or_env("retain_tags", ...)) — not the HermesProfileHindsightSettings
  // field names, which are generic on purpose. api_key is deliberately never
  // written here — see the module docstring's "hindsight api_key" note.
  const ordered: Record<string, unknown> = {};
  if (apiUrl) ordered.api_url = apiUrl;
  ordered.auto_retain = autoRetain;
  ordered.bank_id = bankId;
  if (mission) ordered.bank_mission = mission;
  ordered.memory_mode = memoryMode;
  ordered.mode = mode;
  // myrmidon(MEMORY-ISOLATION): observation_scopes from the card, written
  // between memory_mode and mode in the sorted key order. Same shape the live
  // hermes_local profiles carry: an array of tag conjunctions.
  if (observationScopes.length > 0) ordered.observation_scopes = observationScopes;
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
// Workspace files (the instructions bundle's files beside the entry file)
// ---------------------------------------------------------------------------

/**
 * File names the vendor gateway loads as project context (agent/prompt_builder.py,
 * agent/subdirectory_hints.py): the first found wins per kind, is injection-
 * scanned, and is put into the system prompt. A bundle's sibling under one of
 * these names would either shadow the instructions or, when it trips the
 * scanner, be replaced by a stub, and Hermes also reads them from any
 * subdirectory the agent browses into. Compared by base name, case-insensitively.
 */
const CONTEXT_FILE_NAMES = new Set([
  "agents.md",
  "agents.override.md",
  "claude.md",
  ".cursorrules",
  ".hermes.md",
  "hermes.md",
]);
/** `.cursor/rules/*.mdc` is loaded as context too (cwd only). */
const CURSOR_RULES_DIR = ".cursor/rules/";

function isContextFilePath(path: string): boolean {
  const lower = path.toLowerCase();
  const base = lower.slice(lower.lastIndexOf("/") + 1);
  return CONTEXT_FILE_NAMES.has(base) || (lower.startsWith(CURSOR_RULES_DIR) && lower.endsWith(".mdc"));
}

function buildWorkspaceFiles(
  workspaceFiles: readonly HermesProfileWorkspaceFile[] | undefined,
  warnings: string[],
): CompiledProfileFile[] {
  const out: CompiledProfileFile[] = [];
  const seen = new Set<string>();
  const sorted = [...(workspaceFiles ?? [])].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const workspaceFile of sorted) {
    if (!isSafeSkillPath(workspaceFile.path) || workspaceFile.path.includes("\\") || workspaceFile.path.includes("\u0000")) {
      warnings.push(`workspaceFiles: path "${workspaceFile.path}" is not a safe relative path, dropped`);
      continue;
    }
    if (isContextFilePath(workspaceFile.path)) {
      warnings.push(
        `workspaceFiles: "${workspaceFile.path}" is a name the gateway loads as project context (AGENTS.md, CLAUDE.md, .cursorrules, .hermes.md and the like), dropped`,
      );
      continue;
    }
    if (seen.has(workspaceFile.path)) {
      warnings.push(`workspaceFiles: duplicate path "${workspaceFile.path}", keeping the first one`);
      continue;
    }
    seen.add(workspaceFile.path);
    out.push(file(`workspace/${workspaceFile.path}`, workspaceFile.content, { secret: false }));
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
  // Restart-class, same as config.yaml/.env/hindsight config above: the
  // vendor gateway's skills index is built once and cached in-process (LRU +
  // disk snapshot) and does not watch the skills directory for changes —
  // adding, removing or editing a skill's files never takes effect for a
  // running gateway without a restart (agent/prompt_builder.py skills-index
  // cache; agent/conversation_loop.py: "The skills index cache ... does not
  // watch the skills dir"; the vendor's own `/reload-skills` command exists
  // precisely to force this by hand otherwise). All of a skill's files go
  // in, not just SKILL.md: its frontmatter alone drives the index entry, but
  // a skill's other files (scripts, references) are also only ever (re)read
  // through that same cached external_dirs listing.
  const skillFiles = buildSkillFiles(input.skills, warnings);

  const restartFiles = [
    file("hermes/config.yaml", configYaml, { secret: hasMcpServerHeaders(input.mcpServers) }),
    file("hermes/.env", envFile, { secret: true }),
    file("hermes/hindsight/config.json", hindsightConfigJson, { secret: false }),
    ...skillFiles,
  ];

  const hasAgentsMd = input.instructions.trim().length > 0;
  if (hasAgentsMd && input.instructions.length > AGENTS_MD_WARN_CHARS) {
    warnings.push(
      `workspace/AGENTS.md: ${input.instructions.length} characters, over Hermes's ${AGENTS_MD_WARN_CHARS}-character context-file floor; Hermes may truncate it at runtime, depending on the bot's model context window (the floor, not necessarily the effective limit for this bot)`,
    );
  }
  // Files-class: AGENTS.md is re-read by the gateway on each run (it isn't
  // cached the way the skills index is), so a running gateway picks up an
  // edit without a restart. Blank instructions write no AGENTS.md at all (an
  // empty file would still be a context file the gateway loads and reports).
  const agentsMdFiles = hasAgentsMd ? [file("workspace/AGENTS.md", input.instructions, { secret: false })] : [];
  // The bundle's sibling files ride the same class: the instructions name them
  // relatively, and the agent reads them on demand, never through a cache.
  const filesTrackedFiles = [...agentsMdFiles, ...buildWorkspaceFiles(input.workspaceFiles, warnings)];

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
