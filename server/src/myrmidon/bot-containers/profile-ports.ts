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
//    unless something is missing, and it resolves the secrets it reads without
//    a binding/audit context (no access event per secret per bot per minute):
//    two secrets this file created itself, the instance-wide gateway key and
//    the MCP tokens. The exception is the card's own env, which a card's author
//    controls: card-env.ts resolves it WITH a binding context (the board checks
//    that the secret is bound to this agent) and keeps the result in memory,
//    re-resolving only when the card's bindings or those secrets' versions change.
//  - A secret it creates is get-or-create by a deterministic name, so a second
//    call returns the same value (compile must give the same hashes tick after
//    tick, or the bot restarts every minute).

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { agentApiKeys, companies, companyMemberships, type Db } from "@paperclipai/db";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
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
import { BOT_AGENT_API_KEY_NAME, ensureBotAgentKey } from "./agent-key.js";
import { createBotCardSync, type BotCardSyncPorts, type BotCardSyncResult } from "./card-sync.js";
import { createCardEnvResolver } from "./card-env.js";
import { loadBotInstructionsBundle } from "./instructions-source.js";
import {
  createActivityWarningSink,
  createBotProfileCompile,
  type BotProfileAgentRecord,
  type BotProfileCompileOptions,
  type BotProfilePorts,
} from "./profile-compile.js";
import type { HermesProfileSkillFile } from "./profile-compiler.js";
import type { BotContainerActivitySink } from "./reconciler.js";
import type { CompiledProfile } from "./types.js";

export { BOT_AGENT_API_KEY_NAME };

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
 * Until that is decided, a bot's profile carries no board-gateway MCP server, and
 * compile says so in the activity log (a warning, once per change) instead of
 * staying silent. The instance-wide servers (ragflow and the like) do NOT depend
 * on this port: they are declared in MYRMIDON_BOT_MCP_SERVERS, and compile
 * resolves their tokens through `readCompanySecret`.
 */
