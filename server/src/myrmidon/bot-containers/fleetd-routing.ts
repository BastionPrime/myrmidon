// server/src/myrmidon/bot-containers/fleetd-routing.ts
//
// myrmidon(FLEETD-VMEXEC): one BotContainerDriver in front of many hosts. The
// reconciler (reconciler.ts) and "apply now" (index.ts) keep their single
// `deps.driver` field; this driver routes each call by the bot's host, taken
// from the agent's card (adapterConfig.container.host, cardFleetHost):
//   - default host (no name): the local driver, exactly as before;
//   - a named host: that host's fleetd client.
//
// The host map is resolved per call from the sweep's agent record, so a card
// edit moves a bot on the next tick without a restart. The fleet clients are
// built once per host (their token is resolved by the wiring, not here).
//
// Error discipline: a card naming a host that is not in the map throws — an
// unknown host must surface as a reconcile error, never fall back to the
// local driver (a bot would silently run on the wrong machine).

import { cardFleetHost, type FleetHostConfig } from "./fleetd-hosts.js";
import type { BotContainerDriver, BotContainerSpec, BotContainerStatus } from "./driver.js";
import type { CompiledProfile } from "./types.js";

export interface FleetRoutingDeps {
  /** The local docker driver (default host). */
  local: BotContainerDriver;
  /** A fleetd client per configured host name. */
  fleet: ReadonlyMap<string, BotContainerDriver>;
}

/** The per-bot agent record the routing needs: the container block of the card. */
export interface RoutedBotAgent {
  adapterConfig: { container?: unknown };
}

function driverFor(
  deps: FleetRoutingDeps,
  agent: RoutedBotAgent | undefined,
): BotContainerDriver {
  const host = agent ? cardFleetHost(agent.adapterConfig) : null;
  if (host === null) return deps.local;
  const driver = deps.fleet.get(host);
  if (!driver) {
    throw new Error(
      `container.host "${host}" names no configured fleet host (check MYRMIDON_FLEET_HOSTS)`,
    );
  }
  return driver;
}

/** A driver whose every call is routed by the bot's card host. */
export function fleetRoutingDriver(
  deps: FleetRoutingDeps,
  agentOf: (botKey: string) => RoutedBotAgent | undefined,
): BotContainerDriver {
  return {
    async status(botKey: string): Promise<BotContainerStatus> {
      return driverFor(deps, agentOf(botKey)).status(botKey);
    },
    async list(): Promise<BotContainerStatus[]> {
      // A routed list is the union of all hosts' own lists.
      const results = await Promise.all(
        [deps.local, ...deps.fleet.values()].map((driver) => driver.list()),
      );
      return results.flat();
    },
    async templateDrift(spec: BotContainerSpec): Promise<boolean> {
      return driverFor(deps, agentOf(spec.botKey)).templateDrift(spec);
    },
    async create(spec: BotContainerSpec): Promise<void> {
      await driverFor(deps, agentOf(spec.botKey)).create(spec);
    },
    async recreate(spec: BotContainerSpec): Promise<void> {
      await driverFor(deps, agentOf(spec.botKey)).recreate(spec);
    },
    async writeProfile(botKey: string, profile: CompiledProfile): Promise<void> {
      await driverFor(deps, agentOf(botKey)).writeProfile(botKey, profile);
    },
    async start(botKey: string): Promise<void> {
      await driverFor(deps, agentOf(botKey)).start(botKey);
    },
    async restart(botKey: string): Promise<void> {
      await driverFor(deps, agentOf(botKey)).restart(botKey);
    },
    async stop(botKey: string): Promise<void> {
      await driverFor(deps, agentOf(botKey)).stop(botKey);
    },
  };
}
