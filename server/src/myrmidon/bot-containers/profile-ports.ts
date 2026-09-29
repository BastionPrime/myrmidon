// server/src/myrmidon/bot-containers/profile-ports.ts
//
// myrmidon(W2a): the database-bound implementation of BotProfilePorts and
// BotCardSyncPorts. Deliberately thin: every rule (what goes where in the
// profile, which secret is reused) lives in profile-input.ts / profile-compile.ts /
// card-sync.ts, which are tested against fake ports. What is left here is the
// glue to the board's own services, which the unit tests do not load.
//
// Two rules apply to everything in this file:
//  - It runs on every reconcile tick (once a minute per bot), so it never writes
//    unless something is missing, and never resolves a secret through a
//    binding/audit context: resolving without a context writes no
//    secret-access event, and a per-minute event per secret per bot would drown
//    the audit log. The secrets read here are the card's own env and two
//    secrets this file created itself.
//  - A secret it creates is get-or-create by a deterministic name, so a second
//    call returns the same value (compile must give the same hashes tick after
//    tick, or the bot restarts every minute).

import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { Db } from "@paperclipai/db";
import {
  readPaperclipSkillSyncPreference,
  resolveLegacyPaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";
import { getConfiguredSecretProvider } from "../../secrets/configured-provider.js";
import {
  agentInstructionsService,
  agentService,
  companySkillService,
  instanceSettingsService,
  secretService,
} from "../../services/index.js";
import { skillVersionSelectionMap } from "../../services/runtime-skill-selections.js";
import { createBotCardSync, type BotCardSyncPorts, type BotCardSyncResult } from "./card-sync.js";
import {
  createBotProfileCompile,
  type BotProfileAgentRecord,
  type BotProfileCompileOptions,
  type BotProfilePorts,
} from "./profile-compile.js";
import type { HermesProfileEnvEntry, HermesProfileSkillFile } from "./profile-compiler.js";
import type { CompiledProfile } from "./types.js";

/** The name the bot's board API key carries in agent_api_keys, so an operator can see what it is for. */
export const BOT_AGENT_API_KEY_NAME = "myrmidon-bot-container";

export function apiServerKeySecretName(agentId: string): string {
  return `myrmidon-bot-${agentId}-api-server-key`;
}

export function agentApiKeySecretName(agentId: string): string {
  return `myrmidon-bot-${agentId}-paperclip-api-key`;
}

const SYSTEM_ACTOR = { userId: null, agentId: null } as const;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function generateToken(): string {
  return randomBytes(32).toString("hex");
}

// ---------------------------------------------------------------------------
// Skills: files on disk -> compiler input
// ---------------------------------------------------------------------------

const SKILL_MAX_FILES = 200;
const SKILL_MAX_FILE_BYTES = 512 * 1024;
const SKILL_SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);

/** Reads a materialized skill directory into compiler input. Symlinks, oversized
 *  and binary files are skipped with a warning, never followed or truncated. */
async function readSkillFiles(root: string, label: string, warnings: string[]): Promise<HermesProfileSkillFile[]> {
  const files: HermesProfileSkillFile[] = [];
  const rootStat = await fs.stat(root);
  if (rootStat.isFile()) {
    return [{ path: "SKILL.md", content: await fs.readFile(root, "utf8") }];
  }

  async function walk(directory: string, relative: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        warnings.push(`skill ${label}: symlink ${relativePath} skipped`);
        continue;
      }
      if (entry.isDirectory()) {
        if (SKILL_SKIPPED_DIRECTORIES.has(entry.name)) continue;
        await walk(path.join(directory, entry.name), relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (files.length >= SKILL_MAX_FILES) {
        warnings.push(`skill ${label}: more than ${SKILL_MAX_FILES} files, ${relativePath} and the rest skipped`);
        return;
      }
      const absolute = path.join(directory, entry.name);
      const stat = await fs.stat(absolute);
      if (stat.size > SKILL_MAX_FILE_BYTES) {
        warnings.push(`skill ${label}: ${relativePath} is larger than ${SKILL_MAX_FILE_BYTES} bytes, skipped`);
        continue;
      }
      const content = await fs.readFile(absolute, "utf8");
      if (content.includes("\u0000")) {
        warnings.push(`skill ${label}: ${relativePath} is binary, skipped`);
        continue;
      }
      files.push({ path: relativePath, content });
    }
  }

  await walk(root, "");
  return files;
}

