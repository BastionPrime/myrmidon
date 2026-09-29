// server/src/myrmidon/bot-containers/profile-compile.ts
//
// myrmidon(W2a): the `compile` connection point of the G3 reconciler
// (BotContainerRuntimeDeps.compile) filled in with the G2 compiler. This file is
// the seam between the two: it asks the injected ports (profile-ports.ts binds
// them to the database; tests pass fakes) for everything a card refers to, hands
// the result to buildHermesProfileInput, and runs compileHermesProfile on it.
//
// The reconciler calls compile on EVERY tick for every bot (see reconciler.ts),
// not only when something changed. Two consequences shape this file:
//   - compile must be idempotent: same card and same secrets give the same
//     CompiledProfile hashes, or the bot restarts every minute. So nothing here
//     generates a value per call: apiServerKey and the bot's board key are
//     get-or-create by a deterministic name (the ports' job), never per-call.
//   - warnings are reported when they change, not on every tick.

import { composeAgentsMd, resolveCardInstructions } from "./instructions-source.js";
import {
  compileHermesProfileDetailed,
  type HermesProfileEnvEntry,
  type HermesProfileInstanceDefaults,
  type HermesProfileSkillFile,
  type HermesProfileWorkspaceFile,
} from "./profile-compiler.js";
import {
  buildHermesProfileInput,
  BotProfileInputError,
  BOT_MCP_SERVERS_ENV,
  assertBotProfileSettings,
  readBotProfileSettings,
  type BotMcpSource,
  type BotProfileSettings,
} from "./profile-input.js";
import type { BotContainerActivitySink } from "./reconciler.js";
import type { CompiledProfile } from "./types.js";

export const HERMES_GATEWAY_ADAPTER_TYPE = "hermes_gateway";

export interface BotProfileAgentRecord {
  id: string;
  companyId: string;
  name: string;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  runtimeConfig: Record<string, unknown>;
}

export interface BotProfileWarningSink {
  (botKey: string, warnings: readonly string[], agentId: string): void | Promise<void>;
}

/**
 * The warning sink that writes to the reconcile activity log (the same sink
 * `startBotContainerReconciliation` takes as `activity`). Warnings are reported
 * when they change, so this is one entry per change, not one per tick.
 */
export function createActivityWarningSink(activity: BotContainerActivitySink): BotProfileWarningSink {
  return async (botKey, warnings, agentId) => {
    await activity.record({
      level: "info",
      agentId,
      botKey,
      message: "bot profile warnings",
      details: { warnings: [...warnings] },
    });
  };
}

/**
 * Said for every bot while the board tool gateway is not part of the profile
 * (`listMcpServers` unset). The gateway's run-scoped tokens live one hour and
 * cannot sit in a container's long-lived profile; a durable token is an owner
 * decision that is still open. The bot works without the gateway, but has no
 * board tools through MCP, and this line makes that visible instead of silent.
 */
export const NO_BOARD_GATEWAY_WARNING =
  "the profile has no board tool gateway MCP server: a durable gateway token for containers is an open owner decision";

/** Everything compile needs from the board. Implemented over the database in
 *  profile-ports.ts; faked in tests. Every method is read-or-get-or-create: none
 *  may produce a different value for the same bot on a second call. */
export interface BotProfilePorts {
  /** The agent as stored right now (compile never trusts a copy from an earlier tick). */
  loadAgent(agentId: string): Promise<BotProfileAgentRecord | null>;
  /** The card's env with each secret_ref resolved to its value. */
  resolveCardEnv(agent: BotProfileAgentRecord): Promise<{ env: Record<string, HermesProfileEnvEntry>; warnings: string[] }>;
  /** A company secret's current value by name; null when there is no such secret. */
  readCompanySecret(companyId: string, name: string): Promise<string | null>;
  /** The bot's gateway key (API_SERVER_KEY): created once as a company secret, then reused.
   *  `secretId` is what the card's `apiKey` secret_ref points at (card-sync.ts). */
  ensureApiServerKey(agent: BotProfileAgentRecord): Promise<{ value: string; secretId: string }>;
  /** The bot's own board API key (PAPERCLIP_API_KEY): created once, company secret, then reused. */
  ensureAgentApiKey(agent: BotProfileAgentRecord): Promise<{ value: string; warnings?: string[] }>;
  /** Company skills the card's desiredSkills name, as files, keyed by runtime name. */
  loadSkills(
    agent: BotProfileAgentRecord,
  ): Promise<{ skills: Record<string, readonly HermesProfileSkillFile[]>; warnings: string[] }>;
  /** The instructions bundle: the entry file's text ("" when there is none) and every other
   *  text file of the bundle. The card's own instructions are added by compile, not here. */
  loadInstructions(
    agent: BotProfileAgentRecord,
  ): Promise<{ entryText: string; files: HermesProfileWorkspaceFile[]; warnings: string[] }>;
  /** MCP servers for the bot: the board tool gateway and assigned connections. Optional:
   *  without it the profile carries no gateway server (compile then says so in its
   *  warnings). Instance-wide servers such as ragflow do not come through here: they
   *  are declared in MYRMIDON_BOT_MCP_SERVERS and resolved by compile itself. */
  listMcpServers?(agent: BotProfileAgentRecord): Promise<BotMcpSource[]>;
  /** Instance-wide compression/retention defaults. Optional. */
  instanceDefaults?(): Promise<HermesProfileInstanceDefaults>;
}

