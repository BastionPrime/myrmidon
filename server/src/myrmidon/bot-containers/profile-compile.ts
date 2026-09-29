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

import {
  compileHermesProfileDetailed,
  type HermesProfileEnvEntry,
  type HermesProfileInstanceDefaults,
  type HermesProfileSkillFile,
} from "./profile-compiler.js";
import {
  buildHermesProfileInput,
  BotProfileInputError,
  assertBotProfileSettings,
  readBotProfileSettings,
  type BotMcpSource,
} from "./profile-input.js";
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
  (botKey: string, warnings: readonly string[]): void | Promise<void>;
}

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
  ensureAgentApiKey(agent: BotProfileAgentRecord): Promise<{ value: string }>;
  /** Company skills the card's desiredSkills name, as files, keyed by runtime name. */
  loadSkills(
    agent: BotProfileAgentRecord,
  ): Promise<{ skills: Record<string, readonly HermesProfileSkillFile[]>; warnings: string[] }>;
  /** The instructions bundle's entry file text ("" when there is none). */
  loadInstructions(agent: BotProfileAgentRecord): Promise<string>;
  /** MCP servers for the bot: the board tool gateway and assigned connections. Optional:
   *  without it the profile carries no MCP servers (see the PR's risks). */
  listMcpServers?(agent: BotProfileAgentRecord): Promise<BotMcpSource[]>;
  /** Instance-wide compression/retention defaults. Optional. */
  instanceDefaults?(): Promise<HermesProfileInstanceDefaults>;
}

export interface BotProfileCompileOptions {
  env?: NodeJS.ProcessEnv;
  onWarnings?: BotProfileWarningSink;
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

  async function reportWarnings(botKey: string, warnings: string[]): Promise<void> {
    const signature = warnings.join("\n");
    if ((lastWarnings.get(botKey) ?? "") === signature) return;
    lastWarnings.set(botKey, signature);
    if (warnings.length === 0) return;
    try {
      await opts.onWarnings?.(botKey, warnings);
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

    const [cardEnv, skills, instructions, apiServerKey, paperclipApiKey, mcpServers, instanceDefaults] = await Promise.all([
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
        instructions,
        llmApiKey,
        apiServerKey: apiServerKey.value,
        paperclipApiKey: paperclipApiKey.value,
        mcpServers,
        instanceDefaults,
      },
      settings,
    );

    const result = compileHermesProfileDetailed(built.input);
    await reportWarnings(botKey, [...cardEnv.warnings, ...skills.warnings, ...built.warnings, ...result.warnings]);
    return result.profile;
  };
}
