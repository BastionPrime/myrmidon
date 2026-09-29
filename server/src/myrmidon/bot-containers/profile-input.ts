// server/src/myrmidon/bot-containers/profile-input.ts
//
// myrmidon(W2a): the input builder for the G2 profile compiler. Pure: everything
// the board has to look up (the card, resolved secrets, skill files, the
// instructions bundle, MCP tokens) arrives in `BotProfileSource`, already
// fetched by the ports in profile-compile.ts / profile-ports.ts, and everything
// instance-wide arrives in `BotProfileSettings` (the MYRMIDON_BOT_* variables).
// So the mapping card -> HermesProfileInput is testable without a database.
//
// Card field -> input mapping follows containers-plan-senior-2026-09-28.md
// §2.1; the compiler (profile-compiler.ts) then turns the input into files.
//
// Errors thrown here are configuration errors (a missing instance setting, a
// missing key value). They name the setting or variable, never a value, so a
// message is safe to show in the reconcile activity log.

import { AGENT_DEFAULT_MAX_CONCURRENT_RUNS } from "@paperclipai/shared";
import type {
  HermesProfileAdapterConfig,
  HermesProfileEnvEntry,
  HermesProfileHindsightSettings,
  HermesProfileInput,
  HermesProfileInstanceDefaults,
  HermesProfileMcpServer,
  HermesProfileSkillFile,
} from "./profile-compiler.js";

// ---------------------------------------------------------------------------
// Instance settings
// ---------------------------------------------------------------------------

export const BOT_HINDSIGHT_API_URL_ENV = "MYRMIDON_BOT_HINDSIGHT_API_URL";
export const BOT_HINDSIGHT_BANK_ENV = "MYRMIDON_BOT_HINDSIGHT_BANK";
export const BOT_LLM_BASE_URL_ENV = "MYRMIDON_BOT_LLM_BASE_URL";
export const BOT_LLM_API_KEY_ENV_ENV = "MYRMIDON_BOT_LLM_API_KEY_ENV";
export const BOT_LLM_API_KEY_SECRET_ENV = "MYRMIDON_BOT_LLM_API_KEY_SECRET";
export const BOT_BOARD_URL_ENV = "MYRMIDON_BOT_BOARD_URL";
/** Existing P4 setting (packages/adapters/hermes/src/server/myrmidon-runtime-mcp.ts):
 *  the internal base a run-scoped MCP gateway URL's origin is rewritten to. Repeated
 *  here, not imported, because the server does not load that adapter module. */
export const BOT_RUNTIME_MCP_URL_BASE_ENV = "MYRMIDON_HERMES_RUNTIME_MCP_URL_BASE";

export interface BotProfileSettings {
  /** hindsight service address as seen from a bot container. Required. */
  hindsightApiUrl: string | null;
  /** Default hindsight bank, used when the card names none. */
  hindsightBank: string | null;
  /** OpenAI-compatible LLM gateway base URL; null = each provider's own default endpoint. */
  llmBaseUrl: string | null;
  /** Name of the .env variable that carries the LLM gateway key (never the key). */
  llmApiKeyEnv: string | null;
  /** Company secret that holds the LLM gateway key; defaults to `llmApiKeyEnv`. */
  llmApiKeySecret: string | null;
  /** The board's address as seen from a bot container (no trailing /api). Required. */
  boardUrl: string | null;
  /** Internal base for MCP gateway URLs; null = URLs are used as the board built them. */
  runtimeMcpUrlBase: string | null;
}

function readSetting(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

export function readBotProfileSettings(env: NodeJS.ProcessEnv = process.env): BotProfileSettings {
  const llmApiKeyEnv = readSetting(env, BOT_LLM_API_KEY_ENV_ENV);
  return {
    hindsightApiUrl: readSetting(env, BOT_HINDSIGHT_API_URL_ENV),
    hindsightBank: readSetting(env, BOT_HINDSIGHT_BANK_ENV),
    llmBaseUrl: readSetting(env, BOT_LLM_BASE_URL_ENV),
    llmApiKeyEnv,
    llmApiKeySecret: readSetting(env, BOT_LLM_API_KEY_SECRET_ENV) ?? llmApiKeyEnv,
    boardUrl: readSetting(env, BOT_BOARD_URL_ENV),
    runtimeMcpUrlBase: readSetting(env, BOT_RUNTIME_MCP_URL_BASE_ENV)?.replace(/\/+$/, "") ?? null,
  };
}

export class BotProfileInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BotProfileInputError";
  }
}

