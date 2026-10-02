import { z } from "zod";

/**
 * Gateway key and fallback-topology policy for the LLM gateway (myrmidon M2-B).
 *
 * M2-A reads what the gateway already spent and attributes it to an agent by
 * hashing that agent's gateway key. This module is the other half:
 *
 * 1. The NAME of the secret that carries one agent's gateway key. A card's
 *    gateway key lives in the company secret store under a name derived from
 *    the agent, so the store — not one environment variable shared by the whole
 *    company — hands out credentials. Two agents can never collide on one
 *    secret, and rotating one agent's key cannot touch another's.
 *
 * 2. Fallback-chain cycle detection, for the two shapes a chain is saved in:
 *    the agent card's own list, and the gateway's router topology (a graph of
 *    one-entry groups).
 *
 * Everything here is pure, so the server, the compiler and the tests read one
 * source of truth. No addresses, model names of a live instance or key values
 * live in this file.
 */

// ---------------------------------------------------------------------------
// Per-agent gateway keys
// ---------------------------------------------------------------------------

/** Environment variable naming the secret that carries the gateway ADMIN key.
 *
 * The admin key may create and rotate virtual keys; it is never handed to an
 * agent. Unset (the default) means the board cannot manage gateway keys, and
 * the key endpoints answer "not enabled" instead of failing. */
export const GATEWAY_ADMIN_KEY_SECRET_ENV = "MYRMIDON_LITELLM_ADMIN_KEY_SECRET";

/** Environment variable naming the LLM gateway endpoint the board talks to.
 * Shared with M2-A: a base URL is not a secret. */
export const GATEWAY_BASE_URL_ENV = "MYRMIDON_LITELLM_BASE_URL";

/** Environment variable naming the env variable a per-agent key is projected
 * into inside a bot profile (`llm.apiKeyEnv` of the compiled profile). When it
 * is set, the compiler binds the agent's own secret to that name, so the bot
 * authenticates with its own key and its spend lands under that key. */
export const GATEWAY_KEY_ENV_NAME_ENV = "MYRMIDON_LITELLM_AGENT_KEY_ENV";

/** Prefix of a per-agent gateway key name in the secret store. */
export const AGENT_KEY_SECRET_PREFIX = "llm-gateway-key-";

/** Characters an agent name may leave in a secret name. */
const SECRET_NAME_UNSAFE = /[^a-z0-9._-]+/g;

/**
 * The secret name that carries one agent's gateway key.
 *
 * Derived from the agent ID, not its display name: a display name is editable
 * and need not be unique, so a rename would orphan the key and two agents could
 * share one secret. The id is stable and unique within a company. Falls back to
 * the id alone when no slug can be built, so the function is total.
 */
