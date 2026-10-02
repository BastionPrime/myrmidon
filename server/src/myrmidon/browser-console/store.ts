// myrmidon(BROWSER-CONSOLE): session state storage.
//
// Same rule as maintenance mode (R3): the state lives under our own key of
// instance_settings.general, the vendor settings service strips unknown keys,
// so this module reads and writes the raw row itself. No migrations.

import { eq, sql } from "drizzle-orm";
import { instanceSettings, type Db } from "@paperclipai/db";

export const BROWSER_SESSIONS_GENERAL_KEY = "myrmidonBrowserConsole";

const SINGLETON_KEY = "default";

export interface BrowserSessionRecord {
  sessionId: string;
  browserId: string;
  /** Board user id of the owner who opened the screen. */
  userId: string;
  /** Node-side session handle. */
  screenSessionId: string;
  /** Epoch ms. */
  openedAt: number;
  /** Epoch ms of the last activity heartbeat. */
  lastActivityAt: number;
}

export interface BrowserSessionJournalEntry {
  sessionId: string;
  browserId: string;
  userId: string;
  openedAt: number;
  endedAt: number;
  durationMs: number;
  closedBy: "done" | "idle_timeout" | "max_duration";
}

export interface BrowserSessionDocument {
  version: 1;
  sessions: Record<string, BrowserSessionRecord>;
  journal: BrowserSessionJournalEntry[];
}

export const BROWSER_JOURNAL_LIMIT = 50;

export function emptyBrowserSessionDocument(): BrowserSessionDocument {
  return { version: 1, sessions: {}, journal: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSession(value: unknown): BrowserSessionRecord | null {
  if (!isRecord(value)) return null;
  const { sessionId, browserId, userId, screenSessionId, openedAt, lastActivityAt } = value;
  if (
    typeof sessionId !== "string" || typeof browserId !== "string" || typeof userId !== "string"
    || typeof screenSessionId !== "string" || typeof openedAt !== "number" || typeof lastActivityAt !== "number"
  ) return null;
  return { sessionId, browserId, userId, screenSessionId, openedAt, lastActivityAt };
}

function parseJournalEntry(value: unknown): BrowserSessionJournalEntry | null {
  if (!isRecord(value)) return null;
  const { sessionId, browserId, userId, openedAt, endedAt, durationMs, closedBy } = value;
  if (
    typeof sessionId !== "string" || typeof browserId !== "string" || typeof userId !== "string"
    || typeof openedAt !== "number" || typeof endedAt !== "number" || typeof durationMs !== "number"
    || (closedBy !== "done" && closedBy !== "idle_timeout" && closedBy !== "max_duration")
  ) return null;
  return { sessionId, browserId, userId, openedAt, endedAt, durationMs, closedBy };
}

/** Read defensively: anything malformed reads as an empty document. */
export function parseBrowserSessionDocument(raw: unknown): BrowserSessionDocument {
  if (!isRecord(raw)) return emptyBrowserSessionDocument();
  const sessionsRaw = raw.sessions;
  const sessions: Record<string, BrowserSessionRecord> = {};
  if (isRecord(sessionsRaw)) {
    for (const [key, value] of Object.entries(sessionsRaw)) {
      const parsed = parseSession(value);
      if (parsed) sessions[key] = parsed;
    }
  }
  const journal = Array.isArray(raw.journal)
    ? raw.journal.map(parseJournalEntry).filter((entry): entry is BrowserSessionJournalEntry => entry !== null)
    : [];
  return { version: 1, sessions, journal };
}

type Runner = Pick<Db, "select" | "insert" | "update">;

export async function readBrowserSessionDocument(db: Runner): Promise<BrowserSessionDocument> {
  const row = await db
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
    .then((rows) => rows[0] ?? null);
  return parseBrowserSessionDocument(row?.general?.[BROWSER_SESSIONS_GENERAL_KEY]);
}

/**
 * Read-modify-write under a row lock, like mutateMaintenanceDocument: the
 * change callback sees the current document, returns the next one (or null to
 * keep the stored value).
 */
export async function mutateBrowserSessionDocument<T>(
  db: Db,
  change: (current: BrowserSessionDocument) => { next: BrowserSessionDocument | null; result: T },
): Promise<{ doc: BrowserSessionDocument; result: T; changed: boolean }> {
  return db.transaction(async (tx) => {
    await tx
      .insert(instanceSettings)
      .values({ singletonKey: SINGLETON_KEY, general: {}, experimental: {} })
      .onConflictDoNothing({ target: [instanceSettings.singletonKey] });
    const row = await tx
      .select({ id: instanceSettings.id, general: instanceSettings.general })
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
      .for("update")
      .then((rows) => rows[0]!);
    const current = parseBrowserSessionDocument(row.general?.[BROWSER_SESSIONS_GENERAL_KEY]);
    const { next, result } = change(current);
    if (!next) return { doc: current, result, changed: false };
    await tx
      .update(instanceSettings)
      .set({
        general: sql`jsonb_set(coalesce(${instanceSettings.general}, '{}'::jsonb), ${`{${BROWSER_SESSIONS_GENERAL_KEY}}`}::text[], ${JSON.stringify(next)}::jsonb, true)`,
      })
      .where(eq(instanceSettings.id, row.id));
    return { doc: next, result, changed: true };
  });
}