function assertHttpUrl(setting: string, value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new BotProfileInputError(`${setting} is not a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BotProfileInputError(`${setting} must be an http(s) URL`);
  }
}

/** Env variable names the compiler or the image owns; the LLM key variable may not be one of them. */
const OWNED_ENV_NAMES = new Set(["HOME", "PATH", "HERMES_HOME", "API_SERVER_KEY", "PAPERCLIP_API_URL", "PAPERCLIP_API_KEY"]);
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The settings without which no profile can be built at all. Checked before any
 * secret is created for the bot, so an unconfigured instance fails fast and
 * leaves nothing behind.
 */
export function assertBotProfileSettings(settings: BotProfileSettings): void {
  if (!settings.hindsightApiUrl) {
    throw new BotProfileInputError(`${BOT_HINDSIGHT_API_URL_ENV} is not set (the shared hindsight service address)`);
  }
  assertHttpUrl(BOT_HINDSIGHT_API_URL_ENV, settings.hindsightApiUrl);
  if (!settings.boardUrl) {
    throw new BotProfileInputError(`${BOT_BOARD_URL_ENV} is not set (the board address as seen from a bot container)`);
  }
  assertHttpUrl(BOT_BOARD_URL_ENV, settings.boardUrl);
  if (settings.llmBaseUrl) assertHttpUrl(BOT_LLM_BASE_URL_ENV, settings.llmBaseUrl);
  if (settings.llmApiKeyEnv) {
    if (!ENV_NAME_PATTERN.test(settings.llmApiKeyEnv) || OWNED_ENV_NAMES.has(settings.llmApiKeyEnv)) {
      throw new BotProfileInputError(
        `${BOT_LLM_API_KEY_ENV_ENV} must be a valid variable name that is not HOME, PATH, HERMES_HOME, API_SERVER_KEY, PAPERCLIP_API_URL or PAPERCLIP_API_KEY`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

/** One MCP server as the board's gateway hands it out: a URL and a bearer token. */
export interface BotMcpSource {
  name: string;
  url: string;
  token: string;
}

export interface BotProfileSource {
  botKey: string;
  /** The card, as stored (env bindings unresolved, `apiKey` a secret_ref). */
  adapterConfig: Record<string, unknown>;
  /** agent.runtimeConfig — read for heartbeat.maxConcurrentRuns. */
  runtimeConfig: Record<string, unknown>;
  /** The card's env with every secret_ref already resolved. */
  env: Record<string, HermesProfileEnvEntry>;
  /** Company skills chosen by the card's desiredSkills: runtime name -> files. */
  skills: Record<string, readonly HermesProfileSkillFile[]>;
  /** The instructions bundle's entry file text ("" when the card has none). */
  instructions: string;
  /** The LLM gateway key held as an instance/company secret; used when the card's
   *  own env carries no value under `settings.llmApiKeyEnv`. */
  llmApiKey: string | null;
  /** Generated once per bot and stored as a company secret. */
  apiServerKey: string;
  /** This bot's board API key (agent_api_keys), stored as a company secret. */
  paperclipApiKey: string;
  mcpServers: readonly BotMcpSource[];
  instanceDefaults?: HermesProfileInstanceDefaults;
}

export interface BuiltBotProfileInput {
  input: HermesProfileInput;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Small readers (a card is user-edited JSON: never trust a field's type)
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function asStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.flatMap((item) => {
    const text = asTrimmedString(item);
    return text ? [text] : [];
  });
  return list.length > 0 ? list : undefined;
}

// ---------------------------------------------------------------------------
// Card sections
// ---------------------------------------------------------------------------

function readAdapterConfig(card: Record<string, unknown>): HermesProfileAdapterConfig {
  const models = asRecord(card.models);
  const toolsets = Array.isArray(card.toolsets) ? asStringList(card.toolsets)?.join(",") : asTrimmedString(card.toolsets);
  return {
    model: asTrimmedString(card.model),
    provider: asTrimmedString(card.provider),
    effort: asTrimmedString(card.effort),
    models: {
      vision: asTrimmedString(models.vision),
      video: asTrimmedString(models.video),
      stt: asTrimmedString(models.stt),
      tts: asTrimmedString(models.tts),
      fallbacks: asStringList(models.fallbacks),
    },
    toolsets,
  };
}

const RECALL_BUDGETS = ["low", "mid", "high"] as const;
const MEMORY_MODES = ["hybrid", "context", "tools"] as const;

/**
 * hindsight settings. The fleet only runs `local_external` (one shared service),
 * so `mode` is fixed here and a card cannot switch a bot to a cloud endpoint.
 * The card's optional `adapterConfig.hindsight` block may name the bank and tune
 * tags/mission/recall; the bank falls back to MYRMIDON_BOT_HINDSIGHT_BANK.
 */
function readHindsight(card: Record<string, unknown>, settings: BotProfileSettings): HermesProfileHindsightSettings {
  const block = asRecord(card.hindsight);
  const bankId = asTrimmedString(block.bankId) ?? settings.hindsightBank;
  if (!bankId) {
    throw new BotProfileInputError(
      `no hindsight bank: the card sets no adapterConfig.hindsight.bankId and ${BOT_HINDSIGHT_BANK_ENV} is not set`,
    );
  }
  const recallBudget = RECALL_BUDGETS.find((candidate) => candidate === block.recallBudget);
  const memoryMode = MEMORY_MODES.find((candidate) => candidate === block.memoryMode);
  return {
    bankId,
    mode: "local_external",
    apiUrl: settings.hindsightApiUrl ?? undefined,
    tags: asStringList(block.tags),
    mission: asTrimmedString(block.mission),
    recallBudget,
    memoryMode,
    autoRetain: typeof block.autoRetain === "boolean" ? block.autoRetain : undefined,
  };
}

const HEARTBEAT_MAX_CONCURRENT_RUNS_MIN = 1;
const HEARTBEAT_MAX_CONCURRENT_RUNS_MAX = 50;

/**
 * agent.runtimeConfig.heartbeat.maxConcurrentRuns, normalized exactly like the
 * board does for its own scheduling (services/heartbeat.ts normalizeMaxConcurrentRuns:
 * default AGENT_DEFAULT_MAX_CONCURRENT_RUNS, floored, clamped to 1..50), so the
 * gateway's own limit never disagrees with the board's.
 */
export function readMaxConcurrentRuns(runtimeConfig: Record<string, unknown>): number {
  const raw = asRecord(runtimeConfig.heartbeat).maxConcurrentRuns;
  const numeric = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
  const parsed = Math.floor(Number.isFinite(numeric) ? numeric : AGENT_DEFAULT_MAX_CONCURRENT_RUNS);
  if (!Number.isFinite(parsed)) return AGENT_DEFAULT_MAX_CONCURRENT_RUNS;
  return Math.max(HEARTBEAT_MAX_CONCURRENT_RUNS_MIN, Math.min(HEARTBEAT_MAX_CONCURRENT_RUNS_MAX, parsed));
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

/** Env prefix of the variables that carry MCP bearer tokens inside a bot's .env. */
export const BOT_MCP_TOKEN_ENV_PREFIX = "MYRMIDON_MCP_TOKEN_";

function sanitizeMcpServerName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** Same rewrite as the P4 adapter's rewriteRuntimeMcpServerUrl: origin replaced, path and query kept. */
export function rewriteMcpServerUrl(url: string, internalBase: string): string {
  try {
    const parsed = new URL(url);
    const base = new URL(internalBase);
    if (parsed.origin === base.origin) return url;
    return `${base.origin}${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

/**
 * The internal base MCP gateway URLs are rewritten to. Same precedence as the P4
 * adapter (myrmidon-runtime-mcp.ts resolveRuntimeMcpUrlBase): the card's
 * `runtimeMcpUrlRewrite: false` turns it off, the card's `runtimeMcpUrlBase`
 * overrides the instance setting, and the instance setting
 * MYRMIDON_HERMES_RUNTIME_MCP_URL_BASE is the default; unset = no rewrite.
 */
function effectiveMcpUrlBase(card: Record<string, unknown>, settings: BotProfileSettings): string | null {
  if (card.runtimeMcpUrlRewrite === false) return null;
  const agentBase = asTrimmedString(card.runtimeMcpUrlBase);
  if (agentBase) return agentBase.replace(/\/+$/, "");
  return settings.runtimeMcpUrlBase;
}

/**
 * MCP servers for the profile. A token never lands in config.yaml as a value:
 * config.yaml carries `Authorization: Bearer ${MYRMIDON_MCP_TOKEN_<NAME>}` and the
 * token itself goes to the (0600) .env, where Hermes expands the reference at load.
 */
function buildMcpServers(
  sources: readonly BotMcpSource[],
  urlBase: string | null,
  warnings: string[],
): { servers: HermesProfileMcpServer[]; env: Record<string, HermesProfileEnvEntry> } {
  const servers: HermesProfileMcpServer[] = [];
  const env: Record<string, HermesProfileEnvEntry> = {};
  const seenNames = new Set<string>();
  for (const source of sources) {
    const name = sanitizeMcpServerName(source.name);
    if (!name) {
      warnings.push("mcp: a server with an empty name was skipped");
      continue;
    }
    if (seenNames.has(name)) {
      warnings.push(`mcp.${name}: duplicate server name, the first one is kept`);
      continue;
    }
    if (!source.token.trim()) {
      warnings.push(`mcp.${name}: no token, the server was skipped`);
      continue;
    }
    const variable = `${BOT_MCP_TOKEN_ENV_PREFIX}${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
    if (variable in env) {
      warnings.push(`mcp.${name}: its token variable ${variable} collides with another server's, skipped`);
      continue;
    }
    seenNames.add(name);
    env[variable] = { value: source.token, secret: true };
    servers.push({
      name,
      url: urlBase ? rewriteMcpServerUrl(source.url, urlBase) : source.url,
      headers: { Authorization: `Bearer \${${variable}}` },
    });
  }
  return { servers, env };
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * Card + resolved data + instance settings -> the input of `compileHermesProfile`.
 * Deterministic: the same source and settings give the same input, which is what
 * keeps the compiled hashes stable between reconcile ticks (the reconciler calls
 * compile on every tick, and a hash that flips restarts the bot).
 */
export function buildHermesProfileInput(source: BotProfileSource, settings: BotProfileSettings): BuiltBotProfileInput {
  assertBotProfileSettings(settings);
  const warnings: string[] = [];
  const card = source.adapterConfig;

  const env: Record<string, HermesProfileEnvEntry> = { ...source.env };
  if (settings.llmApiKeyEnv) {
    const cardValue = env[settings.llmApiKeyEnv]?.value;
    if (!cardValue || !cardValue.trim()) {
      if (!source.llmApiKey || !source.llmApiKey.trim()) {
        throw new BotProfileInputError(
          `no value for the LLM gateway key: the card's env has no ${settings.llmApiKeyEnv} and the company secret "${settings.llmApiKeySecret ?? settings.llmApiKeyEnv}" is missing or empty`,
        );
      }
      env[settings.llmApiKeyEnv] = { value: source.llmApiKey, secret: true };
    }
  }

  const mcp = buildMcpServers(source.mcpServers, effectiveMcpUrlBase(card, settings), warnings);
  Object.assign(env, mcp.env);

  const input: HermesProfileInput = {
    botKey: source.botKey,
    adapterConfig: readAdapterConfig(card),
    env,
    skills: source.skills,
    instructions: source.instructions,
    hindsight: readHindsight(card, settings),
    llm: {
      baseUrl: settings.llmBaseUrl ?? undefined,
      apiKeyEnv: settings.llmApiKeyEnv ?? undefined,
    },
    mcpServers: mcp.servers,
    maxConcurrentRuns: readMaxConcurrentRuns(source.runtimeConfig),
    instanceDefaults: source.instanceDefaults ?? {},
    apiServerKey: source.apiServerKey,
    // settings.boardUrl is non-null here: assertBotProfileSettings threw otherwise.
    paperclipApiUrl: settings.boardUrl as string,
    paperclipApiKey: source.paperclipApiKey,
  };
  return { input, warnings };
}