export function agentKeySecretName(input: { agentId: string; agentSlug?: string | null }): string {
  const slug = (input.agentSlug ?? "")
    .trim()
    .toLowerCase()
    .replace(SECRET_NAME_UNSAFE, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const id = input.agentId.trim().toLowerCase().replace(SECRET_NAME_UNSAFE, "-");
  return `${AGENT_KEY_SECRET_PREFIX}${slug ? `${slug}-` : ""}${id}`;
}

/** Whether a secret name is one this feature manages. */
export function isAgentKeySecretName(name: string): boolean {
  return name.startsWith(AGENT_KEY_SECRET_PREFIX);
}

/** What the instance says about gateway key management. */
export interface GatewayKeySettings {
  /** True when the board may manage virtual keys (both a base URL and an admin key secret are named). */
  canManageKeys: boolean;
  /** The secret-store name of the admin key; null when unset. */
  adminKeySecret: string | null;
  /** The gateway endpoint; null when unset. */
  baseUrl: string | null;
  /** The env variable a per-agent key is projected into; null when unset or invalid. */
  agentKeyEnv: string | null;
}

/** Environment variable names a per-agent key may not be projected into. */
export const GATEWAY_KEY_RESERVED_ENV_NAMES: readonly string[] = [
  "HOME",
  "PATH",
  "HERMES_HOME",
  "API_SERVER_KEY",
  "PAPERCLIP_API_URL",
  "PAPERCLIP_API_KEY",
];

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Reads the settings from an environment. Nothing throws: an invalid
 * `MYRMIDON_LITELLM_AGENT_KEY_ENV` reads as "not set" rather than silently
 * projecting a key into a variable the image owns.
 *
 * The environment is a parameter, never `process.env` read here: this module is
 * imported by plugin examples that typecheck without Node types.
 */
export function readGatewayKeySettings(env: Record<string, string | undefined>): GatewayKeySettings {
  const adminKeySecret = env[GATEWAY_ADMIN_KEY_SECRET_ENV]?.trim() || null;
  const baseUrl = env[GATEWAY_BASE_URL_ENV]?.trim() || null;
  const rawEnv = env[GATEWAY_KEY_ENV_NAME_ENV]?.trim() || null;
  const agentKeyEnv =
    rawEnv && ENV_NAME_PATTERN.test(rawEnv) && !GATEWAY_KEY_RESERVED_ENV_NAMES.includes(rawEnv)
      ? rawEnv
      : null;
  return {
    canManageKeys: Boolean(adminKeySecret && baseUrl),
    adminKeySecret,
    baseUrl,
    agentKeyEnv,
  };
}

// ---------------------------------------------------------------------------
// Fallback chains
// ---------------------------------------------------------------------------

/** Names that mean "let the adapter decide"; never part of a cycle. */
export const SPECIAL_MODEL_VALUES: readonly string[] = ["default", "auto"];

/** One loop: the models that form it, in walk order. */
export interface FallbackCycle {
  /** The loop's members, first occurrence to the one that closes it. */
  path: string[];
}

function normalizeModelName(name: string | null | undefined): string | null {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return null;
  if (SPECIAL_MODEL_VALUES.includes(trimmed.toLowerCase())) return null;
  return trimmed;
}

/**
 * A loop in a card's own fallback chain.
 *
 * The card's chain is an ordered list: the bot tries the primary model, then
 * the entries in order, and stops at the first that answers. The only loop such
 * a list can express is a repeat — the chain names the primary model, or names
 * the same model twice. Both are worth rejecting: a fallback equal to the
 * primary model retries the request that just failed, and a duplicate spends a
 * second budget slot on a model already tried. `path` is the segment from the
 * first occurrence to the repeat, inclusive, which is what a message should
 * show.
 */
export function findCardFallbackCycle(input: {
  primaryModel?: string | null;
  fallbacks?: readonly string[] | null;
}): FallbackCycle | null {
  const sequence: string[] = [];
  const primary = normalizeModelName(input.primaryModel);
  if (primary) sequence.push(primary);
  for (const entry of input.fallbacks ?? []) {
    const model = normalizeModelName(entry);
    if (model) sequence.push(model);
  }
  const first = new Map<string, number>();
  for (let index = 0; index < sequence.length; index += 1) {
    const model = sequence[index]!;
    const seenAt = first.get(model);
    if (seenAt !== undefined) return { path: sequence.slice(seenAt, index + 1) };
    first.set(model, index);
  }
  return null;
}

/** One model group the gateway routes: the group and its ordered fallback targets. */
export interface FallbackChain {
  model: string;
  targets: readonly string[];
}

/**
 * Every loop in a fallback TOPOLOGY, as the gateway stores it.
 *
 * The topology is a list of one-entry groups, i.e. a directed graph, and a loop
 * in it is not always a self-loop: a deployed topology can hold `a -> b` and
 * `b -> c -> a`, and the gateway does not reject that when the topology is
 * written. The walk below reports every loop once, keyed by its members, so a
 * caller can show a stable list; `path` is one rotation of the loop.
 *
 * Iterative depth-first search with an explicit stack: a target may be a model
 * that is not a group itself (a leaf), and an unbounded hand-written recursion
 * is not worth rediscovering.
 */
export function findFallbackTopologyCycles(chains: readonly FallbackChain[]): FallbackCycle[] {
  const edges = new Map<string, string[]>();
  for (const chain of chains) {
    const model = normalizeModelName(chain.model);
    if (!model) continue;
    const targets = (edges.get(model) ?? []).slice();
    for (const target of chain.targets) {
      const normalized = normalizeModelName(target);
      if (normalized) targets.push(normalized);
    }
    edges.set(model, targets);
  }

  const cycles = new Map<string, FallbackCycle>();
  for (const start of edges.keys()) {
    const stack: Array<{ model: string; path: string[] }> = [{ model: start, path: [start] }];
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const next of edges.get(current.model) ?? []) {
        if (next === start) {
          const key = [...current.path].sort().join("\u0000");
          if (!cycles.has(key)) cycles.set(key, { path: [...current.path] });
          continue;
        }
        // A loop reachable through another entry point is reported from there,
        // and a target below "start" is reported from its own smallest member.
        if (current.path.includes(next) || next < start) continue;
        stack.push({ model: next, path: [...current.path, next] });
      }
    }
  }
  return [...cycles.values()];
}

/** Renders a loop the way a rejection message should read: `a -> b -> a`. */
export function describeFallbackCycle(cycle: FallbackCycle): string {
  const path = cycle.path;
  return [...path, path[0]].join(" -> ");
}

/** The gateway's router settings as stored: one entry per group. */
export const fallbackTopologySchema = z.array(z.record(z.string(), z.array(z.string())));

/**
 * Reads the gateway's stored `router_settings.fallbacks` payload.
 *
 * The gateway accepts the list as-is, so a hand-edited overlay can carry a
 * shape the router ignores. Returns null for anything that is not a list of
 * single-entry `{group: [targets]}` objects, so a caller reports "unreadable
 * topology" instead of silently checking nothing.
 */
export function parseFallbackTopology(payload: unknown): FallbackChain[] | null {
  const parsed = fallbackTopologySchema.safeParse(payload);
  if (!parsed.success) return null;
  const chains: FallbackChain[] = [];
  for (const entry of parsed.data) {
    const keys = Object.keys(entry);
    if (keys.length !== 1) return null;
    const model = keys[0]!;
    chains.push({ model, targets: entry[model]! });
  }
  return chains;
}