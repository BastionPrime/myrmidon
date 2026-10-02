import { z } from "zod";

/**
 * Browser-bridge contract (myrmidon EXTCASE-B).
 *
 * One place for everything the three parts of the first third-party case share:
 * the extension (part C) opens an outbound WSS to the gateway (part B), the
 * gateway exposes the browser actions to the company bot as MCP tools, and the
 * panel reads/edits the allowlist. The two sides must not drift, so the wire
 * names, the capability keys, the timeouts, the pairing-code shape and the
 * allowlist rules live here and are imported by both.
 *
 * The gateway authenticates a device with a long-lived bridge token, but the
 * token itself travels only in the upgrade request (Authorization header or
 * `token` query parameter). A browser extension cannot set request headers on a
 * WebSocket, which is why the query parameter exists at all; the gateway never
 * logs or journals it (see server/src/myrmidon/browser-bridge/wss.ts).
 */

/** WSS endpoint the extension dials. Outbound only: the client opens no port. */
export const BROWSER_BRIDGE_WS_PATH = "/bridge/v1";

/** Panel base path (board-authenticated reads/writes; design note §4.4). */
export const BROWSER_BRIDGE_PANEL_BASE = "/api/myrmidon/browser-bridge";

/** HTTP endpoint the extension exchanges a pairing code on (design note §4.2). */
export const BROWSER_BRIDGE_PAIR_PATH = "/bridge/v1/pair";

/** Protocol revision the gateway announces in `bridge.ready`. */
export const BRIDGE_PROTOCOL_VERSION = 1;

/**
 * Time budget of one browser action, and of an action that a human has to
 * confirm on the client PC (design note §4.1 and §4.5). A signing step is never
 * performed by the extension itself: the bot walks the scenario to the final
 * step, the extension asks the person, and the person presses the button. The
 * gateway holds the request open for the longer budget and journals a timeout
 * when nobody confirms in time.
 */
export const BRIDGE_ACTION_TIMEOUT_MS = 30_000;
export const BRIDGE_CONFIRMATION_TIMEOUT_MS = 180_000;

/**
 * Ceiling of one `browser.download` (part D). A download larger than this is
 * refused by the extension instead of being carried over the bridge: the bridge
 * exists to hand a bot a tender document, not to move arbitrary files, and an
 * unbounded frame would cost both sides the whole transfer before anyone can
 * say no.
 */
export const BROWSER_DOWNLOAD_MAX_BYTES = 25 * 1024 * 1024;

/** Human-readable, one-shot code lifetime (design note §4.2). */
export const PAIRING_CODE_TTL_MS = 15 * 60 * 1000;

/**
 * Methods the bot drives through the gateway (design note §4.3). `bridge.hello`
 * and `bridge.ready` are the handshake and are deliberately not in this list:
 * the bot cannot call them and the extension cannot serve them.
 */
export const BROWSER_BRIDGE_METHODS = [
  "browser.open",
  "browser.read",
  "browser.click",
  "browser.fill",
  "browser.download",
  "browser.screenshot",
  "browser.sign",
] as const;

export type BrowserBridgeMethod = (typeof BROWSER_BRIDGE_METHODS)[number];

/**
 * Capability keys the extension declares in `bridge.hello`. The gateway grants
 * the intersection of what the extension declares and what it knows, and refuses
 * a bot request whose capability was not granted (deny by default).
 */
export const BROWSER_BRIDGE_CAPABILITIES = [
  "open",
  "read",
  "click",
  "fill",
  "download",
  "screenshot",
  "sign",
] as const;

export type BrowserBridgeCapability = (typeof BROWSER_BRIDGE_CAPABILITIES)[number];

/** Method -> capability it needs. A method with no entry is not driven by the bot. */
export const BROWSER_BRIDGE_METHOD_CAPABILITY: Record<BrowserBridgeMethod, BrowserBridgeCapability> = {
  "browser.open": "open",
  "browser.read": "read",
  "browser.click": "click",
  "browser.fill": "fill",
  "browser.download": "download",
  "browser.screenshot": "screenshot",
  "browser.sign": "sign",
};

export const bridgeCapabilitySetSchema = z
  .array(z.enum(BROWSER_BRIDGE_CAPABILITIES))
  .max(BROWSER_BRIDGE_CAPABILITIES.length);

/**
 * The declared capability set as canonical data: known keys only, deduplicated,
 * in the contract's order. `null` means "unreadable", never "empty": an
 * extension that declares nothing usable gets no capabilities, not all of them.
 */
