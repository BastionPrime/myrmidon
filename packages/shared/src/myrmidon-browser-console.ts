// myrmidon(BROWSER-CONSOLE): shared contracts of the live browser screen console.
// The screen node itself is a separate deployment (x11vnc + websockify); the
// board only holds the registry, the session timers, the bot pause contract
// and the journal. English-only copy, neutral test data only.

import { z } from "zod";

/** Registry entry of one live browser, read from MYRMIDON_BROWSER_FLEET. */
export interface BrowserFleetEntry {
  id: string;
  displayName: string;
  /** Egress route labels the operator configured (e.g. { ru: "socks ru1" }). */
  egress: Record<string, string>;
}

/** What the fleet list returns per browser: the registry entry plus live session state. */
export interface BrowserConsoleStatus {
  id: string;
  displayName: string;
  egress: Record<string, string>;
  /** An owner's screen session is open on this browser right now. */
  sessionActive: boolean;
  /** Who holds the open session (board user id); null when no session. */
  usedBy: string | null;
  /** When the open session started (ISO); null when no session. */
  sessionStartedAt: string | null;
}

/** Session lifecycle as the board sees it. */
export type BrowserSessionCloseReason = "done" | "idle_timeout" | "max_duration" | "server_restart";

export interface BrowserSessionJournalEntry {
  sessionId: string;
  browserId: string;
  /** Who opened the screen (board user id). */
  userId: string;
  /** ISO timestamp of open. */
  startedAt: string;
  /** ISO timestamp of close; null while the session is still open. */
  endedAt: string | null;
  /** Milliseconds the session stayed open; null while open. */
  durationMs: number | null;
  /** Why the session closed. */
  closedBy: BrowserSessionCloseReason | null;
}

/** POST /api/myrmidon/browsers/:id/screen/open response. */
export interface BrowserScreenOpenResponse {
  screenSessionId: string;
  /** WebSocket path on the board that proxies to the screen node. */
  screenPath: string;
  /** When the session will auto-close if no activity arrives (ISO). */
  idleDeadlineAt: string;
  /** Hard ceiling of the session regardless of activity (ISO). */
  maxDeadlineAt: string;
  /** Earliest moment the auto-close warning should show (ISO; 60s before the deadline). */
  warnAt: string;
}

/** POST /api/myrmidon/browsers/:id/screen/heartbeat response (also the session status). */
export interface BrowserScreenStatusResponse {
  screenSessionId: string;
  active: boolean;
  idleDeadlineAt: string;
  maxDeadlineAt: string;
  /** When the auto-close warning starts (ISO). */
  warnAt: string;
  /** ISO moment the session will actually close: the nearer of the two deadlines. */
  autoCloseAt: string;
  /** Present when the session just closed by a timer (the UI shows why). */
  closedBy: BrowserSessionCloseReason | null;
}

/** Request bodies. */
export const browserScreenHeartbeatSchema = z
  .object({
    /** Whether the user actually did something (mouse, keys); false is a bare keep-alive. */
    activity: z.boolean().default(false),
  })
  .strict();

export const browserSiteDataDeleteSchema = z
  .object({
    /** Bare domain, e.g. example.com. Validated, never a URL. */
    domain: z
      .string()
      .trim()
      .min(1)
      .max(253)
      .regex(/^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i, {
        message: "domain must be a bare domain like example.com",
      }),
  })
  .strict();

/** MYRMIDON_BROWSER_FLEET parsing (server side; shared so tests agree). */
export const browserFleetEntrySchema = z.object({
  id: z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/, {
    message: "browser id must be lowercase slug",
  }),
  displayName: z.string().trim().min(1).max(120),
  egress: z.record(z.string(), z.string().trim().min(1).max(120)).default({}),
});

export const BROWSER_FLEET_MAX_ENTRIES = 16;
export const BROWSER_FLEET_MAX_EGRESS_KEYS = 8;

export const browserFleetSchema = z.array(browserFleetEntrySchema).max(BROWSER_FLEET_MAX_ENTRIES);

/** Parse MYRMIDON_BROWSER_FLEET; returns null on absent/empty/invalid input. */
export function parseBrowserFleet(raw: string | undefined): { ok: true; browsers: BrowserFleetEntry[] } | { ok: false; error: string } {
  const text = raw?.trim();
  if (!text) return { ok: true, browsers: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "MYRMIDON_BROWSER_FLEET is not valid JSON" };
  }
  if (!Array.isArray(parsed)) return { ok: false, error: "MYRMIDON_BROWSER_FLEET must be a JSON array" };
  for (const entry of parsed) {
    if (typeof entry === "object" && entry !== null) {
      const egress = (entry as { egress?: unknown }).egress;
      if (egress !== undefined && (!egress || typeof egress !== "object" || Array.isArray(egress))) {
        return { ok: false, error: "MYRMIDON_BROWSER_FLEET entry egress must be an object" };
      }
      if (egress && typeof egress === "object" && Object.keys(egress as object).length > BROWSER_FLEET_MAX_EGRESS_KEYS) {
        return { ok: false, error: `MYRMIDON_BROWSER_FLEET entry egress has more than ${BROWSER_FLEET_MAX_EGRESS_KEYS} keys` };
      }
    }
  }
  const fleet = browserFleetSchema.safeParse(parsed);
  if (!fleet.success) {
    return { ok: false, error: `MYRMIDON_BROWSER_FLEET entry invalid: ${fleet.error.issues[0]?.message ?? "schema"}` };
  }
  const ids = new Set<string>();
  for (const entry of fleet.data) {
    if (ids.has(entry.id)) return { ok: false, error: `MYRMIDON_BROWSER_FLEET has a duplicate id ${entry.id}` };
    ids.add(entry.id);
  }
  return { ok: true, browsers: fleet.data };
}
