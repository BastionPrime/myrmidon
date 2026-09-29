// server/src/myrmidon/bot-containers/index.ts
//
// Wiring for the bot container reconciler (G3): reads an agent's container config
// off its card, adapts the real maintenance mode (R3) to reconciler.ts's narrow
// port, and offers both a periodic sweep and a single-agent "apply now" entry
// point — both gated behind MYRMIDON_BOT_CONTAINERS (off by default), and both
// serialized per bot through the same lock (bot-key-lock.ts), so a sweep and an
// "apply now" for one bot never run at the same time.
//
// W2a fills the two connection points this module leaves open for the board's own
// data: `BotContainerRuntimeDeps.compile` (profile-compile.ts builds the input of
// the G2 compiler from the card) and `syncCard` (card-sync.ts points the card's
// apiBaseUrl/apiKey at the container once it is up). Both are still injected here,
// bound to the database in profile-ports.ts — this module stays free of queries.
//
// What is deliberately NOT here:
//  - the actual agents-table query behind `startBotContainerReconciliation`: that
//    is passed in as `listAgents` rather than written here, so this module does
//    not guess at query shapes for a table it does not otherwise touch. It is
//    agents-query.ts, and startup.ts (called from server/src/index.ts next to
//    startMaintenanceMode) builds the runtime, starts the sweep with it and
//    registers the runtime for the card's "Apply now" (routes-wiring.ts).
//  - the container image builder and docker-compose network (G1).

import type { Db } from "@paperclipai/db";
import { maintenanceHeartbeatPort, maintenanceService } from "../maintenance/index.js";
import { heartbeatService } from "../../services/index.js";
import {
  BOT_CONTAINERS_ENV,
  botContainerSpec,
  botKeyForAgent,
  isBotContainersEnabled,
  readBotContainerAgentConfig,
} from "./agent-config.js";
import { botKeyLock, type BotKeyLock } from "./bot-key-lock.js";
import type { BotContainerDriver } from "./driver.js";
import {
  reconcileBot,
  type BotContainerActivitySink,
  type BotMaintenancePort,
  type MaintenanceEnterResult,
  type MaintenanceWindowState,
  type MaintenanceWindowView,
  type ReconcileOutcome,
} from "./reconciler.js";
import type { CompiledProfile } from "./types.js";

export const BOT_CONTAINER_ACTOR = { actorType: "system", actorId: "myrmidon-bot-containers" } as const;

interface MaintenanceActorRef {
  actorType: string;
  actorId: string;
}

/** The part of maintenanceService (maintenance/service.ts) the port needs. */
export interface BotMaintenanceServiceSlice {
  enter(
    input: {
      scope: { type: "agent"; id: string };
      reason: string;
      drainTimeoutSec: number;
      onTimeout: "interrupt_and_retry";
    },
    actor: MaintenanceActorRef,
  ): Promise<{ state: MaintenanceWindowState; runningRuns: number; changed: boolean; startedBy: MaintenanceActorRef | null }>;
  status(scope: { type: "agent"; id: string }): Promise<{ windows: Array<{ state: MaintenanceWindowState; runningRuns: number }> }>;
  exit(scope: { type: "agent"; id: string }, actor: MaintenanceActorRef, reason?: string): Promise<unknown>;
}

/**
 * Adapts R3's maintenance service to reconciler.ts's port, scoped to one agent.
 * `owned` is what keeps the reconciler out of other people's windows:
 * maintenanceService.enter returns an already-open window for the same scope
 * unchanged (`changed: false`) instead of opening a new one, so only a window
 * this call opened (`changed: true`) — or one the reconciler's own actor opened
 * on an earlier, interrupted pass — may be used and then exited.
 */
