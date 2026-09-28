// server/src/myrmidon/bot-containers/index.ts
//
// Wiring for the bot container reconciler (G3): reads an agent's container config
// off its card, adapts the real maintenance mode (R3) to reconciler.ts's narrow
// port, and offers both a periodic sweep and a single-agent "apply now" entry
// point — both gated behind MYRMIDON_BOT_CONTAINERS (off by default).
//
// What is deliberately NOT here:
//  - compileHermesProfile (G2, a neighboring PR): `BotContainerRuntimeDeps.compile`
//    is the one explicit connection point a caller fills in once G2 lands.
//  - the actual agents-table query behind `startBotContainerReconciliation`: that
//    is passed in as `listAgents` rather than written here, so this module does
//    not guess at query shapes for a table it does not otherwise touch. The pilot
//    PR (P1, containers-plan-senior-2026-09-28.md's release table) is expected to
//    supply it and call startBotContainerReconciliation from server/src/index.ts,
//    the same way that file already calls startMaintenanceMode.
//  - the container image builder and docker-compose network (G1).

import type { Db } from "@paperclipai/db";
import { maintenanceHeartbeatPort, maintenanceService } from "../maintenance/index.js";
import { heartbeatService } from "../../services/index.js";
import {
  botContainerSpec,
  botKeyForAgent,
  isBotContainersEnabled,
  readBotContainerAgentConfig,
} from "./agent-config.js";
import type { BotContainerDriver } from "./driver.js";
import {
  reconcileBot,
  type BotContainerActivitySink,
  type BotMaintenancePort,
  type MaintenanceWindowView,
  type ReconcileOutcome,
} from "./reconciler.js";
import type { CompiledProfile } from "./types.js";

const BOT_CONTAINER_ACTOR = { actorType: "system", actorId: "myrmidon-bot-containers" };

/** Adapts the real R3 maintenance service to reconciler.ts's narrow port, scoped to
 *  one agent at a time. Confirmed against maintenance/domain.ts: `windowCoversAgent`
 *  and `MAINTENANCE_SCOPE_TYPES` both already support `scope: {type: "agent"}` — no
 *  change to the maintenance module was needed for this. */
export function realBotMaintenancePort(db: Db): BotMaintenancePort {
  const service = maintenanceService(db, { heartbeat: maintenanceHeartbeatPort(heartbeatService(db)) });
  return {
    async enter(agentId, reason, drainTimeoutSec): Promise<MaintenanceWindowView> {
      const view = await service.enter(
        { scope: { type: "agent", id: agentId }, reason, drainTimeoutSec, onTimeout: "interrupt_and_retry" },
        BOT_CONTAINER_ACTOR,
      );
      return { state: view.state, runningRuns: view.runningRuns };
    },
    async status(agentId): Promise<MaintenanceWindowView> {
      const result = await service.status({ type: "agent", id: agentId });
      const window = result.windows[0];
      return window ? { state: window.state, runningRuns: window.runningRuns } : { state: "off", runningRuns: 0 };
    },
    async exit(agentId, reason): Promise<void> {
      await service.exit({ type: "agent", id: agentId }, BOT_CONTAINER_ACTOR, reason);
    },
  };
}

export interface BotContainerAgent {
  agentId: string;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
}

export interface BotContainerRuntimeDeps {
  driver: BotContainerDriver;
  /** TODO(compileHermesProfile): the one connection point for G2's compiler. */
  compile: (agentId: string, botKey: string) => Promise<CompiledProfile>;
  maintenance: BotMaintenancePort;
  activity?: BotContainerActivitySink;
  network: string;
}

export type ApplyBotContainerOutcome = ReconcileOutcome | { kind: "not_applicable"; reason: string };

/** The "apply now" entry point for one agent — wired to a button on the card, or
 *  called right after a card/project save, per containers-plan-senior-2026-09-28.md
 *  §2.2. A no-op ({kind: "not_applicable"}) for any agent that is not an enabled
 *  hermes_gateway bot; reconcileBot itself never throws. */
export async function applyBotContainerNow(
  agent: BotContainerAgent,
  deps: BotContainerRuntimeDeps,
): Promise<ApplyBotContainerOutcome> {
  const parsed = readBotContainerAgentConfig(agent.adapterType, agent.adapterConfig);
  if (!parsed.ok) return { kind: "not_applicable", reason: parsed.reason };
  const botKey = botKeyForAgent(agent.agentId, parsed.config);
  const spec = botContainerSpec(botKey, parsed.config, deps.network);
  return reconcileBot({
    agentId: agent.agentId,
    botKey,
    spec,
    compile: () => deps.compile(agent.agentId, botKey),
    driver: deps.driver,
    maintenance: deps.maintenance,
    activity: deps.activity,
  });
}

export const DEFAULT_RECONCILE_INTERVAL_MS = 60_000;

/**
 * Periodic reconciliation sweep, gated by MYRMIDON_BOT_CONTAINERS (off by
 * default). `listAgents` is injected rather than queried here — see the module
 * comment above — which also makes this directly testable with a fake list and a
 * fake driver/maintenance, the same way applyManagedEnvironments's tests work.
 * Returns a stop function; a disabled flag returns a no-op stop immediately and
 * never calls `listAgents`.
 */
export function startBotContainerReconciliation(
  listAgents: () => Promise<BotContainerAgent[]>,
  deps: BotContainerRuntimeDeps,
  opts: { intervalMs?: number; env?: NodeJS.ProcessEnv } = {},
): () => void {
  if (!isBotContainersEnabled(opts.env)) return () => {};
  const intervalMs = opts.intervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;
  let stopped = false;

  async function tick(): Promise<void> {
    let agents: BotContainerAgent[];
    try {
      agents = await listAgents();
    } catch (err) {
      await deps.activity?.record({
        level: "error",
        agentId: "*",
        botKey: "*",
        message: "bot container reconciliation sweep failed to list agents",
        details: { error: err instanceof Error ? err.message : String(err) },
      });
      return;
    }
    for (const agent of agents) {
      if (stopped) return;
      // reconcileBot (inside applyBotContainerNow) never throws; this catch only
      // guards the not-applicable/parsing path around it.
      await applyBotContainerNow(agent, deps).catch(() => undefined);
    }
  }

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  void tick();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export {
  BOT_CONTAINERS_ENV,
  botContainerSpec,
  botKeyForAgent,
  isBotContainersEnabled,
  readBotContainerAgentConfig,
} from "./agent-config.js";
export type { BotContainerAgentConfig, BotContainerAgentConfigResult } from "./agent-config.js";
export type { BotContainerDriver, BotContainerSpec } from "./driver.js";
export type {
  BotContainerActivitySink,
  BotMaintenancePort,
  MaintenanceWindowView,
  ReconcileOutcome,
} from "./reconciler.js";
export { reconcileBot } from "./reconciler.js";
export { classifyProfileChange } from "./types.js";
export type { AppliedProfileState, CompiledProfile, CompiledProfileFile, ProfileChangeClass } from "./types.js";
export { dockerBotContainerDriver, readDockerDriverConfig } from "./docker-driver.js";
