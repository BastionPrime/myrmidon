// myrmidon(BROWSER-CONSOLE): the service.
//
// State lives in instance_settings.general under our own key (the same rule
// as maintenance mode, R3): the registry is read from MYRMIDON_BROWSER_FLEET
// env on every call (an operator edits it by restarting with a new value —
// the registry is configuration, not data), while OPEN SESSIONS and the
// JOURNAL are runtime state that must survive a restart.
//
// The vendor's updateGeneral strips unknown keys, so this module reads and
// writes the raw row itself (store.ts) exactly like maintenance/store.ts.
//
// Bot pause, two contours:
//   1. contract: client.pauseBots(browserId) on open, client.resumeBots on close;
//   2. server guard: assertBrowserScreenFreeForMcp() rejects MCP tool calls
//      aimed at the browser while a session is open.

import { randomUUID } from "node:crypto";
import { parseBrowserFleet, type BrowserFleetEntry } from "@paperclipai/shared/myrmidon-browser-console";
import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { autoCloseReason, readBrowserConsoleTimers, sessionDeadlines, type BrowserConsoleTimers } from "./timers.js";
import type { ScreenConsoleClient, ScreenConsoleOpenResult } from "./screen-console-client.js";
import {
  readBrowserSessionDocument,
  mutateBrowserSessionDocument,
  type BrowserSessionDocument,
  type BrowserSessionRecord,
} from "./store.js";

export type { BrowserSessionRecord } from "./store.js";

const JOURNAL_LIMIT = 50;

export interface BrowserSessionServiceDeps {
  db: Db;
  client: ScreenConsoleClient;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  newSessionId?: () => string;
  log?: Pick<typeof logger, "warn" | "error">;
}

export interface OpenScreenInput {
  browserId: string;
  userId: string;
}

export interface OpenScreenResult {
  screenSessionId: string;
  screenPath: string;
  deadlines: ReturnType<typeof sessionDeadlines>;
}

export class BrowserConsoleError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 423 | 502,
    message: string,
  ) {
    super(message);
  }
}