export function createDbBotProfilePorts(db: Db): BotProfilePorts {
  const agents = agentService(db);
  const secrets = secretService(db);
  const skills = companySkillService(db);
  const instructions = agentInstructionsService();
  const instanceSettings = instanceSettingsService(db);
  const resolveCardEnv = createCardEnvResolver({
    resolveEnvBindings: (companyId, bindings, context) => secrets.resolveEnvBindings(companyId, bindings, context),
    async readSecretStamp(companyId, secretId) {
      const secret = await secrets.getById(secretId);
      if (!secret || secret.companyId !== companyId) return null;
      return `${secret.latestVersion}:${secret.status}`;
    },
  });

  return {
    async loadAgent(agentId) {
      const row = await agents.getById(agentId);
      return row ? toAgentRecord(row) : null;
    },

    resolveCardEnv,

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
      return ensureBotAgentKey(
        {
          async readSecret() {
            const secret = await secrets.getByName(agent.companyId, secretName);
            if (!secret) return null;
            return { secretId: secret.id, value: await secrets.resolveSecretValue(agent.companyId, secret.id, "latest") };
          },
          async findActiveKeyByToken(agentId, token) {
            // The token's own hash against the key table: "a key with the bot's name is active"
            // says nothing about whether THIS token still opens the board.
            const rows = await db
              .select({ id: agentApiKeys.id, responsibleUserId: agentApiKeys.responsibleUserId })
              .from(agentApiKeys)
              .where(
                and(
                  eq(agentApiKeys.agentId, agentId),
                  eq(agentApiKeys.keyHash, createHash("sha256").update(token).digest("hex")),
                  isNull(agentApiKeys.revokedAt),
                ),
              )
              .limit(1);
            return rows[0] ? { id: rows[0].id, responsibleUserId: rows[0].responsibleUserId?.trim() || null } : null;
          },
          async listActiveBotKeyIds(agentId) {
            const keys = await agents.listKeys(agentId);
            return keys.filter((key) => key.name === BOT_AGENT_API_KEY_NAME && !key.revokedAt).map((key) => key.id);
          },
          async readCompanyDefaultResponsibleUserId() {
            // The same rule as the board's own work without an actor (routines): the company's
            // explicit default first, then its oldest active owner.
            const rows = await db
              .select({ userId: companies.defaultResponsibleUserId })
              .from(companies)
              .where(eq(companies.id, agent.companyId))
              .limit(1);
            return rows[0]?.userId?.trim() || null;
          },
          async findCompanyOwnerUserId() {
            const rows = await db
              .select({ userId: companyMemberships.principalId })
              .from(companyMemberships)
              .where(
                and(
                  eq(companyMemberships.companyId, agent.companyId),
                  eq(companyMemberships.principalType, "user"),
                  eq(companyMemberships.status, "active"),
                  eq(companyMemberships.membershipRole, "owner"),
                ),
              )
              .orderBy(asc(companyMemberships.createdAt), asc(companyMemberships.id))
              .limit(1);
            return rows[0]?.userId?.trim() || null;
          },
          async createKey(agentId, responsibleUserId) {
            const created = await agents.createApiKey(agentId, BOT_AGENT_API_KEY_NAME, { kind: "standard" }, { responsibleUserId });
            return { id: created.id, token: created.token };
          },
          async fillKeyResponsibleUser(agentId, keyId, responsibleUserId) {
            // One conditional UPDATE: only this driver's own, still active key, and only while its
            // field is empty (NULL or blank, which the board treats the same). Never overwrites.
            const updated = await db
              .update(agentApiKeys)
              .set({ responsibleUserId })
              .where(
                and(
                  eq(agentApiKeys.id, keyId),
                  eq(agentApiKeys.agentId, agentId),
                  eq(agentApiKeys.name, BOT_AGENT_API_KEY_NAME),
                  isNull(agentApiKeys.revokedAt),
                  sql`coalesce(btrim(${agentApiKeys.responsibleUserId}), '') = ''`,
                ),
              )
              .returning({ id: agentApiKeys.id });
            return updated.length > 0;
          },
          async revokeKey(agentId, keyId) {
            await agents.revokeKey(agentId, keyId);
          },
          async storeSecret(existing, token) {
            if (existing) {
              await secrets.rotate(existing.secretId, { value: token }, SYSTEM_ACTOR);
              return;
            }
            await secrets.create(
              agent.companyId,
              {
                name: secretName,
                provider: getConfiguredSecretProvider(),
                value: token,
                description: `Board API key of the bot container for agent ${agent.name}`,
              },
              SYSTEM_ACTOR,
            );
          },
        },
        agent.id,
      );
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
      // Only the bundle's files beside its entry file are read here: the instructions
      // themselves travel in the run request (see instructions-source.ts).
      const bundle = await instructions.getBundle(agent);
      return loadBotInstructionsBundle({
        async listBundle() {
          if (!bundle.rootPath) return null;
          return {
            entryFile: bundle.entryFile,
            files: bundle.files.map((file) => ({ path: file.path, size: file.size, virtual: file.virtual })),
          };
        },
        async readFile(relativePath) {
          return (await instructions.readFile(agent, relativePath)).content;
        },
      });
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
 *   startBotContainerReconciliation(listAgents, { driver, maintenance, network, activity, ...botProfileWiring(db, { activity }) })
 *
 * (the call is startup.ts, `startBotContainers`, with `listAgents` from agents-query.ts).
 *
 * Profile warnings (a skipped skill, a bundle file over the limit, the missing board
 * gateway) go to `opts.onWarnings`, or, when only `opts.activity` is given, to that
 * activity log: the same place the reconciler writes its own events.
 */
export function botProfileWiring(
  db: Db,
  opts: BotProfileCompileOptions & { activity?: BotContainerActivitySink } = {},
): {
  compile: (agentId: string, botKey: string) => Promise<CompiledProfile>;
  syncCard: (agentId: string, botKey: string) => Promise<BotCardSyncResult>;
} {
  const ports = createDbBotProfilePorts(db);
  const { activity, ...compileOptions } = opts;
  const onWarnings = compileOptions.onWarnings ?? (activity ? createActivityWarningSink(activity) : undefined);
  return {
    compile: createBotProfileCompile(ports, { ...compileOptions, ...(onWarnings ? { onWarnings } : {}) }),
    syncCard: createBotCardSync(createDbBotCardSyncPorts(db, ports)),
  };
}