export function normalizeCapabilitySet(raw: unknown): BrowserBridgeCapability[] | null {
  if (raw === undefined || raw === null) return [];
  const known = new Set<string>(BROWSER_BRIDGE_CAPABILITIES);
  if (!Array.isArray(raw)) return null;
  const seen = new Set<BrowserBridgeCapability>();
  for (const entry of raw) {
    if (typeof entry !== "string" || !known.has(entry)) return null;
    seen.add(entry as BrowserBridgeCapability);
  }
  return BROWSER_BRIDGE_CAPABILITIES.filter((key) => seen.has(key));
}

export const BRIDGE_HELLO_METHOD = "bridge.hello";
export const BRIDGE_READY_METHOD = "bridge.ready";

/**
 * Notification the gateway sends when it gives up on a request (its budget
 * expired, most often because the person did not confirm a signing step). The
 * extension drops the pending action; the gateway journals a timeout. It is a
 * notification precisely because there is nobody left to answer.
 */
export const BRIDGE_CANCEL_METHOD = "browser.cancel";

/**
 * Signing (design note §4.5, revision 2). The signature itself happens
 * on the client PC: the extension talks to a local helper over native messaging,
 * the helper drives the token middleware, and the private key and the PIN never
 * pass through the board — only the command and the result (status plus the
 * document hash) travel. The gateway owns the policy: the mode of the client,
 * the emergency switch, and the journal row of every signature.
 */

/** Shape of one action type. Part D owns the enum values; part B owns the shape. */
export const BROWSER_BRIDGE_SIGN_ACTION_TYPE_PATTERN = /^[a-z][a-z0-9_.:-]{0,39}$/;

export const signActionTypeSchema = z.string().regex(BROWSER_BRIDGE_SIGN_ACTION_TYPE_PATTERN);

export const BROWSER_BRIDGE_SIGNING_MODES = ["auto", "manual", "types"] as const;
export type BrowserBridgeSigningMode = (typeof BROWSER_BRIDGE_SIGNING_MODES)[number];

/**
 * Daily signature ceiling of the bridge: the number of `browser.sign` actions
 * journaled as executed per company per UTC day at which the gateway refuses
 * further signatures for the rest of the day. The schema rejects anything
 * above this so a typo cannot turn "5 per day" into a free-for-all.
 */
export const BROWSER_BRIDGE_MAX_DAILY_SIGNS = 10_000;

export interface BrowserBridgeSigningSettings {
  /** The emergency switch: when off, every sign action is refused, whatever the mode. */
  enabled: boolean;
  /** `auto` — the helper signs at once; `manual` — a person confirms; `types` — per action type. */
  mode: BrowserBridgeSigningMode;
  /** Action types that need a person, when `mode` is `types`. */
  types: string[];
  /** Journaled signatures per UTC day at which signing stops for the day; 0 = no limit. */
  dailyLimit: number;
}

export const DEFAULT_BROWSER_BRIDGE_SIGNING: BrowserBridgeSigningSettings = {
  enabled: true,
  mode: "auto",
  types: [],
  dailyLimit: 0,
};

export const browserBridgeSigningSchema = z
  .object({
    enabled: z.boolean().default(true),
    mode: z.enum(BROWSER_BRIDGE_SIGNING_MODES).default("auto"),
    types: z.array(signActionTypeSchema).max(64).default([]),
    dailyLimit: z.number().int().min(0).max(BROWSER_BRIDGE_MAX_DAILY_SIGNS).default(0),
  })
  .strict();

/** What the gateway must do with one sign action under the settings in force. */
export type BrowserBridgeSignDecision = "auto" | "manual" | "refuse";

/**
 * The one place the signing policy is decided. Off wins over every mode — that
 * is what makes the panel's emergency switch fail-closed rather than advisory.
 */
export function resolveSignDecision(
  signing: BrowserBridgeSigningSettings,
  actionType: string,
): BrowserBridgeSignDecision {
  if (!signing.enabled) return "refuse";
  if (signing.mode === "manual") return "manual";
  if (signing.mode === "types") return signing.types.includes(actionType) ? "manual" : "auto";
  return "auto";
}

/** Read a stored signing block; anything unreadable falls back to the default. */
export function normalizeSigningSettings(raw: unknown): BrowserBridgeSigningSettings {
  const parsed = browserBridgeSigningSchema.safeParse(raw ?? {});
  if (!parsed.success) return { ...DEFAULT_BROWSER_BRIDGE_SIGNING };
  return {
    enabled: parsed.data.enabled,
    mode: parsed.data.mode,
    types: [...parsed.data.types],
    dailyLimit: parsed.data.dailyLimit,
  };
}

