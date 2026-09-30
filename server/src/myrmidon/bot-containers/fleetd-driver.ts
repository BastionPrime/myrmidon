// server/src/myrmidon/bot-containers/fleetd-driver.ts
//
// myrmidon(FLEETD-VMEXEC): BotContainerDriver client for a `fleetd` service
// running on another machine (the dev bots' host). The board speaks plain HTTP
// over the internal network with a static token (a company secret the operator
// provisions; see MYRMIDON_FLEET_HOSTS in SETTINGS.md); fleetd holds the local
// Docker socket of its host and enforces the same fixed container template the
// dockergate-backed local driver enforces, so this client never sends anything
// the template does not describe: the same BotContainerSpec the reconciler
// already builds for the local driver, and the same CompiledProfile the
// compiler already produces.
//
// Transport notes:
//  - node:http, no new dependency (CONVENTIONS §8). HTTP, because the fleetd
//    host is reachable only over the internal network and terminating TLS there
//    buys nothing the network itself does not already provide; the token is
//    sent as a bearer header and never logged.
//  - Every response body is capped, and a non-2xx answer is an Error with the
//    fleetd status code and reason phrase (fleetd error bodies are one line,
//    produced by the same reason-code discipline as dockergate: no secrets,
//    no host paths).
//  - The profile travels as JSON with file contents inline. Secret files are
//    marked so fleetd never logs them; the request body is bounded by the same
//    limits the local driver's tar path uses.

import http from "node:http";

import type { BotContainerDriver, BotContainerSpec, BotContainerStatus } from "./driver.js";
import type { CompiledProfile } from "./types.js";

/** The token header fleetd requires on every call. */
const AUTHORIZATION = "authorization";

export const FLEETD_DRIVER_BASE_URL_ENV = "MYRMIDON_FLEET_HOST_URL";
export const FLEETD_DRIVER_TOKEN_ENV = "MYRMIDON_FLEET_HOST_TOKEN";
const DEFAULT_TIMEOUT_MS = 60_000;
/** profileDrift/writeProfile bodies carry the whole profile; allow headroom. */
const BODY_LIMIT_BYTES = 64 * 1024 * 1024;
const START_TIMEOUT_MS = 180_000;

export interface FleetdDriverConfig {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
}

export class FleetdDriverError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
  ) {
    super(`fleetd ${status} ${reason}`);
  }
}

export function readFleetdDriverConfig(env: NodeJS.ProcessEnv = process.env): FleetdDriverConfig {
  const baseUrl = env[FLEETD_DRIVER_BASE_URL_ENV]?.trim().replace(/\/+$/, "");
  const token = env[FLEETD_DRIVER_TOKEN_ENV]?.trim();
  if (!baseUrl) throw new Error(`${FLEETD_DRIVER_BASE_URL_ENV} must be set to use the fleetd driver`);
  if (!token) throw new Error(`${FLEETD_DRIVER_TOKEN_ENV} must be set to use the fleetd driver`);
  return { baseUrl, token };
}

interface RawResponse {
  status: number;
  body: Buffer;
}

/** Test hook; production passes none. */
export interface FleetdDriverOptions {
  request?: (opts: {
    method: string;
    path: string;
    body?: Buffer;
    headers?: Record<string, string>;
    timeoutMs?: number;
  }) => Promise<RawResponse>;
  timeoutMs?: number;
}

export interface FleetdEndpoint {
  host: string;
  port: number;
}

/** Parses `http://host[:port]` into what node:http wants. No TLS: the fleetd
 *  host is reachable only over the internal network (see the module comment). */
export function parseFleetdEndpoint(baseUrl: string): FleetdEndpoint {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:") throw new Error(`fleetd baseUrl must be http:// (got ${url.protocol}//)`);
  const port = url.port === "" ? 80 : Number(url.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`fleetd baseUrl port is invalid: ${url.port}`);
  return { host: url.hostname, port };
}

