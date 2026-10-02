// server/src/myrmidon/bot-containers/egress.ts
//
// myrmidon(EGRESS-A): the bot's way off its own docker network. The plan's
// release 1.3 item 4 (plan §2.5, "1.3 Изоляция и самообслуживание флота") takes
// the bots off direct egress and routes everything they send outward through a
// proxy of the fleet, first in log-only mode: nothing is refused, every
// destination is recorded (docs/myrmidon/egress.md, `update-plan`).
//
// Two halves make that work, and this file owns the first one:
//   - the *network* half — the bots' docker network has no route out (docker
//     `internal`), so a container that ignores the proxy simply has nowhere to
//     go. That is a host/deploy fact, not code (the network is created outside
//     this repository, the same way `MYRMIDON_BOT_NETWORK` already is);
//   - the *setting* half — this module: which mode is on, which proxy address
//     the bot is told to use, and the lines that carry both into the compiled
//     profile's `hermes/.env`.
//
// Nothing here blocks anything, in either mode. Mode `log` is not "the blocking
// mode done gently": a destination the proxy does not know still passes, and a
// bot that ignores the proxy environment is missing from the journal rather
// than stopped. Enforcing a destination list is EGRESS-B (release 1.3 item 5).
//
// The proxy itself is a fleet service with its own image (tools/egress-proxy),
// deployed next to the other bot sidecars (tools/media-mcp, tools/cloud-files):
// it sits on the bots' network and on a second, outward-facing one, and it is
// the only thing with both.

import { BotProfileInputError } from "./profile-input.js";
import type { HermesProfileEnvEntry } from "./profile-compiler.js";

export const BOT_EGRESS_MODE_ENV = "MYRMIDON_BOT_EGRESS_MODE";
export const BOT_EGRESS_PROXY_ENV = "MYRMIDON_BOT_EGRESS_PROXY";
export const BOT_EGRESS_NO_PROXY_ENV = "MYRMIDON_BOT_EGRESS_NO_PROXY";

/**
 * `off` (default) is the behaviour the fleet has today: the bot gets no proxy
 * variables at all and the journal stays empty. `log` points every bot at the
 * proxy; the proxy records destinations and refuses none.
 *
 * There is deliberately no `block` here yet: it is EGRESS-B's job, together
 * with the per-project and per-bot lists that make blocking safe (the plan's
 * risk note: without an inventory of the real destinations, blocking breaks the
 * fleet's work).
 */
export type BotEgressMode = "off" | "log";

export interface BotEgressSettings {
  mode: BotEgressMode;
  /** Proxy as the bot reaches it, without credentials, e.g. `http://myrmidon-egress:3128`. */
  proxyUrl: string | null;
  /** Hosts the instance adds to NO_PROXY on top of the built-in ones. */
  extraNoProxy: string[];
}

/** Fixed password part of the proxy URL. Log-only mode never checks it: it only
 *  makes the URL well-formed for clients that reject a userinfo without one.
 *  The *user* is what the proxy reads (the bot's own key) — that is how a
 *  destination is attributed to a bot in the journal. */
const PROXY_URL_PASSWORD = "egress";

/** Non-glob hosts every bot must reach directly: its own loopback is not the
 *  host's, and a request to it never leaves the container. */
const BUILTIN_NO_PROXY_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "::1"];

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Reads the instance settings. An unknown mode throws rather than falling back
 * to `off`: a typo in a variable meant to close the bots' egress must not look
 * like an instance that deliberately left it open (the profile settings
 * reader fails the same way, and for the same reason).
 */
export function readBotEgressSettings(env: NodeJS.ProcessEnv = process.env): BotEgressSettings {
  const rawMode = nonEmpty(env[BOT_EGRESS_MODE_ENV]);
  let mode: BotEgressMode = "off";
  if (rawMode !== null) {
    const normalized = rawMode.toLowerCase();
    if (normalized !== "off" && normalized !== "log") {
      throw new BotProfileInputError(`${BOT_EGRESS_MODE_ENV} must be "off" or "log", got "${rawMode}"`);
    }
    mode = normalized;
  }
  return {
    mode,
    proxyUrl: nonEmpty(env[BOT_EGRESS_PROXY_ENV]),
    extraNoProxy: (nonEmpty(env[BOT_EGRESS_NO_PROXY_ENV]) ?? "")
      .split(",")
      .map((host) => host.trim())
      .filter((host) => host.length > 0),
  };
}

