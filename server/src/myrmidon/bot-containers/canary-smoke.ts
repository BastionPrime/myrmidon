// server/src/myrmidon/bot-containers/canary-smoke.ts
//
// myrmidon(R5-B): the smoke run of a canary. After the canary's container is
// healthy by Docker's own HEALTHCHECK (the image's /health probe), the rollout
// still owes one proof more: the gateway actually serves a run on the NEW
// image's hermes. A health probe does not execute a run — the pinned hermes
// version inside the image could break POST /v1/runs while /health stays
// green (the G4 contract check exists precisely because the pinned version's
// wire behavior is what breaks silently).
//
// So the smoke is one real POST /v1/runs against the canary's gateway, with a
// short input, a dedicated session id and an idempotency key derived from the
// rollout, polled to a terminal status. Failure or timeout is a canary
// failure: the rest of the fleet is not touched.
//
// Which gateway: the bot's card (adapterConfig.apiBaseUrl, synced by
// card-sync.ts to http://myrmidon-bot-<botKey>:8642) — the same address the
// board's own hermes_gateway adapter uses, so the smoke follows the path a
// real run takes. The key is the bot's own API_SERVER_KEY secret; it is read
// by the caller (the service resolves it from the profile ports) and passed
// in — this module never touches the secrets service and never logs the key.
//
// node:http, not fetch: the canary gateway is on the bot network under its
// container name; the board reaches it exactly the way its adapter does, and
// no proxy environment of the server process must apply here.

import http from "node:http";

import { BOT_GATEWAY_PORT, gatewayApiBaseUrl } from "./card-sync.js";

/** The smoke input. Neutral and short: the goal is a full run cycle, not content. */
export const CANARY_SMOKE_INPUT = "Reply with the single word: ok";
/** Session id of the smoke run; separate from any real session on the bot. */
export const CANARY_SMOKE_SESSION_ID = "canary-smoke";

export interface CanarySmokeDeps {
  /** The bot's gateway API key (API_SERVER_KEY). Passed in, never logged. */
  apiKey: string;
  /** Overrides the gateway base URL (default: the card's container address). */
  baseUrl?: string;
  /** Test hook: replaces the HTTP transport. */
  request?: (opts: {
    method: string;
    url: URL;
    headers: Record<string, string>;
    body?: string;
    timeoutMs: number;
  }) => Promise<{ status: number; body: string }>;
  /** Test hook: replaces the delay between status polls. */
  sleep?: (ms: number) => Promise<void>;
}

export type CanarySmokeResult =
  | { ok: true; runId: string; status: string }
  | { ok: false; runId: string | null; status: string | null; reason: string };

/** Statuses hermes' /v1/runs reports that end a run (the adapter's TERMINAL_STATUSES, execute.ts). */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "error",
  "cancelled",
  "canceled",
  "stopped",
  "interrupted",
]);

const HEALTHY_TERMINAL_STATUSES: ReadonlySet<string> = new Set(["completed"]);

function defaultTransport(opts: {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: opts.url.hostname,
        port: opts.url.port === "" ? BOT_GATEWAY_PORT : Number(opts.url.port),
        path: `${opts.url.pathname}${opts.url.search}`,
        method: opts.method,
        headers: opts.headers,
        timeout: opts.timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error(`canary smoke: ${opts.method} ${opts.url.pathname} timed out after ${opts.timeoutMs}ms`));
    });
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One smoke run on the canary's gateway: POST /v1/runs, poll GET /v1/runs/<id>
 * to a terminal status, and report it. `rolloutId` names the idempotency key,
 * so a retried smoke after a crash replays the same remote run instead of
 * creating a second one.
 */
export async function runCanarySmoke(
  botKey: string,
  rolloutId: string,
  opts: { timeoutMs: number; pollIntervalMs?: number; apiKey: string; baseUrl?: string },
  transport: CanarySmokeDeps["request"] = defaultTransport,
  sleep: (ms: number) => Promise<void> = realSleep,
): Promise<CanarySmokeResult> {
  const base = new URL(opts.baseUrl ?? gatewayApiBaseUrl(botKey));
  // Authorization is built from the passed key into a variable header; the key
  // itself never appears in a message or a log line.
  const auth = { Authorization: `Bearer ${opts.apiKey}` };
  const idempotencyKey = `canary-${rolloutId}`;

  let runId: string | null = null;
  const deadline = Date.now() + opts.timeoutMs;

  // --- create the run ---------------------------------------------------------
  let created: { status: number; body: string };
  try {
    created = await transport({
      method: "POST",
      url: new URL("/v1/runs", base),
      headers: {
        ...auth,
        "Content-Type": "application/json",
        Accept: "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({ input: CANARY_SMOKE_INPUT, session_id: CANARY_SMOKE_SESSION_ID }),
      timeoutMs: Math.min(opts.timeoutMs, 60_000),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, runId: null, status: null, reason: `POST /v1/runs failed: ${message}` };
  }
  if (created.status >= 400) {
    return {
      ok: false,
      runId: null,
      status: null,
      reason: `POST /v1/runs answered HTTP ${created.status}: the gateway of the canary refused the smoke run`,
    };
  }
  try {
    const parsed = JSON.parse(created.body) as { run_id?: unknown };
    if (typeof parsed.run_id === "string" && parsed.run_id.length > 0) runId = parsed.run_id;
  } catch {
    // fall through to the runId check below
  }
  if (runId === null) {
    return { ok: false, runId: null, status: null, reason: "POST /v1/runs response did not include a run_id" };
  }

  // --- poll to a terminal status ---------------------------------------------
  for (;;) {
    let statusAnswer: { status: number; body: string };
    try {
      statusAnswer = await transport({
        method: "GET",
        url: new URL(`/v1/runs/${encodeURIComponent(runId)}`, base),
        headers: { ...auth, Accept: "application/json" },
        timeoutMs: Math.min(opts.timeoutMs, 30_000),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, runId, status: null, reason: `GET /v1/runs/${runId} failed: ${message}` };
    }
    if (statusAnswer.status === 404) {
      return { ok: false, runId, status: null, reason: `run ${runId} disappeared from the gateway before finishing` };
    }
    if (statusAnswer.status >= 400) {
      return { ok: false, runId, status: null, reason: `GET /v1/runs/${runId} answered HTTP ${statusAnswer.status}` };
    }
    let runStatus: string | null = null;
    try {
      const parsed = JSON.parse(statusAnswer.body) as { status?: unknown };
      if (typeof parsed.status === "string") runStatus = parsed.status.toLowerCase();
    } catch {
      runStatus = null;
    }
    if (runStatus !== null && TERMINAL_STATUSES.has(runStatus)) {
      if (HEALTHY_TERMINAL_STATUSES.has(runStatus)) {
        return { ok: true, runId, status: runStatus };
      }
      return { ok: false, runId, status: runStatus, reason: `the smoke run ended in '${runStatus}'` };
    }
    if (Date.now() >= deadline) {
      return { ok: false, runId, status: runStatus, reason: `the smoke run did not finish within ${Math.round(opts.timeoutMs / 1000)}s (last status: ${runStatus ?? "<unknown>"})` };
    }
    await sleep(opts.pollIntervalMs ?? 2_000);
  }
}