function fleetdRequest(
  config: FleetdDriverConfig,
  opts: {
    method: string;
    path: string;
    body?: Buffer;
    headers?: Record<string, string>;
    timeoutMs?: number;
  },
): Promise<RawResponse> {
  const endpoint = parseFleetdEndpoint(config.baseUrl);
  return new Promise((resolve, reject) => {
    const headers = { ...(opts.headers ?? {}) };
    if (opts.body) headers["Content-Length"] = String(opts.body.length);
    const req = http.request(
      {
        host: endpoint.host,
        port: endpoint.port,
        path: `/v1${opts.path}`,
        method: opts.method,
        headers,
        timeout: opts.timeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > BODY_LIMIT_BYTES) {
            req.destroy(new Error(`fleetd ${opts.method} ${opts.path}: response body over ${BODY_LIMIT_BYTES} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error(`fleetd ${opts.method} ${opts.path}: timed out`));
    });
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

export function fleetdBotContainerDriver(
  config: FleetdDriverConfig,
  options: FleetdDriverOptions = {},
): BotContainerDriver {
  const request = options.request ?? ((opts) => fleetdRequest(config, opts));

  async function callJson<T>(opts: {
    method: string;
    path: string;
    body?: unknown;
    timeoutMs?: number;
  }): Promise<T> {
    const res = await request({
      method: opts.method,
      path: opts.path,
      ...(opts.body === undefined ? {} : { body: Buffer.from(JSON.stringify(opts.body), "utf8") }),
      headers: {
        [AUTHORIZATION]: `Bearer ${config.token}`,
        Accept: "application/json",
        ...(opts.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    });
    if (res.status >= 400) {
      // One line, fleetd-side discipline; never echo the body (it could hold a secret path).
      throw new FleetdDriverError(res.status, res.body.toString("utf8").slice(0, 200).trim() || "error");
    }
    if (res.body.length === 0) return undefined as T;
    return JSON.parse(res.body.toString("utf8")) as T;
  }

  async function callVoid(opts: { method: string; path: string; body?: unknown; timeoutMs?: number }): Promise<void> {
    await callJson(opts);
  }

  return {
    async status(botKey: string): Promise<BotContainerStatus> {
      return callJson<BotContainerStatus>({ method: "GET", path: `/bots/${encodeURIComponent(botKey)}/status` });
    },

    async list(): Promise<BotContainerStatus[]> {
      const res = await callJson<{ bots: BotContainerStatus[] } | BotContainerStatus[]>({
        method: "GET",
        path: "/bots",
      });
      return Array.isArray(res) ? res : res.bots;
    },

    async templateDrift(spec: BotContainerSpec): Promise<boolean> {
      const res = await callJson<{ drift: boolean }>({
        method: "POST",
        path: `/bots/${encodeURIComponent(spec.botKey)}/template-drift`,
        body: { spec },
      });
      return res.drift === true;
    },

    async create(spec: BotContainerSpec): Promise<void> {
      await callVoid({ method: "POST", path: "/bots", body: { spec } });
    },

    async recreate(spec: BotContainerSpec): Promise<void> {
      await callVoid({ method: "POST", path: `/bots/${encodeURIComponent(spec.botKey)}/recreate`, body: { spec } });
    },

    async writeProfile(botKey: string, profile: CompiledProfile): Promise<void> {
      await callVoid({
        method: "PUT",
        path: `/bots/${encodeURIComponent(botKey)}/profile`,
        body: { profile },
        timeoutMs: START_TIMEOUT_MS,
      });
    },

    async start(botKey: string): Promise<void> {
      await callVoid({ method: "POST", path: `/bots/${encodeURIComponent(botKey)}/start`, timeoutMs: START_TIMEOUT_MS });
    },

    async restart(botKey: string): Promise<void> {
      await callVoid({ method: "POST", path: `/bots/${encodeURIComponent(botKey)}/restart`, timeoutMs: START_TIMEOUT_MS });
    },

    async stop(botKey: string): Promise<void> {
      await callVoid({
        method: "POST",
        path: `/bots/${encodeURIComponent(botKey)}/stop`,
        timeoutMs: START_TIMEOUT_MS,
      });
    },
  };
}
