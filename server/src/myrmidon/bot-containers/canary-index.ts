// myrmidon(R5-B): wiring of the bot image canary. The canary service needs
// the bot container runtime (the same one the sweep and the card's "Apply
// now" use), the agents list, and the canary bot's gateway key; this module
// binds those to the database-backed runtime and starts the reconciliation
// tick. Off by default: until MYRMIDON_BOT_CANARY=1 (and
// MYRMIDON_BOT_CANARY_SELECTOR names a canary bot) nothing is created or
// read, and the routes answer "not enabled".

import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { logActivity } from "../../services/activity-log.js";
import type { BotContainerAgent, ApplyBotContainerOutcome } from "./index.js";
import { applyBotContainerNow } from "./index.js";
import { readBotContainerAgentConfig, botKeyForAgent } from "./agent-config.js";
import { botCanaryRoutes } from "./canary-routes.js";
import { botCanaryService, type BotCanaryRuntimePort, type BotCanaryService } from "./canary-service.js";
import { readBotCanarySettings } from "./canary-settings.js";
import { getBotContainerRuntime } from "./routes-wiring.js";
import { apiServerKeySecretName } from "./profile-ports.js";

/**
 * The runtime port over the registered bot container runtime (startup.ts
 * registers it; until then the routes answer "runtime not configured" the
 * same way the card's "Apply now" does).
 */
export function botCanaryRuntimePort(db: Db, env: NodeJS.ProcessEnv = process.env): BotCanaryRuntimePort {
  return {
    listAgents: async () => {
      const runtime = getBotContainerRuntime();
      if (!runtime) return [];
      // The canary service only needs agent ids and cards; reuse the sweep's
      // own agents source by listing through the runtime's deps is not
      // possible (they are injected at startup), so the port queries the same
      // agents table shape through the registered runtime's applyNow path —
      // see listBotContainerAgents in agents-query.ts, which startup passes.
      // Here: the caller (index.ts wiring below) injects the real listAgents.
      return botCanaryListAgents(db);
    },
    applyNow: async (agent: BotContainerAgent, image: string, envForApply: NodeJS.ProcessEnv): Promise<ApplyBotContainerOutcome> => {
      const runtime = getBotContainerRuntime();
      if (!runtime) {
        return { kind: "error", message: "the bot container runtime is not configured on this instance" };
      }
      const parsed = readBotContainerAgentConfig(agent.adapterType, agent.adapterConfig);
      if (!parsed.ok) return { kind: "not_applicable", reason: parsed.reason };
      const botKey = botKeyForAgent(agent.agentId);
      if (!botKey) return { kind: "not_applicable", reason: `agent id "${agent.agentId}" cannot be used as a bot key` };
      // myrmidon(R5-B): drive the same reconcile the sweep drives, with the
      // rollout's image in the card's place — the spec is otherwise the card's
      // own (memory, cpu, pids, mounts). The per-bot lock serializes this with
      // the sweep for this bot.
      return applyBotContainerNow(
        { ...agent, adapterConfig: { ...agent.adapterConfig, container: { ...parsed.config, image } } },
        runtime,
        { env: envForApply },
      );
    },
    status: async (botKey: string) => {
      const runtime = getBotContainerRuntime();
      if (!runtime) throw new Error("the bot container runtime is not configured on this instance");
      return runtime.driver.status(botKey);
    },
    canaryApiKey: async (botKey: string) => {
      // The canary's gateway key is the agent's API_SERVER_KEY secret. Read
      // through the profile ports' ensureApiServerKey (get-or-create by
      // deterministic name), the same secret the profile compiler writes into
      // hermes/.env and card-sync points the card at. The value stays in
      // memory and is used only as the smoke run's bearer.
      const { agentService, secretService } = await import("../../services/index.js");
      const agents = agentService(db);
      const secrets = secretService(db);
      const agent = await agents.getById(botKey);
      if (!agent) return null;
      const secret = await secrets.getByName(agent.companyId, apiServerKeySecretName(agent.id));
      if (!secret) return null;
      return secrets.resolveSecretValue(agent.companyId, secret.id, "latest");
    },
  };
}

/** The agents list, injected from the wiring below (agents-query.ts shape). */
async function botCanaryListAgents(db: Db): Promise<BotContainerAgent[]> {
  const { listBotContainerAgents } = await import("./agents-query.js");
  return listBotContainerAgents(db)();
}

/** Router for app.ts: the bot image canary routes. */
export function myrmidonBotCanaryRoutes(db: Db) {
  return botCanaryRoutes(db, botCanaryService(db, canaryServiceDeps(db)));
}

function canaryServiceDeps(db: Db): Parameters<typeof botCanaryService>[1] {
  return {
    runtime: botCanaryRuntimePort(db),
    logActivity: ((dbArg: unknown, entry: Parameters<typeof logActivity>[1]) =>
      logActivity(dbArg as Db, entry)) as typeof logActivity,
  };
}

let stopTick: (() => void) | null = null;

/**
 * Startup: run the reconciliation tick on an interval, resuming an open
 * rollout after a restart. A failed tick is logged and retried; an instance
 * without the feature enabled starts nothing. Returns the stop function.
 */
export function startBotCanary(db: Db, opts: { env?: NodeJS.ProcessEnv; deps?: Partial<Parameters<typeof botCanaryService>[1]> } = {}): () => void {
  const env = opts.env ?? process.env;
  const settings = readBotCanarySettings(env);
  if (!settings.enabled) return () => undefined;
  const service = botCanaryService(db, { ...canaryServiceDeps(db), ...(opts.deps ?? {}) });
  const timer = setInterval(() => {
    void service.tick().catch((err) => logger.error({ err }, "bot canary tick failed"));
  }, settings.tickMs);
  timer.unref?.();
  void service.tick().catch((err) => logger.error({ err }, "bot canary startup tick failed"));
  stopTick = () => clearInterval(timer);
  return () => {
    stopTick?.();
    stopTick = null;
  };
}

/** Stops the tick started by `startBotCanary` (server shutdown). */
export function stopBotCanary(): void {
  stopTick?.();
  stopTick = null;
}

export type { BotCanaryService };
