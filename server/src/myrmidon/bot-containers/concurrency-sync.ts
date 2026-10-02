// server/src/myrmidon/bot-containers/concurrency-sync.ts
//
// myrmidon(CONCURRENCY-SYNC): the board's concurrency limit for one agent — the
// card's runtimeConfig.heartbeat.maxConcurrentRuns, normalized by readMaxConcurrentRuns
// (profile-input.ts) — against the limit the bot's gateway was actually given.
//
// The forward path already exists: the card value is compiled into
// gateway.api_server.max_concurrent_runs of the bot's hermes/config.yaml
// (profile-compiler.ts) and the reconciler applies the resulting profile. This
// module is the backward path the card did not have: the applied-state marker
// records the number an apply wrote (docker-driver.ts), and everything here turns
// a card value plus that recorded value into what the card should say.
//
// Why it matters for a container the board does not manage. Hermes answers a run
// that exceeds its own max_concurrent_runs with HTTP 429, which the hermes_gateway
// adapter reports as the run error `hermes_gateway_rate_limited`
// (packages/adapters/hermes/src/gateway/server/execute.ts). When the board does not
// manage the gateway, nothing here can read its limit: the best the board has is
// the number it would apply (the card) and whether runs of this agent have recently
// come back rate-limited. Rate-limited runs while the board's own limit is above 1
// mean the gateway is holding runs back below what the card asks for — the exact
// failure this makes visible instead of silent. A full two-way sync of an external
// gateway is out of scope here (it needs the fleetd-managed gateway inventory).
//
// Pure: no clock of its own, no container driver, no database. The caller passes
// the reading time and the last rate-limited run it found.

/** Run error the hermes_gateway adapter reports for a gateway HTTP 429 response. */
export const GATEWAY_RATE_LIMITED_ERROR_CODE = "hermes_gateway_rate_limited";

/** How far back a rate-limited run still counts as "the gateway is limiting runs now". */
export const GATEWAY_RATE_LIMIT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** Said when a container exists but its applied profile does not report the limit
 *  (a marker written before the number was recorded): the next reconcile pass
 *  rewrites it (a "files" class change, no restart — see types.ts). */
export const APPLIED_LIMIT_PENDING_NOTE =
  "The container's applied profile does not report its concurrency limit yet; the next reconcile pass records it (no restart).";

/** Said when there is no applied state to compare against: no container exists yet
 *  for this agent, or the instance has containers switched off/unwired. */
export const NO_APPLIED_STATE_NOTE =
  "No applied profile to compare against yet: the limit below is what the board would apply.";

/** Said for an agent whose gateway the board does not run in a container
 *  (containers switched off on the card, or the instance has no bot containers):
 *  the board can neither read nor change that gateway's own limit. */
export const EXTERNAL_GATEWAY_NOTE =
  "This agent's gateway is not managed by the board's containers: the board cannot read or apply its concurrency limit.";

/** The board's value against the gateway's, as the status route reports it. */
export interface GatewayConcurrencyStatus {
  /** runtimeConfig.heartbeat.maxConcurrentRuns as normalized for the profile (1..50). */
  board: number;
  /** max_concurrent_runs of the applied profile, from the container's marker; null when
   *  no applied state could be read (no container, no marker, unreadable marker). */
  applied: number | null;
  /** True only when the applied value is known AND differs from the board's: with no
   *  applied value there is nothing to disagree with, so the card says "not reported"
   *  rather than "diverged". */
  diverged: boolean;
  /** When this reading was taken (ISO 8601). */
  checkedAt: string;
}

/**
 * Compares the normalized card value with the applied one. `checkedAt` is passed in
 * so a reading is reproducible in tests and so the caller owns the clock.
 */
export function compareGatewayConcurrency(params: {
  board: number;
  applied: number | null;
  checkedAt: string;
}): GatewayConcurrencyStatus {
  const { board, applied, checkedAt } = params;
  return { board, applied, diverged: applied !== null && applied !== board, checkedAt };
}

/**
 * The warning for an agent whose gateway the board does not manage, or null when
 * there is nothing to warn about.
 *
 * A rate-limited run is only a sign of a *lower* gateway limit while the board asks
 * for more than one run at a time: with a board limit of 1 the gateway holding a
 * second run back is exactly what the card asks for, and a 429 there would mean
 * something else (an upstream limit, not this one).
 */
export function externalGatewayRateLimitWarning(params: {
  board: number;
  /** ISO timestamp of the most recent run of this agent that the gateway answered with
   *  429, within GATEWAY_RATE_LIMIT_LOOKBACK_MS; null when there was none. */
  rateLimitedAt: string | null;
}): string | null {
  const { board, rateLimitedAt } = params;
  if (!rateLimitedAt || board <= 1) return null;
  return `Runs of this agent were rate-limited by its gateway (last at ${rateLimitedAt}) while the board asks for up to ${board} at a time: the gateway is limiting runs below the board's limit.`;
}