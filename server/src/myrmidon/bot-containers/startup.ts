// server/src/myrmidon/bot-containers/startup.ts
//
// myrmidon(W2a): startup wiring of the bot container reconciler. server/src/index.ts
// has one marked call, `startBotContainers(db)`, next to startMaintenanceMode, and
// one at shutdown, `stopBotContainers()`; everything else lives here.
//
// With MYRMIDON_BOT_CONTAINERS off (the default) `startBotContainers` returns
// before it creates or reads anything: no Docker driver, no query, no timer, no
// registered runtime. With it on it builds the runtime once
//  - the Docker driver (G3) over the socket `MYRMIDON_BOT_DOCKER_SOCKET`
//    (default /var/run/docker.sock), volumes and network from the G3 settings;
//  - the profile compiler and the card sync (W2a, profile-ports.ts);
//  - the maintenance port (R3);
// then starts the periodic sweep (`MYRMIDON_BOT_RECONCILE_INTERVAL_SEC`, default
// 60) over the agents `listBotContainerAgents` returns, and registers the same
// runtime for the card's "Apply now" (W2b, routes-wiring.ts), which answers 503
// until a runtime is registered.
//
// A runtime that cannot be built (for example MYRMIDON_BOT_VOLUME_ROOT unset)
// is logged as an error and nothing is started or registered: the board keeps
// serving, the containers stay as they are, and the card reports the runtime as
// not configured. That is deliberate: a bot-container settings mistake must not
// stop the whole board.

import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { listBotContainerAgents } from "./agents-query.js";
import { isBotContainersEnabled } from "./agent-config.js";
import type { BotContainerDriver } from "./driver.js";
import { dockerBotContainerDriver, readDockerDriverConfig, type DockerDriverConfig } from "./docker-driver.js";
import {
  DEFAULT_RECONCILE_INTERVAL_MS,
  realBotMaintenancePort,
  startBotContainerReconciliation,
  type BotContainerAgent,
  type BotContainerRuntimeDeps,
} from "./index.js";
import { botProfileWiring } from "./profile-ports.js";
import type { BotContainerActivitySink, BotMaintenancePort } from "./reconciler.js";
import { getBotContainerRuntime, setBotContainerRuntime } from "./routes-wiring.js";

export const BOT_RECONCILE_INTERVAL_ENV = "MYRMIDON_BOT_RECONCILE_INTERVAL_SEC";
const MIN_RECONCILE_INTERVAL_SEC = 5;
const MAX_RECONCILE_INTERVAL_SEC = 3600;

/** The sweep period. An unset, non-integer or out-of-range value falls back to the
 *  default (the same rule as the maintenance settings, R3). */
export function readBotReconcileIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[BOT_RECONCILE_INTERVAL_ENV]?.trim();
  if (!raw) return DEFAULT_RECONCILE_INTERVAL_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < MIN_RECONCILE_INTERVAL_SEC || value > MAX_RECONCILE_INTERVAL_SEC) {
    return DEFAULT_RECONCILE_INTERVAL_MS;
  }
  return value * 1000;
}

/** The two server-log calls this module makes (the pino logger satisfies it). */
export interface BotContainersLog {
  info(fields: object, message: string): void;
  error(fields: object, message: string): void;
}

/** Reconciler events go to the server log: an error at `error`, the rest at `info`. */
export function createBotContainerLogSink(log: BotContainersLog = logger): BotContainerActivitySink {
  return {
    record(entry) {
      const fields = { agentId: entry.agentId, botKey: entry.botKey, ...(entry.details ? { details: entry.details } : {}) };
      if (entry.level === "error") log.error(fields, `bot containers: ${entry.message}`);
      else log.info(fields, `bot containers: ${entry.message}`);
    },
  };
}

/** What `startBotContainers` builds its runtime from; tests replace these. */
export interface BotContainersStartupPorts {
  readDriverConfig(env: NodeJS.ProcessEnv): DockerDriverConfig;
  createDriver(config: DockerDriverConfig): BotContainerDriver;
  profileWiring(
    db: Db,
    opts: { activity: BotContainerActivitySink; env: NodeJS.ProcessEnv },
  ): Pick<BotContainerRuntimeDeps, "compile" | "syncCard">;
  maintenancePort(db: Db): BotMaintenancePort;
  listAgents(db: Db): () => Promise<BotContainerAgent[]>;
  activitySink(): BotContainerActivitySink;
  registerRuntime(runtime: BotContainerRuntimeDeps | null): void;
  currentRuntime(): BotContainerRuntimeDeps | null;
  startReconciliation: typeof startBotContainerReconciliation;
  log: BotContainersLog;
}

const defaultPorts: BotContainersStartupPorts = {
  readDriverConfig: (env) => readDockerDriverConfig(env),
  createDriver: (config) => dockerBotContainerDriver(config),
  profileWiring: (db, opts) => botProfileWiring(db, opts),
  maintenancePort: (db) => realBotMaintenancePort(db),
  listAgents: (db) => listBotContainerAgents(db),
  activitySink: () => createBotContainerLogSink(),
  registerRuntime: setBotContainerRuntime,
  currentRuntime: getBotContainerRuntime,
  startReconciliation: startBotContainerReconciliation,
  log: logger,
};

let stopRunning: (() => void) | null = null;

/**
 * Builds the runtime and starts the periodic sweep, once; see the module comment.
 * Returns the stop function (also reachable through `stopBotContainers`). Never
 * throws: a runtime that cannot be built is logged and nothing is started. A
 * repeated call replaces the previous run.
 */
export function startBotContainers(
  db: Db,
  opts: { env?: NodeJS.ProcessEnv; ports?: Partial<BotContainersStartupPorts> } = {},
): () => void {
  const env = opts.env ?? process.env;
  if (!isBotContainersEnabled(env)) return () => {};
  const ports: BotContainersStartupPorts = { ...defaultPorts, ...opts.ports };
  stopBotContainers();

  const intervalMs = readBotReconcileIntervalMs(env);
  const started = build(db, env, intervalMs, ports);
  if (!started) return () => {};
  const { runtime, stopSweep } = started;
  ports.registerRuntime(runtime);
  ports.log.info({ intervalMs, network: runtime.network }, "bot container reconciliation started");

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    stopSweep();
    // Only clear the registry entry this run put there.
    if (ports.currentRuntime() === runtime) ports.registerRuntime(null);
    if (stopRunning === stop) stopRunning = null;
  };
  stopRunning = stop;
  return stop;
}

/** Builds the runtime and starts the sweep over it; null (after logging) when that fails. */
function build(
  db: Db,
  env: NodeJS.ProcessEnv,
  intervalMs: number,
  ports: BotContainersStartupPorts,
): { runtime: BotContainerRuntimeDeps; stopSweep: () => void } | null {
  try {
    const driverConfig = ports.readDriverConfig(env);
    const activity = ports.activitySink();
    const { compile, syncCard } = ports.profileWiring(db, { activity, env });
    const runtime: BotContainerRuntimeDeps = {
      driver: ports.createDriver(driverConfig),
      compile,
      syncCard,
      maintenance: ports.maintenancePort(db),
      activity,
      network: driverConfig.network,
    };
    const stopSweep = ports.startReconciliation(ports.listAgents(db), runtime, { intervalMs, env });
    return { runtime, stopSweep };
  } catch (err) {
    ports.log.error({ err }, "bot containers are enabled but the runtime could not be built; reconciliation is not started");
    return null;
  }
}

/** Stops the sweep started by `startBotContainers` (server shutdown); a no-op when none is running. */
export function stopBotContainers(): void {
  stopRunning?.();
}