/**
 * What the extension reports back for a signature. The signed bytes never leave
 * the client PC, so the row carries the digest and the status, nothing else.
 */
export const browserBridgeSignResultSchema = z
  .object({
    status: z.enum(["signed", "refused"]),
    documentHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export type BrowserBridgeSignResult = z.infer<typeof browserBridgeSignResultSchema>;

/**
 * Parameters of a bot-driven action, one shape for all methods. `confirmation:
 * "human"` marks the signing steps of design note §4.5: the gateway holds the
 * request for the 180 s budget and the person on the client PC presses the
 * button — the extension never performs those steps by itself.
 */
export const browserBridgeActionParamsSchema = z
  .object({
    url: z.string().max(2048).optional(),
    target: z.string().min(1).max(512).optional(),
    value: z.string().max(4096).optional(),
    confirmation: z.enum(["none", "human"]).optional(),
    /** `browser.sign`: workspace-relative reference to the document to sign. */
    documentRef: z.string().min(1).max(512).optional(),
    /** `browser.sign`: the action type of the signature (part D owns the enum). */
    actionType: signActionTypeSchema.optional(),
  })
  .strict();

export type BrowserBridgeActionParams = z.infer<typeof browserBridgeActionParamsSchema>;

/** Which parameters a method cannot run without. */
export const BROWSER_BRIDGE_METHOD_REQUIRED_PARAMS: Record<
  BrowserBridgeMethod,
  readonly (keyof BrowserBridgeActionParams)[]
> = {
  "browser.open": ["url"],
  "browser.read": [],
  "browser.click": ["target"],
  "browser.fill": ["target", "value"],
  "browser.download": ["url"],
  "browser.screenshot": [],
  "browser.sign": ["documentRef", "actionType"],
};

/** Methods whose url is a navigation the gateway can check against the allowlist. */
export const BROWSER_BRIDGE_URL_METHODS: readonly BrowserBridgeMethod[] = ["browser.open", "browser.download"];

export function validateActionParams(
  method: BrowserBridgeMethod,
  raw: unknown,
): { ok: true; params: BrowserBridgeActionParams } | { ok: false; message: string } {
  const parsed = browserBridgeActionParamsSchema.safeParse(raw ?? {});
  if (!parsed.success) return { ok: false, message: "invalid action params" };
  const params = parsed.data;
  for (const key of BROWSER_BRIDGE_METHOD_REQUIRED_PARAMS[method]) {
    if (params[key] === undefined || params[key] === "") {
      return { ok: false, message: `${method} requires "${key}"` };
    }
  }
  if (BROWSER_BRIDGE_URL_METHODS.includes(method)) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(params.url ?? "");
    } catch {
      return { ok: false, message: `${method} requires an absolute url` };
    }
    if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
      return { ok: false, message: `${method} accepts http(s) urls only` };
    }
  }
  return { ok: true, params };
}

export const bridgeHelloParamsSchema = z
  .object({
    deviceId: z.string().min(1).max(128),
    extVersion: z.string().min(1).max(64),
    capabilities: bridgeCapabilitySetSchema.optional(),
  })
  .strict();

export type BridgeHelloParams = z.infer<typeof bridgeHelloParamsSchema>;

export const bridgeReadyResultSchema = z
  .object({
    protocolVersion: z.number().int(),
    deviceId: z.string(),
    capabilities: bridgeCapabilitySetSchema,
    allowlist: z.array(z.string()),
    actionTimeoutMs: z.number().int(),
    confirmationTimeoutMs: z.number().int(),
  })
  .strict();

export type BridgeReadyResult = z.infer<typeof bridgeReadyResultSchema>;

/** JSON-RPC 2.0 version string — the transport of the bridge (design note §4.1). */
export const JSON_RPC_VERSION = "2.0";

/**
 * Application error codes. The JSON-RPC standard reserves -32700..-32600 for
 * transport/parse failures; the bridge's own refusals start at -32010 so they
 * never collide with a standard code. A refusal is data on the wire: the bot
 * sees which gate closed, and the same code lands in the company journal.
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
  dailyLimitReached: -32022,
  downloadTooLarge: -32021,
} as const;

export type BrowserBridgeErrorCode =
  (typeof BROWSER_BRIDGE_ERROR_CODES)[keyof typeof BROWSER_BRIDGE_ERROR_CODES];

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
 * Pairing code alphabet and shape: two groups of four characters, uppercase,
 * no confusable digits or letters (no 0/O, 1/I/L). A person reads the code over
 * the phone or types it from a chat message, so the code must survive both.
 */