export function botMaintenancePortFromService(service: BotMaintenanceServiceSlice): BotMaintenancePort {
  return {
    async enter(agentId, reason, drainTimeoutSec): Promise<MaintenanceEnterResult> {
      const view = await service.enter(
        { scope: { type: "agent", id: agentId }, reason, drainTimeoutSec, onTimeout: "interrupt_and_retry" },
        BOT_CONTAINER_ACTOR,
      );
      const openedByReconciler =
        view.startedBy?.actorType === BOT_CONTAINER_ACTOR.actorType &&
        view.startedBy?.actorId === BOT_CONTAINER_ACTOR.actorId;
      return { state: view.state, runningRuns: view.runningRuns, owned: view.changed || openedByReconciler };
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

/** The real R3 service behind the port. `scope: {type: "agent"}` is already
 *  supported there (maintenance/domain.ts `windowCoversAgent`). */
export function realBotMaintenancePort(db: Db): BotMaintenancePort {
  return botMaintenancePortFromService(
    maintenanceService(db, { heartbeat: maintenanceHeartbeatPort(heartbeatService(db)) }),
  );
}

export interface BotContainerAgent {
  agentId: string;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
}

export interface BotContainerRuntimeDeps {
  driver: BotContainerDriver;
  /** Builds the bot's compiled profile: createBotProfileCompile (profile-compile.ts), which
   *  feeds G2's compileHermesProfile from the card. */
  compile: (agentId: string, botKey: string) => Promise<CompiledProfile>;
  /** Optional. Runs after a reconcile pass that left the container in place with its
   *  profile applied (created / applied_* / unchanged), inside the same per-bot lock:
   *  createBotCardSync (card-sync.ts) sets the card's apiBaseUrl/apiKey to the
   *  container. A failure is recorded in the activity log; it does not change the
   *  reconcile outcome, since the container itself is fine. */
  syncCard?: (agentId: string, botKey: string) => Promise<{ changedKeys: string[] }>;
  /** Optional. Called by every sweep with the ids of the agents the sweep reconciles: releases the board
   *  tool gateways made for any other agent (deleted, terminated, switched to another adapter or with the
   *  container turned off), which no reconcile pass reaches any more (board-gateway-ports.ts). */
  releaseStrayGateways?: (keepAgentIds: ReadonlySet<string>) => Promise<{ released: number; warnings: string[] }>;
  maintenance: BotMaintenancePort;
  activity?: BotContainerActivitySink;
  network: string;
  /** Defaults to the process-wide lock; tests pass their own. */
  lock?: BotKeyLock;
}

export type ApplyBotContainerOutcome = ReconcileOutcome | { kind: "not_applicable"; reason: string };

/** The "apply now" entry point for one agent — wired to a button on the card, or
 *  called right after a card/project save, per containers-plan-senior-2026-09-28.md
 *  §2.2. A no-op ({kind: "not_applicable"}) while MYRMIDON_BOT_CONTAINERS is off
 *  and for any agent that is not an enabled hermes_gateway bot. Waits for any
 *  reconcile of the same bot already in progress (sweep or another "apply now")
 *  to finish first; reconcileBot itself never throws. */
export async function applyBotContainerNow(
  agent: BotContainerAgent,
  deps: BotContainerRuntimeDeps,
  opts: { env?: NodeJS.ProcessEnv } = {},
): Promise<ApplyBotContainerOutcome> {
  if (!isBotContainersEnabled(opts.env)) {
    return { kind: "not_applicable", reason: `${BOT_CONTAINERS_ENV} is not enabled` };
  }
  const parsed = readBotContainerAgentConfig(agent.adapterType, agent.adapterConfig);
  if (!parsed.ok) return { kind: "not_applicable", reason: parsed.reason };
  const botKey = botKeyForAgent(agent.agentId);
  if (!botKey) return { kind: "not_applicable", reason: `agent id "${agent.agentId}" cannot be used as a bot key` };
  const spec = botContainerSpec(botKey, parsed.config, deps.network);
  const lock = deps.lock ?? botKeyLock;
  return lock.run(botKey, async () => {
    const outcome = await reconcileBot({
      agentId: agent.agentId,
      botKey,
      spec,
      compile: () => deps.compile(agent.agentId, botKey),
      driver: deps.driver,
      maintenance: deps.maintenance,
      activity: deps.activity,
    });
    if (deps.syncCard && leavesContainerApplied(outcome)) {
      await syncCardAfterReconcile(agent.agentId, botKey, deps.syncCard, deps.activity);
    }
    return outcome;
  });
}

/** `deferred` (a change waiting for a maintenance window) and `error` say nothing
 *  about the container being ready for the card to point at, so they skip the sync. */
function leavesContainerApplied(outcome: ReconcileOutcome): boolean {
  return (
    outcome.kind === "created" ||
    outcome.kind === "applied_files" ||
    outcome.kind === "applied_restart" ||
    outcome.kind === "unchanged"
  );
}

async function syncCardAfterReconcile(
  agentId: string,
  botKey: string,
  syncCard: NonNullable<BotContainerRuntimeDeps["syncCard"]>,
  activity: BotContainerActivitySink | undefined,
): Promise<void> {
  // Never throws: neither a failing sync nor a failing activity sink may fail the pass.
  try {
    const { changedKeys } = await syncCard(agentId, botKey);
    if (changedKeys.length > 0) {
      await activity?.record({
        level: "info",
        agentId,
        botKey,
        message: "agent card pointed at the bot container",
        details: { changedKeys },
      });
    }
  } catch (err) {
    try {
      await activity?.record({
        level: "error",
        agentId,
        botKey,
        message: "failed to point the agent card at the bot container",
        details: { error: err instanceof Error ? err.message : String(err) },
      });
    } catch {
      // nothing left to report to
    }
  }
}

/** Never throws: a failing release (or a failing activity sink) must not fail the sweep. */
async function releaseStrayGatewaysOfSweep(
  agents: readonly BotContainerAgent[],
  deps: BotContainerRuntimeDeps,
): Promise<void> {
  if (!deps.releaseStrayGateways) return;
  const keep = new Set<string>();
  for (const agent of agents) {
    if (readBotContainerAgentConfig(agent.adapterType, agent.adapterConfig).ok && botKeyForAgent(agent.agentId)) {
      keep.add(agent.agentId);
    }
  }
  try {
    const { released, warnings } = await deps.releaseStrayGateways(keep);
    if (released > 0) {
      await deps.activity?.record({
        level: "info",
        agentId: "*",
        botKey: "*",
        message: "released board tool gateways of agents that are no longer reconciled",
        details: { released },
      });
    }
    if (warnings.length > 0) {
      await deps.activity?.record({
        level: "error",
        agentId: "*",
        botKey: "*",
        message: "releasing board tool gateways of agents that are no longer reconciled failed in part",
        details: { warnings },
      });
    }
  } catch (err) {
    try {
      await deps.activity?.record({
        level: "error",
        agentId: "*",
        botKey: "*",
        message: "releasing board tool gateways of agents that are no longer reconciled failed",
        details: { error: err instanceof Error ? err.message : String(err) },
      });
    } catch {
      // nothing left to report to
    }
  }
}

export const DEFAULT_RECONCILE_INTERVAL_MS = 60_000;

/**
 * How many bots a sweep reconciles concurrently. A single "restart"- or
 * drift-class reconcile can legitimately take minutes (maintenance drain timeout +
 * grace + the start's own health wait, see reconciler.ts / docker-driver.ts), so
 * one slow bot must not hold up every other bot's reconcile. Each bot is
 * independent (one container per agent) and serialized with itself through the
 * per-bot lock, so bounding concurrency only limits how many calls the Docker
 * socket sees at once, not correctness.
 */
const RECONCILE_CONCURRENCY = 4;

/** Runs `worker` over `items` with at most `limit` calls in flight at once,
 *  preserving no particular completion order. Workers are expected to swallow
 *  their own errors. */
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
 * fake driver/maintenance. Returns a stop function; a disabled flag returns a
 * no-op stop immediately and never calls `listAgents`. Stopping lets the bots
 * already being reconciled finish but starts no further ones.
 */
export function startBotContainerReconciliation(
  listAgents: () => Promise<BotContainerAgent[]>,
  deps: BotContainerRuntimeDeps,
  opts: { intervalMs?: number; env?: NodeJS.ProcessEnv } = {},
): () => void {
  if (!isBotContainersEnabled(opts.env)) return () => {};
  const intervalMs = opts.intervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;
  let stopped = false;

  // One sweep at a time: a slow sweep is still running when the next tick fires.
  // (Two reconciles of the same bot are excluded by the per-bot lock anyway; this
  // keeps a slow sweep from piling up queued ones.) Mirrors maintenanceService's
  // own tick() guard (server/src/myrmidon/maintenance/service.ts).
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
      // Only after a successful listing: a failed one must not read as "no agents", which would release every gateway.
      await releaseStrayGatewaysOfSweep(agents, deps);
      await runWithConcurrency(agents, RECONCILE_CONCURRENCY, async (agent) => {
        if (stopped) return;
        // reconcileBot (inside applyBotContainerNow) never throws; this catch only
        // guards the config-reading path around it.
        await applyBotContainerNow(agent, deps, { env: opts.env }).catch(() => undefined);
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
export { botKeyLock, createBotKeyLock } from "./bot-key-lock.js";
export type { BotKeyLock } from "./bot-key-lock.js";
export type { BotContainerDriver, BotContainerSpec, BotContainerStatus } from "./driver.js";
export type {
  BotContainerActivitySink,
  BotMaintenancePort,
  MaintenanceEnterResult,
  MaintenanceWindowView,
  ReconcileOutcome,
} from "./reconciler.js";
export { reconcileBot } from "./reconciler.js";
export { classifyProfileChange } from "./types.js";
export type { AppliedProfileState, CompiledProfile, CompiledProfileFile, ProfileChangeClass } from "./types.js";
export { dockerBotContainerDriver, readDockerDriverConfig } from "./docker-driver.js";
export { botProfileWiring } from "./profile-ports.js";
export { createActivityWarningSink, createBotProfileCompile } from "./profile-compile.js";
export type { BotProfileAgentRecord, BotProfilePorts, BotProfileCompileOptions } from "./profile-compile.js";
export { BOT_GATEWAY_PORT, createBotCardSync, gatewayApiBaseUrl, planGatewayCardSync } from "./card-sync.js";
export type { BotCardSyncPorts, BotCardSyncResult, GatewayCardPlan } from "./card-sync.js";
export { BOT_MCP_SERVERS_ENV, buildHermesProfileInput, readBotProfileSettings } from "./profile-input.js";
export type { BotMcpSource, BotProfileSettings, BotProfileSource, BotStaticMcpServer } from "./profile-input.js";
