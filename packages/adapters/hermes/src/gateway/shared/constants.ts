export const ADAPTER_TYPE = "hermes_gateway";
export const ADAPTER_LABEL = "Hermes Gateway";

// myrmidon(G4): match hermes_local's default (shared/constants.ts) instead of
// the shorter 600s the gateway shipped with; a card's own timeoutSec still
// wins either way (gateway-parity-gap.md #21).
export const DEFAULT_TIMEOUT_SEC = 1_800;
export const DEFAULT_EVENT_RECONNECT_MS = 2_000;
export const DEFAULT_POLL_INTERVAL_MS = 1_000;
export const STOP_GRACE_MS = 10_000;
