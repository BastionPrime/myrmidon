// server/src/myrmidon/tracing-health/probes.ts
//
// myrmidon(TRACING-HEALTH): probes over the Langfuse ClickHouse and the LLM
// gateway. Each probe resolves to `null` on failure — the domain layer turns
// that into "unknown", the route never 500s. No address or secret value is
// returned or logged.
//
// The gateway side reuses the litellm-costs wiring (MYRMIDON_LITELLM_BASE_URL
// + MYRMIDON_LITELLM_KEY_SECRET, the same company secret, the same REST
// client over /spend/logs/v2) so gateway address and credentials come from
// one source. The Langfuse ClickHouse endpoints are new MYRMIDON_TRACING_*
// rows (deployment-off by default).

import {
  createLitellmGatewayClient,
  LITELLM_BASE_URL_ENV,
  LITELLM_KEY_SECRET_ENV,
  type LitellmGatewayClient,
} from "../litellm-costs/litellm-costs.js";

export const TRACING_CLICKHOUSE_URL_ENV = "MYRMIDON_TRACING_CLICKHOUSE_URL";
export const TRACING_CLICKHOUSE_USER_ENV = "MYRMIDON_TRACING_CLICKHOUSE_USER";
export const TRACING_CLICKHOUSE_PASSWORD_ENV = "MYRMIDON_TRACING_CLICKHOUSE_PASSWORD";
export const TRACING_CLICKHOUSE_DATABASE_ENV = "MYRMIDON_TRACING_CLICKHOUSE_DATABASE";
export const TRACING_WINDOW_SEC_ENV = "MYRMIDON_TRACING_WINDOW_SEC";
export const TRACING_CACHE_TTL_SEC_ENV = "MYRMIDON_TRACING_HEALTH_TTL_SEC";
/** Langfuse v4 `events_only` mode: traces live in ClickHouse `events_core`. */
export const TRACING_EVENTS_TABLE = "events_core";
/** Default database of the Langfuse ClickHouse deployment. */
export const DEFAULT_CLICKHOUSE_DATABASE = "default";

export interface TracingHealthSettings {
  /** Enabled only when the gateway (base URL + key secret) and the ClickHouse URL are all set. */
  enabled: boolean;
  baseUrl: string | null;
  keySecret: string | null;
  clickhouseUrl: string | null;
  clickhouseUser: string | null;
  clickhousePassword: string | null;
  clickhouseDatabase: string;
  /** Check window length in ms; default 15 min. */
  windowMs: number;
  /** Cache TTL in ms; probes run at most this often. */
  cacheTtlMs: number;
}

const DEFAULT_WINDOW_MS = 15 * 60_000;
const MIN_WINDOW_MS = 60_000;
const MAX_WINDOW_MS = 3_600_000;
const DEFAULT_CACHE_TTL_MS = 60_000;
const MIN_CACHE_TTL_MS = 5_000;
const MAX_CACHE_TTL_MS = 3_600_000;
const DEFAULT_WINDOW_SEC = 900;
const MIN_WINDOW_SEC = 60;
const MAX_WINDOW_SEC = 3600;
const DEFAULT_CACHE_TTL_SEC = 60;
const MIN_CACHE_TTL_SEC = 5;
const MAX_CACHE_TTL_SEC = 3600;

export function readTracingHealthSettings(env: NodeJS.ProcessEnv = process.env): TracingHealthSettings {
  const baseUrl = env[LITELLM_BASE_URL_ENV]?.trim() || null;
  const keySecret = env[LITELLM_KEY_SECRET_ENV]?.trim() || null;
  const clickhouseUrl = env[TRACING_CLICKHOUSE_URL_ENV]?.trim() || null;
  const clickhouseUser = env[TRACING_CLICKHOUSE_USER_ENV]?.trim() || null;
  const clickhousePassword = env[TRACING_CLICKHOUSE_PASSWORD_ENV]?.trim() || null;
  const clickhouseDatabase = env[TRACING_CLICKHOUSE_DATABASE_ENV]?.trim() || DEFAULT_CLICKHOUSE_DATABASE;
  const enabled = Boolean(baseUrl && keySecret && clickhouseUrl);
  let windowMs = DEFAULT_WINDOW_MS;
  const rawWindow = env[TRACING_WINDOW_SEC_ENV]?.trim();
  if (rawWindow) {
    const value = Number(rawWindow);
    if (Number.isInteger(value) && value >= MIN_WINDOW_SEC && value <= MAX_WINDOW_SEC) {
      windowMs = value * 1000;
    }
  }
  let cacheTtlMs = DEFAULT_CACHE_TTL_MS;
  const rawTtl = env[TRACING_CACHE_TTL_SEC_ENV]?.trim();
  if (rawTtl) {
    const value = Number(rawTtl);
    if (Number.isInteger(value) && value >= MIN_CACHE_TTL_SEC && value <= MAX_CACHE_TTL_SEC) {
      cacheTtlMs = value * 1000;
    }
  }
  return {
    enabled,
    baseUrl,
    keySecret,
    clickhouseUrl,
    clickhouseUser,
    clickhousePassword,
    clickhouseDatabase,
    windowMs,
    cacheTtlMs,
  };
}

// ---------------------------------------------------------------------------
// ClickHouse probe
// ---------------------------------------------------------------------------

/**
 * Window count over ClickHouse `events_core` (the Langfuse v4 `events_only`
// traces table — counting `traces`/`observations` is wrong by design, those
// tables stay empty in that mode). Returns null on any transport or shape
// failure.
 */
