// server/src/myrmidon/telegram-notify/store.ts
//
// myrmidon(1.6.1-TG-NOTIFY-B): the per-company job state of the Telegram notify
// track (last digest day, escalation send timestamps). Stored under our own
// key of instance_settings.general — the same rule every myrmidon track uses
// (autonomy, maintenance, stack registry): the vendor settings service strips
// unknown keys, so this module reads and writes the raw row itself and a
// `preserve*GeneralKey` seam keeps the key across vendor general writes. No
// migration: an old image keeps working on the new schema.

import { eq, sql } from "drizzle-orm";
import { instanceSettings, type Db } from "@paperclipai/db";

export const TELEGRAM_NOTIFY_GENERAL_KEY = "myrmidonTelegramNotify";

const SINGLETON_KEY = "default";

/** The persisted shape. Kept intentionally minimal: the digest is a date
 *  stamp, escalations are interaction-id -> last-sent ISO. */
export interface TelegramNotifyDocument {
  version: 1;
  /** UTC date (YYYY-MM-DD) of the last digest sent for this company. */
  lastDigestDate: string | null;
  /** Pending-question interaction id -> ISO timestamp of the last escalation send. */
  escalationSentAt: Record<string, string>;
}

export function emptyTelegramNotifyDocument(): TelegramNotifyDocument {
  return { version: 1, lastDigestDate: null, escalationSentAt: {} };
}

function parseDocument(raw: unknown): TelegramNotifyDocument {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return emptyTelegramNotifyDocument();
  }
  const record = raw as Record<string, unknown>;
  const lastDigestDate =
    typeof record.lastDigestDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(record.lastDigestDate)
      ? record.lastDigestDate
      : null;
  const escalationSentAt: Record<string, string> = {};
  if (typeof record.escalationSentAt === "object" && record.escalationSentAt !== null && !Array.isArray(record.escalationSentAt)) {
    for (const [id, value] of Object.entries(record.escalationSentAt as Record<string, unknown>)) {
      if (typeof value === "string" && !Number.isNaN(Date.parse(value))) {
        escalationSentAt[id] = value;
      }
    }
  }
  return { version: 1, lastDigestDate, escalationSentAt };
}

type Runner = Pick<Db, "select" | "insert" | "update">;

export async function readTelegramNotifyDocument(db: Runner, companyId: string): Promise<TelegramNotifyDocument> {
  const row = await db
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
    .then((rows) => rows[0] ?? null);
  const area = row?.general?.[TELEGRAM_NOTIFY_GENERAL_KEY];
  const perCompany = typeof area === "object" && area !== null && !Array.isArray(area)
    ? (area as Record<string, unknown>)[companyId]
    : undefined;
  return parseDocument(perCompany);
}

/** Read-modify-write under a row lock, scoped to one company inside our area. */
export async function mutateTelegramNotifyDocument<T>(
  db: Db,
  companyId: string,
  change: (current: TelegramNotifyDocument) => { next: TelegramNotifyDocument | null; result: T },
): Promise<{ doc: TelegramNotifyDocument; result: T; changed: boolean }> {
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
    const general = (row.general ?? {}) as Record<string, unknown>;
    const area = typeof general[TELEGRAM_NOTIFY_GENERAL_KEY] === "object"
      && general[TELEGRAM_NOTIFY_GENERAL_KEY] !== null
      ? { ...(general[TELEGRAM_NOTIFY_GENERAL_KEY] as Record<string, unknown>) }
      : {};
    const current = parseDocument(area[companyId]);
    const { next, result } = change(current);
    if (!next) return { doc: current, result, changed: false };
    area[companyId] = next;
    await tx
      .update(instanceSettings)
      .set({
        general: sql`jsonb_set(coalesce(${instanceSettings.general}, '{}'::jsonb), ${`{${TELEGRAM_NOTIFY_GENERAL_KEY}}`}::text[], ${JSON.stringify(area)}::jsonb, true)`,
      })
      .where(eq(instanceSettings.id, row.id));
    return { doc: next, result, changed: true };
  });
}

/** Keep our key across vendor writes of instance_settings.general. */
export function preserveTelegramNotifyGeneralKey(storedGeneral: unknown): Record<string, unknown> {
  if (typeof storedGeneral !== "object" || storedGeneral === null) return {};
  const value = (storedGeneral as Record<string, unknown>)[TELEGRAM_NOTIFY_GENERAL_KEY];
  return value === undefined ? {} : { [TELEGRAM_NOTIFY_GENERAL_KEY]: value };
}