export const PAIRING_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const PAIRING_CODE_GROUP_LENGTH = 4;
export const PAIRING_CODE_GROUPS = 2;
export const PAIRING_CODE_LENGTH = PAIRING_CODE_GROUP_LENGTH * PAIRING_CODE_GROUPS;
export const PAIRING_CODE_PATTERN = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/;

/** Known keys of `instance_settings.general.browserBridge` (the bridge panel settings). */
export const browserBridgeSettingsSchema = z
  .object({
    domains: z.array(z.string().min(1).max(253)).max(500),
    /** Signing policy of the client (design note §4.5, revision 2). */
    signing: browserBridgeSigningSchema.default({ ...DEFAULT_BROWSER_BRIDGE_SIGNING }),
  })
  .strict();

/** Patch of the bridge settings: absent keys keep their stored value. */
export const browserBridgeSettingsPatchSchema = z
  .object({
    domains: z.array(z.string().min(1).max(253)).max(500).optional(),
    signing: browserBridgeSigningSchema.optional(),
  })
  .strict();

export type BrowserBridgeSettings = z.infer<typeof browserBridgeSettingsSchema>;
export type BrowserBridgeSettingsPatch = z.infer<typeof browserBridgeSettingsPatchSchema>;

export const DEFAULT_BROWSER_BRIDGE_SETTINGS: BrowserBridgeSettings = {
  domains: [],
  signing: { ...DEFAULT_BROWSER_BRIDGE_SIGNING },
};

export const pairingCodeRequestSchema = z
  .object({
    label: z.string().trim().min(1).max(80).optional(),
  })
  .strict();

export const pairingExchangeRequestSchema = z
  .object({
    code: z.string().min(1).max(64),
    deviceId: z.string().min(1).max(128),
    extVersion: z.string().min(1).max(64),
    capabilities: bridgeCapabilitySetSchema.optional(),
  })
  .strict();

export type PairingExchangeRequest = z.infer<typeof pairingExchangeRequestSchema>;

export const bridgeTokenPrefix = "mbb_";

/** Bridge tokens are opaque 256-bit random values; only their HMAC is stored. */
export const BRIDGE_TOKEN_BYTES = 32;

/**
 * Normalize a pairing code as a person typed it: trim, uppercase, and accept the
 * code with or without the separating dash. Returns the canonical `XXXX-XXXX`
 * form, or null when the input cannot be a code at all.
 */
export function normalizePairingCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const compact = raw.trim().toUpperCase().replace(/[\s-]+/g, "");
  if (compact.length !== PAIRING_CODE_LENGTH) return null;
  for (const char of compact) {
    if (!PAIRING_CODE_ALPHABET.includes(char)) return null;
  }
  return `${compact.slice(0, PAIRING_CODE_GROUP_LENGTH)}-${compact.slice(PAIRING_CODE_GROUP_LENGTH)}`;
}

/**
 * A single allowlist entry as a hostname: lowercase, no scheme, no path, no
 * port, no wildcard. An entry that is not a bare hostname is dropped rather than
 * guessed at, so a typo cannot silently widen the list.
 */
export function normalizeAllowlistDomain(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase().replace(/\.$/, "");
  if (!value || value.length > 253) return null;
  if (value.includes("/") || value.includes(":") || value.includes("@") || value.includes("*")) return null;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(value)) return null;
  return value;
}

/** Deduplicated, canonical allowlist; unreadable entries are dropped. */
export function normalizeAllowlistDomains(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const domain = normalizeAllowlistDomain(entry);
    if (domain) seen.add(domain);
  }
  return [...seen].sort();
}

/**
 * Hostname match: the host is the domain itself or a subdomain of it. An
 * allowlisted `tender.example` therefore covers `www.tender.example` — the
 * tender platform's own subdomains are part of the same site — but never
 * `tender.example.evil.test`, because the boundary is the dot.
 */
export function hostMatchesAllowlistDomain(host: string, domain: string): boolean {
  const normalizedHost = host.trim().toLowerCase().replace(/\.$/, "");
  const normalizedDomain = normalizeAllowlistDomain(domain);
  if (!normalizedDomain) return false;
  return normalizedHost === normalizedDomain || normalizedHost.endsWith(`.${normalizedDomain}`);
}

/**
 * Gateway-side allowlist check (defense in depth: the extension checks too).
 * Only http(s) pages are eligible, and only when their host matches an entry.
 */
export function isUrlAllowedByAllowlist(url: string, domains: readonly string[]): boolean {
  const normalized = normalizeAllowlistDomains(domains);
  if (normalized.length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  return normalized.some((domain) => hostMatchesAllowlistDomain(parsed.hostname, domain));
}