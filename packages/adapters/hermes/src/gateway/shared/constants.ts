export const ADAPTER_TYPE = "hermes_gateway";
export const ADAPTER_LABEL = "Hermes Gateway";

// myrmidon(G4): match hermes_local's default (shared/constants.ts) instead of
// the shorter 600s the gateway shipped with; a card's own timeoutSec still
// wins either way (gateway-parity-gap.md #21).
export const DEFAULT_TIMEOUT_SEC = 1_800;
export const DEFAULT_EVENT_RECONNECT_MS = 2_000;
export const DEFAULT_POLL_INTERVAL_MS = 1_000;
export const STOP_GRACE_MS = 10_000;
// myrmidon(G4): per-request timeout for the operator-cancellation stop path
// (POST .../stop and each GET .../{runId} poll in fetchFinalStatus). Neither
// request previously carried a signal, so a hung gateway could block
// execute() past the platform's own 60s waitForAdapterStop deadline
// (server/services/adapter-execution-control.ts) instead of returning
// within the STOP_GRACE_MS budget above.
export const STOP_REQUEST_TIMEOUT_MS = 5_000;
// myrmidon(G4): bounds the initial POST /v1/runs create request the same
// way STOP_REQUEST_TIMEOUT_MS bounds the stop path — onCancellationReady is
// awaited before this request goes out, but it previously carried no signal
// at all, so a gateway that accepted the connection and never answered could
// block execute() past waitForAdapterStop's 60s deadline even though the run
// had never actually started.
//
// myrmidon(G5): default raised from 15s to 60s — a busy multiplexed gateway
// can need longer to accept a run (cold profile start). Configurable per
// agent via adapterConfig.createRequestTimeoutSec and per instance via
// MYRMIDON_HERMES_CREATE_TIMEOUT_SEC; see resolveCreateRequestTimeoutMs.
export const CREATE_REQUEST_TIMEOUT_MS = 60_000;
export const CREATE_REQUEST_TIMEOUT_MIN_SEC = 5;
export const CREATE_REQUEST_TIMEOUT_MAX_SEC = 300;
export const CREATE_TIMEOUT_ENV = "MYRMIDON_HERMES_CREATE_TIMEOUT_SEC";

function parseCreateTimeoutSec(value: unknown): number | null {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(parsed)) return null;
  if (parsed < CREATE_REQUEST_TIMEOUT_MIN_SEC || parsed > CREATE_REQUEST_TIMEOUT_MAX_SEC) return null;
  return parsed;
}

// myrmidon(G5): agent config wins, then the instance env, then the 60s
// default. Values outside 5..300 s (or non-numeric) are ignored, not clamped.
export function resolveCreateRequestTimeoutMs(
  configValue: unknown,
  env: Record<string, string | undefined> = process.env,
): number {
  const sec = parseCreateTimeoutSec(configValue) ?? parseCreateTimeoutSec(env[CREATE_TIMEOUT_ENV]);
  return sec === null ? CREATE_REQUEST_TIMEOUT_MS : Math.round(sec * 1000);
}
// myrmidon(G4): once operator cancellation arrives while the create request
// is still in flight, give it this much longer to settle on its own (the
// response, with a run_id, may already be on the wire) before the create
// request is cut off outright. Kept short so the total create-path budget
// (this grace, plus the stop path's STOP_GRACE_MS) stays well under the
// platform's 60s waitForAdapterStop deadline.
export const CREATE_CANCEL_GRACE_MS = 5_000;
