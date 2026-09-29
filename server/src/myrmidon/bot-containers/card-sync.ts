// server/src/myrmidon/bot-containers/card-sync.ts
//
// myrmidon(W2a): once a bot's container exists and its profile is applied, point
// the agent card at it. The hermes_gateway adapter reaches a bot through
// `adapterConfig.apiBaseUrl` and authenticates with `adapterConfig.apiKey`
// (packages/adapters/hermes/src/gateway/index.ts), so for a card in container
// mode those fields are derived, not typed in by a person:
//
//   apiBaseUrl = http://myrmidon-bot-<botKey>:8642   (the container's name on the bot network)
//   apiKey     = secret_ref -> the company secret that holds the bot's API_SERVER_KEY
//                (the same secret profile-compile.ts writes into the bot's .env)
//
// myrmidon(H3), release 1.1.2: the adapter now trusts the fleet's own
// bot-container host names (`myrmidon-bot-<botKey>`) for plain http by itself
// (transport-security.ts `isBotContainerHostname`), so the sync no longer
// writes the `dangerouslyAllowInsecureRemoteHttp` escape hatch into the card.
// A leftover `true` from the previous wiring is removed on the next pass: the
// field belongs to the system in container mode, and a stale unsafe flag would
// outlive its purpose (it widened trust to ANY remote plain-http host while
// present). The traffic never leaves the docker network of the bots
// (MYRMIDON_BOT_NETWORK): it is the board server talking to its own container
// on the same host, so plain http there is the intended transport.
//
// The key is a secret_ref, never plaintext: the adapter's `apiKey` is a schema
// secret field, resolved when a run starts, and the agent update path binds the
// secret to the agent (syncAgentSecretBindings) so that resolution is allowed.
//
// The sync is idempotent and write-on-difference: it runs after every successful
// reconcile pass (once a minute per bot), so a card that already matches costs one
// read and no write, and never produces a config revision.

import type { BotProfileAgentRecord, BotProfilePorts } from "./profile-compile.js";
import { containerNameFor } from "./template.js";

/**
 * The adapter's config key that allows plain http to a non-loopback host
 * (transport-security.ts `allowsInsecureRemoteHttp`). Kept as a literal here so
 * this module does not import the adapter package. myrmidon(H3): only read to
 * strip a leftover from the pre-H3 wiring; never written anymore.
 */
const INSECURE_REMOTE_HTTP_KEY = "dangerouslyAllowInsecureRemoteHttp";

/** The port Hermes' API server listens on inside a bot container (the image's default). */
export const BOT_GATEWAY_PORT = 8642;

export function gatewayApiBaseUrl(botKey: string): string {
  return `http://${containerNameFor(botKey)}:${BOT_GATEWAY_PORT}`;
}

export interface GatewayCardPlan {
  changed: boolean;
  /** The card to store: the input with the changed fields replaced, all others untouched. */
  adapterConfig: Record<string, unknown>;
  /** Which of `apiBaseUrl` / `apiKey` / the stripped insecure-http flag differ from what the container needs. */
  changedKeys: string[];
}

function isMatchingSecretRef(value: unknown, secretId: string): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  return ref.type === "secret_ref" && ref.secretId === secretId && ref.version === "latest";
}

/**
 * Pure: what the card's gateway connection fields must become. A stored
 * secret_ref keeps its extra fields (projectionClass and the like) when it
 * already points at the right secret with version "latest"; anything else —
 * a plain string typed by a person, a ref to another secret, a pinned version —
 * is replaced, because in container mode the key is the container's.
 * myrmidon(H3): a leftover insecure-http flag from the pre-H3 wiring is
 * deleted (the adapter's own bot-container trust replaced it); nothing is
 * written in its place.
 */
export function planGatewayCardSync(
  adapterConfig: Record<string, unknown>,
  target: { botKey: string; apiKeySecretId: string },
): GatewayCardPlan {
  const next: Record<string, unknown> = { ...adapterConfig };
  const changedKeys: string[] = [];

  const apiBaseUrl = gatewayApiBaseUrl(target.botKey);
  if (adapterConfig.apiBaseUrl !== apiBaseUrl) {
    next.apiBaseUrl = apiBaseUrl;
    changedKeys.push("apiBaseUrl");
  }
  if (!isMatchingSecretRef(adapterConfig.apiKey, target.apiKeySecretId)) {
    next.apiKey = { type: "secret_ref", secretId: target.apiKeySecretId, version: "latest" };
    changedKeys.push("apiKey");
  }
  // myrmidon(H3): strip the escape hatch the pre-H3 sync used to write; the
  // adapter trusts myrmidon-bot-* host names on its own now.
  if (INSECURE_REMOTE_HTTP_KEY in adapterConfig) {
    delete next[INSECURE_REMOTE_HTTP_KEY];
    changedKeys.push(INSECURE_REMOTE_HTTP_KEY);
  }
  return { changed: changedKeys.length > 0, adapterConfig: next, changedKeys };
}

export interface BotCardSyncPorts {
  /** Fresh read, so the write below starts from the card as it is now. */
  loadAgent: BotProfilePorts["loadAgent"];
  /** Get-or-create: the same secret the profile compiler put into the bot's .env. */
  ensureApiServerKey: BotProfilePorts["ensureApiServerKey"];
  /** Stores the whole adapterConfig for the agent (agentService.update in profile-ports.ts). */
  saveAdapterConfig(agent: BotProfileAgentRecord, adapterConfig: Record<string, unknown>): Promise<void>;
}

export interface BotCardSyncResult {
  changedKeys: string[];
}

/**
 * Returns the function to put into `BotContainerRuntimeDeps.syncCard`. Throws on
 * a failed read/write; the caller (index.ts) records that and keeps the
 * reconcile outcome, since the container itself is fine.
 */
export function createBotCardSync(
  ports: BotCardSyncPorts,
): (agentId: string, botKey: string) => Promise<BotCardSyncResult> {
  return async function syncCard(agentId: string, botKey: string): Promise<BotCardSyncResult> {
    const agent = await ports.loadAgent(agentId);
    if (!agent) return { changedKeys: [] };
    const key = await ports.ensureApiServerKey(agent);
    const plan = planGatewayCardSync(agent.adapterConfig ?? {}, { botKey, apiKeySecretId: key.secretId });
    if (!plan.changed) return { changedKeys: [] };
    await ports.saveAdapterConfig(agent, plan.adapterConfig);
    return { changedKeys: plan.changedKeys };
  };
}
