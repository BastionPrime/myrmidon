import {
  describeFallbackCycle,
  findCardFallbackCycle,
  findFallbackTopologyCycles,
  parseFallbackTopology,
  type FallbackChain,
} from "@paperclipai/shared";
import { unprocessable } from "../../errors.js";

/**
 * myrmidon(M2-B): fallback chains are checked for loops before they are saved.
 *
 * A loop in a fallback chain is a routing loop: the router falls back to a
 * group that leads back to the one that just failed, and the request burns its
 * whole retry budget on the same set of models. The deployed router topology
 * has held such loops (`a -> b` together with `b -> c -> a`), and neither the
 * agent card's save path nor the router's own settings write rejects them.
 *
 * Two shapes are checked, because a chain is saved in two places:
 *
 *  - the agent CARD's `models.fallbacks` list, checked on every card save
 *    through the same guard the model-name check uses;
 *  - the gateway's ROUTER topology, checked whenever the board is about to
 *    write it.
 *
 * Both checks are pure and return a message naming the loop, so the caller
 * turns it into the same 422 a bad model name gets. Nothing here rewrites a
 * chain on its own: a call site decides whether a loop is a reason to refuse.
 */

/** The agent card shape the card check reads (M1's "Additional models" block). */
export interface CardFallbackSource {
  /** The card's primary model, from the adapter config. */
  model?: unknown;
  models?: { fallbacks?: unknown } | null;
}

/** The card's fallback list, as strings, with blanks dropped. */
export function readCardFallbacks(card: CardFallbackSource): string[] {
  const raw = card.models?.fallbacks;
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === "string");
}

/** The card's primary model, as a string, or null. */
export function readCardPrimaryModel(card: CardFallbackSource): string | null {
  return typeof card.model === "string" && card.model.trim() ? card.model.trim() : null;
}

/**
 * Refuses a card whose fallback chain loops — the chain names the primary
 * model, or names the same model twice. Called from the card-save guard, so a
 * loop is rejected at save time with a message naming the models involved.
 */
export function assertCardFallbacksAcyclic(card: CardFallbackSource): void {
  const cycle = findCardFallbackCycle({
    primaryModel: readCardPrimaryModel(card),
    fallbacks: readCardFallbacks(card),
  });
  if (!cycle) return;
  throw unprocessable(
    `The fallback chain loops through the same model: ${describeFallbackCycle(cycle)}. ` +
      "A fallback must be a model the chain has not already tried — a repeat retries the request that just failed.",
    { code: "fallback_cycle", path: cycle.path },
  );
}

/**
 * Refuses a router topology that holds a loop.
 *
 * `payload` is the `router_settings.fallbacks` value as stored, so the check
 * guards the write path itself: an unreadable topology is refused as well,
 * because "the board cannot tell whether this is a loop" must not read as
 * "this is fine".
 */
export function assertFallbackTopologyAcyclic(payload: unknown): FallbackChain[] {
  const chains = parseFallbackTopology(payload);
  if (!chains) {
    throw unprocessable(
      "The fallback topology must be a list of {model: [fallback models]} entries.",
      { code: "fallback_topology_unreadable" },
    );
  }
  const cycles = findFallbackTopologyCycles(chains);
  if (cycles.length === 0) return chains;
  const described = cycles.map(describeFallbackCycle).join("; ");
  throw unprocessable(
    `The fallback topology loops: ${described}. Remove the loop — the router would retry the same group until the request budget runs out.`,
    { code: "fallback_cycle", cycles: cycles.map((cycle) => cycle.path) },
  );
}

/**
 * The check run on every card save, no matter what changed: a card whose chain
 * already loops must not be saved again as if it were fine. Exported for the
 * save guard; the model-name check next to it stays where it is.
 */
export function checkCardFallbackChains(adapterConfig: Record<string, unknown> | null | undefined): void {
  if (!adapterConfig || typeof adapterConfig !== "object") return;
  assertCardFallbacksAcyclic(adapterConfig as CardFallbackSource);
}

/** What the board learned from the gateway about its fallback topology. */
export interface GatewayFallbackReport {
  /** The topology as the gateway stores it, group by group. */
  chains: FallbackChain[];
  /** Every loop found in it, each named as `a -> b -> a`. */
  cycles: Array<{ path: string[]; described: string }>;
  /** Set instead of the fields above when the gateway could not be read. */
  error?: string;
}

/**
 * Reads the gateway's fallback topology through the admin key and reports its
 * loops.
 *
 * Read-only on purpose. The board does not push a topology over a working
 * gateway by itself: a write is an operator's decision, and the loops in the
 * deployed topology are a finding to report (a routing loop burns the retry
 * budget of every request that enters it), not a difference to silently
 * reconcile. The caller passes the settings so this module reads no
 * environment of its own.
 */
export async function readGatewayFallbackTopology(
  deps: {
    readSecretValue(companyId: string, secretName: string): Promise<string | null>;
  },
  input: {
    companyId: string;
    settings: { baseUrl: string | null; adminKeySecret: string | null };
  },
): Promise<GatewayFallbackReport> {
  const baseUrl = input.settings.baseUrl;
  const adminKeySecret = input.settings.adminKeySecret;
  if (!baseUrl || !adminKeySecret) {
    return { chains: [], cycles: [], error: "the gateway address or admin key is not configured" };
  }
  const adminKey = await deps.readSecretValue(input.companyId, adminKeySecret);
  if (!adminKey) {
    return { chains: [], cycles: [], error: "the gateway admin key is not available to the board" };
  }
  let payload: unknown;
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/router/settings`, {
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    if (!response.ok) {
      return { chains: [], cycles: [], error: `the gateway answered ${response.status}` };
    }
    const body = (await response.json()) as { fields?: Array<{ field_name?: string; field_value?: unknown }> };
    const field = (body.fields ?? []).find((entry) => entry.field_name === "fallbacks");
    payload = field?.field_value;
  } catch (err) {
    return { chains: [], cycles: [], error: err instanceof Error ? err.message : "the gateway could not be read" };
  }
  const chains = parseFallbackTopology(payload);
  if (!chains) {
    return { chains: [], cycles: [], error: "the gateway's fallback topology is in an unexpected shape" };
  }
  const cycles = findFallbackTopologyCycles(chains).map((cycle) => ({
    path: cycle.path,
    described: describeFallbackCycle(cycle),
  }));
  return { chains, cycles };
}