export interface BotProfileCompileOptions {
  env?: NodeJS.ProcessEnv;
  onWarnings?: BotProfileWarningSink;
}

/**
 * The servers declared in MYRMIDON_BOT_MCP_SERVERS, with each token read from
 * its company secret. Fails loudly when a secret is missing or empty: a bot
 * whose pilot acceptance depends on ragflow must not start without it and
 * without a word. Nothing is created, so a failure leaves nothing behind.
 */
async function resolveStaticMcpServers(
  ports: BotProfilePorts,
  companyId: string,
  settings: BotProfileSettings,
): Promise<BotMcpSource[]> {
  const sources: BotMcpSource[] = [];
  for (const server of settings.mcpServers) {
    if (server.tokenSecret === null) {
      sources.push({ name: server.name, url: server.url, token: "", noAuth: true, rewriteUrl: false });
      continue;
    }
    const token = await ports.readCompanySecret(companyId, server.tokenSecret);
    if (!token || !token.trim()) {
      throw new BotProfileInputError(
        `${BOT_MCP_SERVERS_ENV}: the company secret "${server.tokenSecret}" for server "${server.name}" is missing or empty`,
      );
    }
    sources.push({
      name: server.name,
      url: server.url,
      token,
      header: server.header,
      scheme: server.scheme,
      rewriteUrl: false,
    });
  }
  return sources;
}

/**
 * Returns the function to put into `BotContainerRuntimeDeps.compile`.
 * Instance settings (MYRMIDON_BOT_*) are read on every call, so a corrected
 * variable takes effect without the ports being rebuilt.
 */
export function createBotProfileCompile(
  ports: BotProfilePorts,
  opts: BotProfileCompileOptions = {},
): (agentId: string, botKey: string) => Promise<CompiledProfile> {
  const lastWarnings = new Map<string, string>();

  async function reportWarnings(agentId: string, botKey: string, warnings: string[]): Promise<void> {
    const signature = warnings.join("\n");
    if ((lastWarnings.get(botKey) ?? "") === signature) return;
    lastWarnings.set(botKey, signature);
    if (warnings.length === 0) return;
    try {
      await opts.onWarnings?.(botKey, warnings, agentId);
    } catch {
      // A failing warning sink must never fail a compile.
    }
  }

  return async function compile(agentId: string, botKey: string): Promise<CompiledProfile> {
    const settings = readBotProfileSettings(opts.env);
    // Before any lookup or secret creation: an unconfigured instance fails here
    // and leaves nothing behind.
    assertBotProfileSettings(settings);

    const agent = await ports.loadAgent(agentId);
    if (!agent) throw new BotProfileInputError(`agent ${agentId} no longer exists`);
    if (agent.adapterType !== HERMES_GATEWAY_ADAPTER_TYPE) {
      throw new BotProfileInputError(`agent adapter type is "${agent.adapterType}", not ${HERMES_GATEWAY_ADAPTER_TYPE}`);
    }

    // Read-only lookups first: a missing MCP token secret fails here, before the
    // ports below create the bot's keys, so a broken instance setting leaves nothing behind.
    const staticMcpServers = await resolveStaticMcpServers(ports, agent.companyId, settings);

    const [cardEnv, skills, instructions, apiServerKey, paperclipApiKey, gatewayMcpServers, instanceDefaults] =
      await Promise.all([
        ports.resolveCardEnv(agent),
        ports.loadSkills(agent),
        ports.loadInstructions(agent),
        ports.ensureApiServerKey(agent),
        ports.ensureAgentApiKey(agent),
        ports.listMcpServers ? ports.listMcpServers(agent) : Promise.resolve([] as BotMcpSource[]),
        ports.instanceDefaults ? ports.instanceDefaults() : Promise.resolve(undefined),
      ]);

    // The gateway key is only fetched when the card's own env does not carry it.
    let llmApiKey: string | null = null;
    if (settings.llmApiKeyEnv && !cardEnv.env[settings.llmApiKeyEnv]?.value?.trim()) {
      llmApiKey = await ports.readCompanySecret(agent.companyId, settings.llmApiKeySecret ?? settings.llmApiKeyEnv);
    }

    const built = buildHermesProfileInput(
      {
        botKey,
        adapterConfig: agent.adapterConfig,
        runtimeConfig: agent.runtimeConfig,
        env: cardEnv.env,
        skills: skills.skills,
        // The one place the model reads the instructions from (see instructions-source.ts):
        // the bundle's entry file, then the card's own instructions.
        instructions: composeAgentsMd(instructions.entryText, resolveCardInstructions(agent.adapterConfig)),
        workspaceFiles: instructions.files,
        llmApiKey,
        apiServerKey: apiServerKey.value,
        paperclipApiKey: paperclipApiKey.value,
        // Declared servers first: a same-named server from the gateway port loses to the operator's declaration.
        mcpServers: [...staticMcpServers, ...gatewayMcpServers],
        instanceDefaults,
      },
      settings,
    );

    const result = compileHermesProfileDetailed(built.input);
    await reportWarnings(agentId, botKey, [
      ...(ports.listMcpServers ? [] : [NO_BOARD_GATEWAY_WARNING]),
      ...cardEnv.warnings,
      ...(paperclipApiKey.warnings ?? []),
      ...skills.warnings,
      ...instructions.warnings,
      ...built.warnings,
      ...result.warnings,
    ]);
    return result.profile;
  };
}
