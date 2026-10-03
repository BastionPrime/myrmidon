// myrmidon(OPE-3789): telegram-notify settings storage (part A).
//
// State lives under our own key of `instance_settings.general`, keyed by
// companyId (the same rule as the autonomy and cloud-connector stores): the
// vendor settings service strips unknown keys, so this module reads and
// writes the raw row itself, under a row lock with `jsonb_set`. No
// migration, and an old image keeps working on the new schema.
//
// The document is company-scoped: `general` is a shared JSON column, so the
// key holds a map `{ [companyId]: document }` and every read/mutate touches
// only the caller's company slice.

import { eq, sql } from "drizzle-orm";
import { instanceSettings, type Db } from "@paperclipai/db";
import {
  parseTelegramNotifyDocument,
  emptyTelegramNotifyDocument,
  TELEGRAM_NOTIFY_GENERAL_KEY,
  type TelegramNotifyDocument,
} from "@paperclipai/shared";

// myrmidon(OPE-3789): re-exported so instance-settings.ts imports the preserve
// helper from this module, the same way the autonomy and cloud-connector
// stores expose theirs.
export { preserveTelegramNotifyGeneralKey } from "@paperclipai/shared";

const SINGLETON_KEY = "default";

type Runner = Pick<Db, "select" | "insert" | "update">;

function companyDocuments(raw: unknown): Record<string, TelegramNotifyDocument> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, TelegramNotifyDocument> = {};
  for (const [companyId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof companyId === "string" && companyId.length > 0) {
      out[companyId] = parseTelegramNotifyDocument(value);
    }
  }
  return out;
}

/** Read one company's document (defaults when nothing was ever stored). */
export async function readTelegramNotifyDocument(db: Runner, companyId: string): Promise<TelegramNotifyDocument> {
  const row = await db
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
    .then((rows) => rows[0] ?? null);
  return companyDocuments(row?.general?.[TELEGRAM_NOTIFY_GENERAL_KEY])[companyId] ?? emptyTelegramNotifyDocument();
}

/**
 * Read-modify-write of one company's slice under a row lock (the maintenance
 * store pattern): the change callback sees the current document and returns
 * the next one (or null to keep the stored value). Other companies' slices
 * and every other key of `general` are preserved byte for byte.
 */
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
    const documents = companyDocuments(row.general?.[TELEGRAM_NOTIFY_GENERAL_KEY]);
    const current = documents[companyId] ?? emptyTelegramNotifyDocument();
    const { next, result } = change(current);
    if (!next) return { doc: current, result, changed: false };
    documents[companyId] = next;
    await tx
      .update(instanceSettings)
      .set({
        general: sql`jsonb_set(coalesce(${instanceSettings.general}, '{}'::jsonb), ${`{${TELEGRAM_NOTIFY_GENERAL_KEY}}`}::text[], ${JSON.stringify(documents)}::jsonb, true)`,
      })
      .where(eq(instanceSettings.id, row.id));
    return { doc: next, result, changed: true };
  });
}

/** The persistence seam: production uses the instance-settings row, tests use memory. */
export interface TelegramNotifyStore {
  read(companyId: string): Promise<TelegramNotifyDocument>;
  mutate<T>(
    companyId: string,
    change: (current: TelegramNotifyDocument) => { next: TelegramNotifyDocument | null; result: T },
  ): Promise<{ doc: TelegramNotifyDocument; result: T; changed: boolean }>;
}

export function dbTelegramNotifyStore(db: Db): TelegramNotifyStore {
  return {
    read: (companyId) => readTelegramNotifyDocument(db, companyId),
    mutate: (companyId, change) => mutateTelegramNotifyDocument(db, companyId, change),
  };
}

/** In-memory store (company-keyed): used by tests and read-only embeddings. */
export function memoryTelegramNotifyStore(
  initial?: Record<string, TelegramNotifyDocument>,
): TelegramNotifyStore {
  const documents = new Map<string, TelegramNotifyDocument>(Object.entries(initial ?? {}));
  return {
    read: async (companyId) => documents.get(companyId) ?? emptyTelegramNotifyDocument(),
    mutate: async (companyId, change) => {
      const current = documents.get(companyId) ?? emptyTelegramNotifyDocument();
      const { next, result } = change(current);
      if (next) documents.set(companyId, next);
      return { doc: next ?? current, result, changed: next !== null };
    },
  };
}