export async function countEvents(
  window: { from: Date; to: Date },
  settings: Pick<TracingHealthSettings, "clickhouseUrl" | "clickhouseUser" | "clickhousePassword" | "clickhouseDatabase">,
  fetchFn: typeof fetch = fetch,
): Promise<number | null> {
  if (!settings.clickhouseUrl) return null;
  // The table and database are constants of the feature, not user input; the
  // window bounds arrive as numbers. No identifier from the request reaches
  // the query text.
  const query = `SELECT count() FROM ${settings.clickhouseDatabase}.${TRACING_EVENTS_TABLE} WHERE timestamp >= toDateTime64(${Math.floor(window.from.getTime() / 1000)}, 3) AND timestamp < toDateTime64(${Math.floor(window.to.getTime() / 1000)}, 3)`;
  const url = new URL(settings.clickhouseUrl);
  url.pathname = (url.pathname.replace(/\/+$/, "") || "") + "/";
  const params = new URLSearchParams();
  params.set("query", query);
  params.set("default_format", "JSON");
  if (settings.clickhouseUser) {
    params.set("user", settings.clickhouseUser);
    if (settings.clickhousePassword) params.set("password", settings.clickhousePassword);
  }
  try {
    const response = await fetchFn(`${url.toString()}?${params.toString()}`, {
      method: "GET",
      headers: { "content-type": "text/plain" },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { data?: Array<Record<string, unknown>> };
    const row = body.data?.[0];
    const value = row?.["count()"];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
    return Math.floor(value);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Gateway probe (traffic)
// ---------------------------------------------------------------------------

/**
 * Window count of gateway requests over /spend/logs/v2 (the same client the
// litellm-costs sweep uses). Zero is a legitimate zero — quiet windows are
// "idle", not "broken". Returns null on any failure.
 */
export function gatewayRequestCount(
  client: Pick<LitellmGatewayClient, "listSpendLogs">,
  window: { from: Date; to: Date },
): Promise<number | null> {
  return client
    .listSpendLogs(window)
    .then((entries) => entries.length)
    .catch(() => null);
}

// ---------------------------------------------------------------------------
// Callback error rate probe
// ---------------------------------------------------------------------------

/**
 * The LiteLLM callback error rate [0..1]. LiteLLM does not expose a callback
 * error counter over its REST API, so the documented fallback is used: the
 * Langfuse ingestion rejection count over the same window, read from the
 * same ClickHouse (`langfuse_ingestion_rejections`). Zero rejections — rate
 * 0; probe failure — null; a window with no gateway traffic carries no
 * meaningful rate and reports null.
 */
export async function callbackErrorRate(
  window: { from: Date; to: Date },
  gatewayRequests: number | null,
  settings: Pick<TracingHealthSettings, "clickhouseUrl" | "clickhouseUser" | "clickhousePassword" | "clickhouseDatabase">,
  fetchFn: typeof fetch = fetch,
): Promise<number | null> {
  if (gatewayRequests === null || gatewayRequests <= 0) return null;
  const rejections = await countRejections(window, settings, fetchFn);
  if (rejections === null) return null;
  return Math.min(1, rejections / Math.max(1, gatewayRequests));
}

/**
 * Count of "Rejected ... legacy" ingestion rejections in the window — the
 * 02.10 incident signature: ingestion silently dropping legacy-format OTEL
 * events while the gateway kept serving traffic. Read from the Langfuse
 * ClickHouse the same way as the events count. null on probe failure (no
 * source) — a null never blocks the state machine; any value above zero
 * makes the state degraded.
 */
export async function countRejections(
  window: { from: Date; to: Date },
  settings: Pick<TracingHealthSettings, "clickhouseUrl" | "clickhouseUser" | "clickhousePassword" | "clickhouseDatabase">,
  fetchFn: typeof fetch = fetch,
): Promise<number | null> {
  if (!settings.clickhouseUrl) return null;
  const query = `SELECT count() FROM ${settings.clickhouseDatabase}.langfuse_ingestion_rejections WHERE timestamp >= toDateTime64(${Math.floor(window.from.getTime() / 1000)}, 3) AND timestamp < toDateTime64(${Math.floor(window.to.getTime() / 1000)}, 3)`;
  return clickhouseCount(query, settings, fetchFn);
}

/** Shared ClickHouse count() runner; null on any transport or shape failure. */
async function clickhouseCount(
  query: string,
  settings: Pick<TracingHealthSettings, "clickhouseUrl" | "clickhouseUser" | "clickhousePassword" | "clickhouseDatabase">,
  fetchFn: typeof fetch,
): Promise<number | null> {
  const url = new URL(settings.clickhouseUrl as string);
  url.pathname = (url.pathname.replace(/\/+$/, "") || "") + "/";
  const params = new URLSearchParams();
  params.set("query", query);
  params.set("default_format", "JSON");
  if (settings.clickhouseUser) {
    params.set("user", settings.clickhouseUser);
    if (settings.clickhousePassword) params.set("password", settings.clickhousePassword);
  }
  try {
    const response = await fetchFn(`${url.toString()}?${params.toString()}`, {
      method: "GET",
      headers: { "content-type": "text/plain" },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { data?: Array<Record<string, unknown>> };
    const value = body.data?.[0]?.["count()"];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
    return Math.floor(value);
  } catch {
    return null;
  }
}