/** The host the bot uses for the board (`MYRMIDON_BOT_BOARD_URL`), when it parses. */
export function boardUrlHost(boardUrl: string | null | undefined): string | null {
  const trimmed = nonEmpty(boardUrl ?? undefined);
  if (trimmed === null) return null;
  try {
    return new URL(trimmed).hostname || null;
  } catch {
    return null;
  }
}

/**
 * Fails when `log` is on but the instance names no proxy: the profile would
 * then carry an empty proxy address, and every bot would quietly go on reaching
 * outward directly — exactly what this item is about. Called with the rest of
 * the bot container settings, before any lookup or secret creation, so a
 * misconfigured instance leaves nothing behind (same slot as
 * `assertBotProfileSettings`).
 */
export function assertBotEgressSettings(settings: BotEgressSettings): void {
  if (settings.mode === "off") return;
  if (settings.proxyUrl === null) {
    throw new BotProfileInputError(
      `${BOT_EGRESS_MODE_ENV} is "${settings.mode}": ${BOT_EGRESS_PROXY_ENV} must be set to the egress proxy the container reaches`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(settings.proxyUrl);
  } catch {
    throw new BotProfileInputError(`${BOT_EGRESS_PROXY_ENV} is not a URL: "${settings.proxyUrl}"`);
  }
  if (parsed.protocol !== "http:") {
    throw new BotProfileInputError(
      `${BOT_EGRESS_PROXY_ENV} must be an http:// address (the proxy speaks plain HTTP and tunnels TLS with CONNECT), got "${parsed.protocol}"`,
    );
  }
}

/**
 * The proxy address a single bot is told to use: the instance's proxy with the
 * bot's own key as the userinfo user, so the proxy can name the bot in its
 * journal on every request (`http://<botKey>:egress@myrmidon-egress:3128`).
 * The key is a DNS label (validated by the driver), so it needs no escaping.
 */
export function botEgressProxyUrl(settings: BotEgressSettings, botKey: string): string {
  if (settings.mode === "off" || settings.proxyUrl === null) return "";
  const url = new URL(settings.proxyUrl);
  url.username = botKey;
  url.password = PROXY_URL_PASSWORD;
  return url.toString();
}

/**
 * NO_PROXY for one bot: loopback, the board as the bot reaches it, and whatever
 * the instance adds. The board's own address is on the bots' network too, and
 * is the one destination every bot uses constantly — routing it through a proxy
 * would add a hop to every board call for no journal value.
 *
 * Peer bots, the media service and the other sidecars of the bot network are
 * *not* excluded: seeing them in the journal is part of the inventory this mode
 * exists to produce.
 */
export function botEgressNoProxy(settings: BotEgressSettings, boardUrl: string | null | undefined): string[] {
  const hosts = [...BUILTIN_NO_PROXY_HOSTS];
  const boardHost = boardUrlHost(boardUrl);
  if (boardHost !== null) hosts.push(boardHost);
  hosts.push(...settings.extraNoProxy);
  return [...new Set(hosts)];
}

/**
 * The `hermes/.env` entries that put one bot behind the proxy — empty in mode
 * `off`, which is what makes the whole feature invisible until an operator
 * turns it on.
 *
 * `NODE_USE_ENV_PROXY` is set so the bot's Node tooling (`/opt/node-tools` in
 * the bot image) honours the same variables: Node's `fetch` ignores
 * HTTP_PROXY/HTTPS_PROXY without it, and that traffic would otherwise be the
 * one part of a bot's egress missing from the journal. The Python gateway
 * (hermes-agent) and the ordinary Unix tools read the variables by themselves.
 */
export function buildBotEgressEnvEntries(params: {
  settings: BotEgressSettings;
  botKey: string;
  boardUrl: string | null | undefined;
}): Record<string, HermesProfileEnvEntry> {
  const { settings, botKey, boardUrl } = params;
  if (settings.mode === "off") return {};
  const proxyUrl = botEgressProxyUrl(settings, botKey);
  const noProxy = botEgressNoProxy(settings, boardUrl).join(",");
  const value = (text: string): HermesProfileEnvEntry => ({ value: text, secret: false });
  return {
    HTTP_PROXY: value(proxyUrl),
    HTTPS_PROXY: value(proxyUrl),
    ALL_PROXY: value(proxyUrl),
    NO_PROXY: value(noProxy),
    NODE_USE_ENV_PROXY: value("1"),
  };
}