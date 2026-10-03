// server/src/myrmidon/foraging/reader.ts
//
// myrmidon(1.6-FORAGE): the only place the sweep talks to the outside world.
//
// An automatic, repeating call to a third-party host carries rules of its own
// (docs/myrmidon, and the fleet's own external-call discipline): a pause between
// two reads of the same host, an honest User-Agent, and a breaker that stops the
// host after repeated failures instead of hammering it every pass. All three live
// here, on module state shared by every pass and every company of the process, so
// two agents of two companies pointing at one host cannot double the rate.
//
// The read itself is plain `fetch`: the URL is the registry row's, the token (if
// the instance named a secret) is a bearer header. The answer is capped at
// `MAX_SOURCE_BYTES`; a larger answer is cut, not rejected — the point of a pass
// is a comparable snapshot, not a full mirror.

import { createHash } from "node:crypto";
import { logger } from "../../middleware/logger.js";
import { MAX_SOURCE_BYTES } from "./domain.js";
import type { ForagingReader, ForagingReaderResult } from "./service.js";
import type { ForagingSourceRef } from "./domain.js";

/** The breaker: after this many consecutive failures a host is left alone. */
export const BREAKER_FAILURE_THRESHOLD = 2;
/** How long the breaker stays open, in milliseconds. */
export const BREAKER_OPEN_MS = 6 * 60 * 60 * 1000;
/** How long one read may take, in milliseconds. */
export const READ_TIMEOUT_MS = 15_000;
/** The tool name and contact the host sees; a host must know who is knocking. */
export const FORAGING_USER_AGENT = "myrmidon-foraging/1.0 (+https://github.com/itkadr-git/myrmidon)";

interface HostState {
  lastReadAt: number;
  failures: number;
  openUntil: number;
}

/** Shared by every pass of this process: the rate limit and the breaker. */
const hostStates = new Map<string, HostState>();

/** Test hook: forget every host's pause and breaker. */
export function resetForagingHostState(): void {
  hostStates.clear();
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return url;
  }
}

function stateOf(host: string): HostState {
  let state = hostStates.get(host);
  if (!state) {
    state = { lastReadAt: 0, failures: 0, openUntil: 0 };
    hostStates.set(host, state);
  }
  return state;
}

/** Thrown when the breaker is open; the pass records it as the source's error. */
export class ForagingHostPausedError extends Error {
  constructor(host: string) {
    super(`foraging: host ${host} is paused after repeated failures`);
    this.name = "ForagingHostPausedError";
  }
}

/** Thrown when two reads of one host would be closer than the pause. */
export class ForagingHostThrottledError extends Error {
  constructor(host: string) {
    super(`foraging: host ${host} was read less than the minimum interval ago`);
    this.name = "ForagingHostThrottledError";
  }
}

export interface ForagingReaderDeps {
  env?: NodeJS.ProcessEnv;
  minHostIntervalMs: number;
  /** Resolves the read token for a company, or null when none is configured. */
  readKey?: (companyId: string, secretName: string | null) => Promise<string | null>;
  now?: () => number;
  fetchImpl?: typeof fetch;
  log?: Pick<typeof logger, "warn" | "error">;
}

/** The production reader: `fetch` under the host rules above. */
export function createForagingReader(deps: ForagingReaderDeps): ForagingReader {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? logger;

  return {
    async read(source: ForagingSourceRef, signal: AbortSignal): Promise<ForagingReaderResult> {
      const host = hostOf(source.url);
      const state = stateOf(host);
      const at = now();
      if (state.openUntil > at) throw new ForagingHostPausedError(host);
      if (at - state.lastReadAt < deps.minHostIntervalMs) {
        throw new ForagingHostThrottledError(host);
      }
      state.lastReadAt = at;

      const key = deps.readKey && source.companyId
        ? await deps.readKey(source.companyId, deps.env?.MYRMIDON_FORAGING_KEY_SECRET?.trim() || null)
        : null;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
      if (typeof timer.unref === "function") timer.unref();
      signal.addEventListener("abort", () => controller.abort(), { once: true });

      try {
        const response = await fetchImpl(source.url, {
          method: "GET",
          redirect: "follow",
          headers: {
            accept: "text/plain, text/markdown, text/html;q=0.8, */*;q=0.5",
            "user-agent": FORAGING_USER_AGENT,
            ...(key ? { authorization: `Bearer ${key}` } : {}),
          },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`source answered ${response.status}`);
        const body = await response.text();
        // A snapshot is compared by content; a body over the cap is cut and the
        // cut is visible in the hash the caller never sees — kept simple here.
        const cut = body.length > MAX_SOURCE_BYTES ? body.slice(0, MAX_SOURCE_BYTES) : body;
        state.failures = 0;
        return { text: cut, bytes: cut.length };
      } catch (err) {
        state.failures += 1;
        if (state.failures >= BREAKER_FAILURE_THRESHOLD) {
          state.openUntil = now() + BREAKER_OPEN_MS;
          log.warn(
            { host, failures: state.failures, openUntil: state.openUntil },
            "foraging: host breaker opened after repeated failures",
          );
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** A stable fingerprint of a snapshot; handy for logs and dedup in tests. */
export function snapshotFingerprint(lines: readonly string[]): string {
  return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16);
}