// ---------------------------------------------------------------------------
// Secrets: get-or-create by name
// ---------------------------------------------------------------------------

type SecretsService = ReturnType<typeof secretService>;

async function getOrCreateSecret(
  secrets: SecretsService,
  companyId: string,
  name: string,
  description: string,
  generate: () => string,
): Promise<{ secretId: string; value: string }> {
  const existingId = (await secrets.getByName(companyId, name))?.id;
  if (existingId) {
    return { secretId: existingId, value: await secrets.resolveSecretValue(companyId, existingId, "latest") };
  }
  let secretId: string;
  try {
    const created = await secrets.create(
      companyId,
      { name, provider: getConfiguredSecretProvider(), value: generate(), description },
      SYSTEM_ACTOR,
    );
    secretId = created.id;
  } catch (err) {
    // A parallel create (another process, or the card sync racing this tick) won: use its secret.
    const raced = (await secrets.getByName(companyId, name))?.id;
    if (!raced) throw err;
    secretId = raced;
  }
  return { secretId, value: await secrets.resolveSecretValue(companyId, secretId, "latest") };
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

function toAgentRecord(row: {
  id: string;
  companyId: string;
  name: string;
  adapterType: string;
  adapterConfig: unknown;
  runtimeConfig: unknown;
}): BotProfileAgentRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    adapterType: row.adapterType,
    adapterConfig: asRecord(row.adapterConfig),
    runtimeConfig: asRecord(row.runtimeConfig),
  };
}

/**
 * The board's data behind `createBotProfileCompile`. `listMcpServers` is NOT
 * provided: the board tool gateway's run-scoped tokens live one hour and cannot
 * sit in a container's long-lived profile, and a durable gateway token is a
 * security decision that has no owner yet (see the PR's "Решения без владельца").
 * Until that is decided, a bot's profile carries no MCP servers, and the builder
 * (profile-input.ts) is ready for the day this port is filled in.
 */
