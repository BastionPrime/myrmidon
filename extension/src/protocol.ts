// Wire contract of the Myrmidon browser bridge, mirrored into the extension.
//
// The gateway (server/src/myrmidon/browser-bridge) defines this contract in
// packages/shared/src/myrmidon-browser-bridge.ts. The extension ships as a
// plain directory (not a pnpm workspace package), so it cannot import the
// shared package; it carries this copy instead. Part B of the case owns the
// original: when the gateway contract changes, both files must change in sync.

/** WSS endpoint the extension dials. Outbound only: the client opens no port. */
export const BROWSER_BRIDGE_WS_PATH = "/bridge/v1";

/** HTTP endpoint the extension exchanges a pairing code on. */
export const BROWSER_BRIDGE_PAIR_PATH = "/bridge/v1/pair";

/** Protocol revision the gateway announces in `bridge.ready`. */
export const BRIDGE_PROTOCOL_VERSION = 1;

/** Time budget of one browser action (30 s). */
export const BRIDGE_ACTION_TIMEOUT_MS = 30_000;

/** Time budget of a human-confirmed action (180 s). */
export const BRIDGE_CONFIRMATION_TIMEOUT_MS = 180_000;

/**
 * Ceiling of one `browser.download` (part D), mirrored from the gateway
 * contract. The extension refuses a larger file before it crosses the bridge.
 */
export const BROWSER_DOWNLOAD_MAX_BYTES = 25 * 1024 * 1024;

/** JSON-RPC 2.0 version string. */
export const JSON_RPC_VERSION = "2.0";

export const BRIDGE_HELLO_METHOD = "bridge.hello";
export const BRIDGE_READY_METHOD = "bridge.ready";

/**
 * The gateway's cancellation notification: it gave up on one action (most often
 * the person did not confirm a signing step within the 180 s budget). The
 * extension drops the pending action and closes any confirmation prompt.
 */
export const BRIDGE_CANCEL_METHOD = "browser.cancel";

/** Capabilities this build of the extension implements. */
export const EXTENSION_CAPABILITIES = [
  "open",
  "read",
  "click",
  "fill",
  "download",
  "screenshot",
] as const;

export type ExtensionCapability = (typeof EXTENSION_CAPABILITIES)[number];

/**
 * Appliction error codes of the bridge, mirroring the gateway contract. The
 * extension decides its own behavior from these codes (re-pair, reconnect or
 * surface the error); it never guesses from a message string.
 */
export const BROWSER_BRIDGE_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  notPaired: -32010,
  revoked: -32011,
  capabilityUnsupported: -32012,
  domainNotAllowed: -32013,
  deviceOffline: -32014,
  timeout: -32015,
  pairingCodeInvalid: -32016,
  pairingCodeExpired: -32017,
  protocolVersionUnsupported: -32018,
  confirmationNotGranted: -32019,
  signingDisabled: -32020,
  downloadTooLarge: -32021,
} as const;

/** Bot-driven browser methods the extension can execute. */
export const BROWSER_BRIDGE_METHODS = [
  "browser.open",
  "browser.read",
  "browser.click",
  "browser.fill",
  "browser.download",
  "browser.screenshot",
] as const;

export type BrowserBridgeMethod = (typeof BROWSER_BRIDGE_METHODS)[number];

export interface JsonRpcRequestFrame {
  jsonrpc: typeof JSON_RPC_VERSION;
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccessFrame {
  jsonrpc: typeof JSON_RPC_VERSION;
  id: string | number | null;
  result: unknown;
}

export interface JsonRpcErrorFrame {
  jsonrpc: typeof JSON_RPC_VERSION;
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: Record<string, unknown>;
  };
}

export type JsonRpcResponseFrame = JsonRpcSuccessFrame | JsonRpcErrorFrame;

/**
 * The allowlist of the tender platform domains, as the gateway hands it over
 * in `bridge.ready`. The extension keeps its own copy and checks every action
 * before it sends anything: defense in depth, the gateway checks again.
 */
export interface AllowlistUpdate {
  domains: string[];
}

export interface PairedDeviceInfo {
  deviceId: string;
  token: string;
  capabilities: string[];
  allowlist: string[];
  pairedAt: string;
}

/** Wire frames — as they travel over the WebSocket or the pairing HTTP call. */
export interface PairingExchangeWireRequest {
  code: string;
  deviceId: string;
  extVersion: string;
  capabilities: string[];
}
