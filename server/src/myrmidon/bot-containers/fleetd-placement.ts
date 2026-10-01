// server/src/myrmidon/bot-containers/fleetd-placement.ts
//
// myrmidon(FLEETD-VMEXEC): what a bot's placement on a named fleet host changes
// about the instance-wide bot container settings. The instance-wide settings
// (MYRMIDON_BOT_HINDSIGHT_API_URL, MYRMIDON_BOT_LLM_BASE_URL, MYRMIDON_BOT_VOLUME_ROOT,
// MYRMIDON_BOT_NETWORK, MYRMIDON_BOT_IMAGE_ALLOWLIST, and the name the bot resolves
// the board by) describe the machine the BOARD runs on. A bot living on another
// machine reaches a different address for each of them, so the bot cannot share
// those values: `hindsight` and the LLM gateway live on the board's host, while the
// volume root and the bot network are local to the bot's host.
//
// Everything here is pure: it resolves the effective settings for one bot from its
// host entry (fleetd-hosts.ts) over the instance-wide values, and nothing else. The
// startup wiring applies the result; the tests cover the shapes directly, without a
// Docker socket or a database.

import type { FleetHostConfig } from "./fleetd-hosts.js";

/** The instance-wide bot container settings a host entry may override. */
export interface InstanceBotSettings {
  /** Base URL bots use to reach the central hindsight service. */
  hindsightUrl: string;
  /** Base URL bots use to reach the LLM gateway. */
  llmBaseUrl: string;
  /** Directory bot volumes live under ON THE MACHINE THE BOT RUNS ON. */
  volumeRoot: string;
  /** Docker network the bot's container joins on its own machine. */
  network: string;
  /** Image allowlist (globs) its driver enforces. */
  imageAllowlist: readonly string[];
  /** Name a bot container resolves the board by (docker `--add-host` target),
   *  i.e. the hostname the board's own allowlist accepts. */
  boardHost: string;
}

/** The settings a bot actually gets, after its host's overrides. */
export type EffectiveBotSettings = InstanceBotSettings;

/**
 * Applies `host`'s overrides over the instance-wide values. A field the entry
 * does not carry keeps the instance-wide value, so an entry only states what
 * differs on its machine. `null`/`undefined` host (the default, local host)
 * returns the instance-wide settings untouched — a single-machine deployment
 * behaves exactly as before this feature existed.
 */
export function effectiveBotSettings(
  instanceWide: InstanceBotSettings,
  host: FleetHostConfig | null | undefined,
): EffectiveBotSettings {
  if (!host) return instanceWide;
  return {
    hindsightUrl: host.hindsightUrl ?? instanceWide.hindsightUrl,
    llmBaseUrl: host.llmBaseUrl ?? instanceWide.llmBaseUrl,
    volumeRoot: host.volumeRoot ?? instanceWide.volumeRoot,
    network: host.network ?? instanceWide.network,
    imageAllowlist: host.imageAllowlist ?? instanceWide.imageAllowlist,
    boardHost: host.boardExtraHost ?? instanceWide.boardHost,
  };
}

/**
 * The base URL the BOARD uses to reach a bot gateway on a fleet host:
 * `http://<fleetd-host>:<published-port>`. The host part comes from the fleetd
 * entry's own URL (the board already reaches that machine there), and the port is
 * the one the host's fleetd published for this bot — reported per bot in
 * `BotContainerStatus.gatewayPort`, because only fleetd knows which port it
 * allocated. A missing port is an error, never a guessed default: pointing the
 * card at the wrong port would silently break the bot's runs.
 */
export function fleetGatewayApiBaseUrl(fleetdUrl: string, gatewayPort: number | undefined): string {
  if (gatewayPort === undefined) {
    throw new Error("fleetd did not report a gateway port for this bot; the card cannot be pointed at it");
  }
  if (!Number.isInteger(gatewayPort) || gatewayPort <= 0 || gatewayPort > 65535) {
    throw new Error(`fleetd reported an invalid gateway port: ${JSON.stringify(gatewayPort)}`);
  }
  const url = new URL(fleetdUrl);
  if (url.protocol !== "http:") {
    throw new Error(`fleetd url must be http:// (got ${url.protocol}//)`);
  }
  return `http://${url.hostname}:${gatewayPort}`;
}