export function browserConsoleService(deps: BrowserSessionServiceDeps) {
  const now = deps.now ?? (() => Date.now());
  const env = deps.env ?? process.env;
  const log = deps.log ?? logger;
  const timers: BrowserConsoleTimers = readBrowserConsoleTimers(env);
  const newSessionId = deps.newSessionId ?? (() => randomUUID());

  function fleet(): BrowserFleetEntry[] {
    const parsed = parseBrowserFleet(env.MYRMIDON_BROWSER_FLEET);
    if (!parsed.ok) {
      log.warn(`browser console: ${parsed.error}; the registry is empty until it is fixed`);
      return [];
    }
    return parsed.browsers;
  }

  function browserOrThrow(browserId: string): BrowserFleetEntry {
    const found = fleet().find((entry) => entry.id === browserId);
    if (!found) throw new BrowserConsoleError(404, "Browser not found");
    return found;
  }

  function deadlinesOf(record: BrowserSessionRecord) {
    const deadlines = sessionDeadlines({ openedAt: record.openedAt, lastActivityAt: record.lastActivityAt, timers });
    return { deadlines, reason: autoCloseReason({ deadlines, now: now() }) };
  }

  /** Close the session record, journal it, then best-effort release the node. */
  async function closeSession(record: BrowserSessionRecord, closedBy: "done" | "idle_timeout" | "max_duration"): Promise<void> {
    await mutateBrowserSessionDocument(deps.db, (current) => {
      if (!current.sessions[record.sessionId]) return { next: null, result: undefined };
      const sessions = { ...current.sessions };
      delete sessions[record.sessionId];
      const endedAt = now();
      const entry = {
        sessionId: record.sessionId,
        browserId: record.browserId,
        userId: record.userId,
        openedAt: record.openedAt,
        endedAt,
        durationMs: endedAt - record.openedAt,
        closedBy,
      };
      return { next: { version: 1 as const, sessions, journal: [entry, ...current.journal].slice(0, JOURNAL_LIMIT) }, result: undefined };
    });
    // Node release and bot resume happen after the state is updated: a lost
    // call leaves the node session to its own timeout and the server guard no
    // longer holds — the same end state as the owner pressing Done.
    try {
      await deps.client.done(record.screenSessionId);
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err), browserId: record.browserId }, "browser console: screen node done() failed");
    }
    try {
      await deps.client.resumeBots(record.browserId);
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err), browserId: record.browserId }, "browser console: screen node resumeBots() failed");
    }
  }

  async function findSession(browserId: string): Promise<BrowserSessionRecord | null> {
    const doc = await readBrowserSessionDocument(deps.db);
    return Object.values(doc.sessions).find((session) => session.browserId === browserId) ?? null;
  }

  /** Expire the session if a deadline has passed; returns the live record otherwise. */
  async function liveSession(browserId: string): Promise<BrowserSessionRecord | null> {
    const record = await findSession(browserId);
    if (!record) return null;
    const { reason } = deadlinesOf(record);
    if (reason) {
      await closeSession(record, reason);
      return null;
    }
    return record;
  }

  return {
    fleet,
    timers,

    async listBrowsers() {
      const doc = await readBrowserSessionDocument(deps.db);
      const byBrowser = new Map(Object.values(doc.sessions).map((session) => [session.browserId, session]));
      return fleet().map((entry) => {
        const session = byBrowser.get(entry.id) ?? null;
        return {
          id: entry.id,
          displayName: entry.displayName,
          egress: entry.egress,
          sessionActive: session !== null,
          usedBy: session?.userId ?? null,
          sessionStartedAt: session ? new Date(session.openedAt).toISOString() : null,
        };
      });
    },

    async openScreen(input: OpenScreenInput): Promise<OpenScreenResult> {
      browserOrThrow(input.browserId);
      if (await findSession(input.browserId)) {
        throw new BrowserConsoleError(409, "A screen session is already open for this browser");
      }

      let opened: ScreenConsoleOpenResult;
      try {
        opened = await deps.client.open(input.browserId);
      } catch {
        throw new BrowserConsoleError(502, "The screen node did not answer");
      }
      // The contract contour of the bot pause: bots must not drive the browser
      // while the owner is on the screen.
      try {
        await deps.client.pauseBots(input.browserId);
      } catch {
        // Roll the node session back so nothing stays half-open.
        await deps.client.done(opened.screenSessionId).catch(() => {});
        throw new BrowserConsoleError(502, "The screen node could not pause the bots");
      }

      const openedAt = now();
      const sessionId = newSessionId();
      const record: BrowserSessionRecord = {
        sessionId,
        browserId: input.browserId,
        userId: input.userId,
        screenSessionId: opened.screenSessionId,
        openedAt,
        lastActivityAt: openedAt,
      };
      const { result: conflict } = await mutateBrowserSessionDocument(deps.db, (current) => {
        if (Object.values(current.sessions).some((session) => session.browserId === input.browserId)) {
          return { next: null, result: true };
        }
        return { next: { version: 1 as const, sessions: { ...current.sessions, [sessionId]: record }, journal: current.journal }, result: false };
      });
      if (conflict) {
        await deps.client.done(opened.screenSessionId).catch(() => {});
        await deps.client.resumeBots(input.browserId).catch(() => {});
        throw new BrowserConsoleError(409, "A screen session is already open for this browser");
      }

      const deadlines = sessionDeadlines({ openedAt, lastActivityAt: openedAt, timers });
      return { screenSessionId: sessionId, screenPath: `/api/myrmidon/browsers/${encodeURIComponent(input.browserId)}/screen`, deadlines };
    },

    async status(browserId: string): Promise<{ record: BrowserSessionRecord; deadlines: ReturnType<typeof sessionDeadlines> } | null> {
      const record = await liveSession(browserId);
      if (!record) return null;
      return { record, deadlines: deadlinesOf(record).deadlines };
    },

    async heartbeat(browserId: string, userId: string, activity: boolean): Promise<{ deadlines: ReturnType<typeof sessionDeadlines>; closedBy: string | null }> {
      const record = await liveSession(browserId);
      if (!record) return { deadlines: sessionDeadlines({ openedAt: now(), lastActivityAt: now(), timers }), closedBy: "none" };
      if (record.userId !== userId) throw new BrowserConsoleError(403, "The open screen session belongs to another owner");
      const nextActivity = activity ? now() : record.lastActivityAt;
      await mutateBrowserSessionDocument(deps.db, (current) => {
        if (!current.sessions[record.sessionId]) return { next: null, result: undefined };
        return { next: { ...current, sessions: { ...current.sessions, [record.sessionId]: { ...record, lastActivityAt: nextActivity } } }, result: undefined };
      });
      // The node heartbeat is best-effort; the board's own timers decide.
      void deps.client.heartbeat(record.screenSessionId, activity).catch(() => {});
      return { deadlines: sessionDeadlines({ openedAt: record.openedAt, lastActivityAt: nextActivity, timers }), closedBy: null };
    },

    async done(browserId: string, userId: string): Promise<void> {
      const record = await findSession(browserId);
      if (!record) return;
      if (record.userId !== userId) throw new BrowserConsoleError(403, "The open screen session belongs to another owner");
      await closeSession(record, "done");
    },

    async clearSiteData(browserId: string, domain: string): Promise<void> {
      browserOrThrow(browserId);
      if (await findSession(browserId)) {
        throw new BrowserConsoleError(409, "Close the screen session before clearing site data");
      }
      try {
        await deps.client.clearSiteData(browserId, domain);
      } catch {
        throw new BrowserConsoleError(502, "The screen node did not answer");
      }
    },

    async journal(): Promise<BrowserSessionDocument["journal"]> {
      const doc = await readBrowserSessionDocument(deps.db);
      return doc.journal;
    },

    /** The server guard of the bot pause (contour 2). */
    async assertBrowserScreenFreeForMcp(browserId: string): Promise<void> {
      const record = await liveSession(browserId);
      if (!record) return;
      throw new BrowserConsoleError(423, "An owner screen session is open on this browser; MCP calls are paused");
    },
  };
}

export type BrowserConsoleService = ReturnType<typeof browserConsoleService>;