export function createDbBotProfilePorts(db: Db): BotProfilePorts {
  const agents = agentService(db);
  const secrets = secretService(db);
  const skills = companySkillService(db);
  const instructions = agentInstructionsService();
  const instanceSettings = instanceSettingsService(db);

  return {
    async loadAgent(agentId) {
      const row = await agents.getById(agentId);
      return row ? toAgentRecord(row) : null;
    },

    async resolveCardEnv(agent) {
      const warnings: string[] = [];
      const bindings: Record<string, unknown> = {};
      for (const [name, binding] of Object.entries(asRecord(agent.adapterConfig.env))) {
        if (asRecord(binding).type === "user_secret_ref") {
          // A per-user secret has no value without a user; a container has none.
          warnings.push(`env.${name}: a per-user secret cannot be used by a bot container, dropped`);
          continue;
        }
        bindings[name] = binding;
      }
      const resolved = await secrets.resolveEnvBindings(agent.companyId, bindings);
      const env: Record<string, HermesProfileEnvEntry> = {};
      for (const [name, value] of Object.entries(resolved.env)) {
        env[name] = { value, secret: resolved.secretKeys.has(name) };
      }
      return { env, warnings };
    },

    async readCompanySecret(companyId, name) {
      const secret = await secrets.getByName(companyId, name);
      if (!secret) return null;
      return secrets.resolveSecretValue(companyId, secret.id, "latest");
    },

    async ensureApiServerKey(agent) {
      const { secretId, value } = await getOrCreateSecret(
        secrets,
        agent.companyId,
        apiServerKeySecretName(agent.id),
        `Hermes API server key of the bot container for agent ${agent.name}`,
        generateToken,
      );
      return { secretId, value };
    },

    async ensureAgentApiKey(agent) {
      const secretName = agentApiKeySecretName(agent.id);
      const secret = await secrets.getByName(agent.companyId, secretName);
      const keys = await agents.listKeys(agent.id);
      const hasActiveKey = keys.some((key) => key.name === BOT_AGENT_API_KEY_NAME && !key.revokedAt);
      if (secret && hasActiveKey) {
        return { value: await secrets.resolveSecretValue(agent.companyId, secret.id, "latest") };
      }
      // No secret to read the token from, or its key was revoked: issue a fresh key
      // (its token is shown once) and store that as the secret's new value. A key
      // left behind by a lost secret stays listed under the same name for an
      // operator to revoke; the board cannot tell which token it belonged to.
      const created = await agents.createApiKey(agent.id, BOT_AGENT_API_KEY_NAME);
      if (secret) {
        await secrets.rotate(secret.id, { value: created.token }, SYSTEM_ACTOR);
      } else {
        await secrets.create(
          agent.companyId,
          {
            name: secretName,
            provider: getConfiguredSecretProvider(),
            value: created.token,
            description: `Board API key of the bot container for agent ${agent.name}`,
          },
          SYSTEM_ACTOR,
        );
      }
      return { value: created.token };
    },

    async loadSkills(agent) {
      const warnings: string[] = [];
      const preference = readPaperclipSkillSyncPreference(agent.adapterConfig);
      const experimental = await instanceSettings.getExperimental();
      const entries = await skills.listRuntimeSkillEntries(agent.companyId, {
        versionSelections: skillVersionSelectionMap(preference.desiredSkillEntries, {
          versionPinsEnabled: experimental.enableBetaSkills === true,
        }),
      });
      // The same resolution hermes_local uses, so a bot in a container carries the
      // skills it would have had running locally (including the board's own skill).
      const desiredKeys = resolveLegacyPaperclipDesiredSkillNames(agent.adapterConfig, entries);
      const byKey = new Map(entries.map((entry) => [entry.key, entry] as const));
      const result: Record<string, readonly HermesProfileSkillFile[]> = {};
      for (const key of desiredKeys) {
        const entry = byKey.get(key);
        if (!entry) {
          warnings.push(`skill ${key}: not found in the company catalog, skipped`);
          continue;
        }
        if (entry.sourceStatus === "missing") {
          warnings.push(`skill ${key}: source is missing (${entry.missingDetail ?? "no detail"}), skipped`);
          continue;
        }
        result[entry.runtimeName] = await readSkillFiles(entry.source, key, warnings);
      }
      return { skills: result, warnings };
    },

    async loadInstructions(agent) {
      const bundle = await instructions.getBundle(agent);
      if (bundle.rootPath && bundle.files.some((file) => file.path === bundle.entryFile)) {
        const detail = await instructions.readFile(agent, bundle.entryFile);
        if (detail.content.trim()) return detail.content;
      }
      // hermes_gateway keeps its "stable instructions" as a plain string on the card.
      const inline = agent.adapterConfig.instructions;
      return typeof inline === "string" ? inline : "";
    },
  };
}

/** The card write behind `createBotCardSync`: the agent update path, so the secret_ref
 *  it stores is bound to the agent (a run may then resolve it) and the change is recorded
 *  as a config revision under a system source. */
export function createDbBotCardSyncPorts(db: Db, profilePorts: BotProfilePorts = createDbBotProfilePorts(db)): BotCardSyncPorts {
  const agents = agentService(db);
  return {
    loadAgent: profilePorts.loadAgent,
    ensureApiServerKey: profilePorts.ensureApiServerKey,
    async saveAdapterConfig(agent, adapterConfig) {
      await agents.update(agent.id, { adapterConfig }, { recordRevision: { source: "myrmidon_bot_containers" } });
    },
  };
}

/**
 * The two fields of `BotContainerRuntimeDeps` W2a fills, bound to the database:
 *
 *   startBotContainerReconciliation(listAgents, { driver, maintenance, network, ...botProfileWiring(db) })
 *
 * (the call itself belongs to the pilot PR, P1, which also supplies `listAgents`).
 */
export function botProfileWiring(
  db: Db,
  opts: BotProfileCompileOptions = {},
): {
  compile: (agentId: string, botKey: string) => Promise<CompiledProfile>;
  syncCard: (agentId: string, botKey: string) => Promise<BotCardSyncResult>;
} {
  const ports = createDbBotProfilePorts(db);
  return {
    compile: createBotProfileCompile(ports, opts),
    syncCard: createBotCardSync(createDbBotCardSyncPorts(db, ports)),
  };
}
