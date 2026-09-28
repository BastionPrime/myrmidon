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
  botContainerConfigsMatch,
  botContainerSpec,
  botKeyForAgent,
  groupByBotKey,
  isBotContainersEnabled,
  pickCanonicalGroupMember,
  readBotContainerAgentConfig,
  type BotContainerAgentConfig,
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
 * How many botKeys a sweep reconciles concurrently. A single "restart"- or
 * drift-class reconcile can legitimately take minutes (maintenance drain timeout +
 * grace + the restart's own health wait, see reconciler.ts / docker-driver.ts) —
 * processing botKeys one at a time (the original implementation) meant one slow
 * bot delayed every other bot's reconcile, including an unrelated one that just
 * needed a cheap stopped/unhealthy recovery restart, by however long the slow one
 * took. Fixed rather than a new MYRMIDON_BOT_* setting (own-judgment-call item —
 * see the PR's "decisions made without the owner" section): each distinct botKey
 * in a tick is independent (see `resolveCanonicalAgentsForTick`), so bounding
 * concurrency only limits how many `docker exec`/HTTP calls the socket sees at
 * once, not correctness.
 */
const RECONCILE_CONCURRENCY = 4;

/**
 * Resolves the list of agents a sweep should actually reconcile this tick: agents
 * that failed `readBotContainerAgentConfig` are dropped (nothing to do — mirrors
 * `applyBotContainerNow`'s own not_applicable no-op), and agents sharing a
 * `container.group` (and therefore a botKey — see agent-config.ts's
 * `botKeyForAgent`) are collapsed to one deterministically-chosen member
 * (`pickCanonicalGroupMember`) so the shared container is reconciled from exactly
 * one card, not once per member racing to impose its own image/resources on it.
 * A member whose config disagrees with the chosen one is flagged to the activity
 * sink (not silently overridden) so a real misconfiguration is visible instead of
 * manifesting as the container quietly oscillating between two specs.
 */
async function resolveCanonicalAgentsForTick(
  agents: readonly BotContainerAgent[],
  activity: BotContainerActivitySink | undefined,
): Promise<BotContainerAgent[]> {
  const parsed: { agent: BotContainerAgent; config: BotContainerAgentConfig }[] = [];
  for (const agent of agents) {
    const result = readBotContainerAgentConfig(agent.adapterType, agent.adapterConfig);
    if (result.ok) parsed.push({ agent, config: result.config });
  }

  const groups = groupByBotKey(parsed);
  const canonicalAgents: BotContainerAgent[] = [];
  for (const [botKey, members] of groups) {
    const canonical = pickCanonicalGroupMember(members);
    canonicalAgents.push(canonical.agent);
    for (const member of members) {
      if (member === canonical) continue;
      if (!botContainerConfigsMatch(canonical.config, member.config)) {
        await activity?.record({
          level: "error",
          agentId: member.agent.agentId,
          botKey,
          message:
            "agents sharing container.group disagree on image/memoryMb/cpus/pidsLimit; only the lexicographically-first agent's card is applied this sweep",
          details: { canonicalAgentId: canonical.agent.agentId },
        });
      }
    }
  }
  return canonicalAgents;
}

/** Runs `worker` over `items` with at most `limit` calls in flight at once,
 *  preserving no particular completion order. A worker rejecting does not stop the
 *  others — callers (here, `applyBotContainerNow`'s own `.catch`) are expected to
 *  swallow their own errors, same as the original sequential loop did. */
async function runWithConcurrency<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  async function runNext(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runNext()));
}

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

  // Without this guard, a slow sweep (see RECONCILE_CONCURRENCY's comment above)
  // would still be running when the next tick fires, and two overlapping passes
  // over the same bot could race writeProfile/restart against each other. Mirrors
  // maintenanceService's own tick() guard (server/src/myrmidon/maintenance/service.ts).
  let tickInFlight: Promise<void> | null = null;

  function tick(): Promise<void> {
    if (tickInFlight) return tickInFlight;
    tickInFlight = (async () => {
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
      const canonicalAgents = await resolveCanonicalAgentsForTick(agents, deps.activity);
      await runWithConcurrency(canonicalAgents, RECONCILE_CONCURRENCY, async (agent) => {
        if (stopped) return;
        // reconcileBot (inside applyBotContainerNow) never throws; this catch only
        // guards the not-applicable/parsing path around it.
        await applyBotContainerNow(agent, deps).catch(() => undefined);
      });
    })().finally(() => {
      tickInFlight = null;
    });
    return tickInFlight;
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
