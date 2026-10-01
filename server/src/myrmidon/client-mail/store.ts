// server/src/myrmidon/client-mail/store.ts
//
// myrmidon(EXTCASE-M): where the mail settings of the client companies live, and
// the ledger the pipeline remembers processed messages in.
//
// Settings follow the fork's established pattern for our keys of
// `instance_settings.general` (the maintenance and stack-registry stores): the
// vendor settings service strips unknown keys, so this module reads and writes
// the raw row itself under a row lock, and `instance-settings.ts` preserves the
// key across every vendor general write. The entries are per company inside the
// key — one client company cannot read or change another's folders, categories,
// rules or fallback.
//
// The ledger is the company's own activity journal, and that is deliberate: the
// pipeline must journal every decided message anyway, and the row it writes
// (`entity_type = client_mail_item`, `entity_id = <messageId>`) *is* the record
// that the message was handled. A second table would be a second truth to keep in
// sync and therefore a second way for a channel reconnect to move a message
// twice. The consequence is the write order in the pipeline: the message is
// decided, then the ledger row is written, and only after that is the next item
// of the batch started — a crash in between loses nothing but the decision, and
// the message is simply decided again on the next delivery.

import { and, eq, inArray, sql } from "drizzle-orm";
import { activityLog, instanceSettings, type Db } from "@paperclipai/db";
import {
  CLIENT_MAIL_JOURNAL_ACTIONS,
  clientMailCompanySettings,
  normalizeClientMailSettings,
  type ClientMailCompanySettings,
  type ClientMailCompanySettingsPatch,
  type ClientMailSettings,
} from "@paperclipai/shared";
import type { ClientMailJournalEntry, ClientMailLedger } from "./pipeline.js";
import { CLIENT_MAIL_ACTOR_ID, type ClientMailLedgerRow } from "./routes.js";

export const CLIENT_MAIL_GENERAL_KEY = "clientMail";
const SINGLETON_KEY = "default";

type Runner = Pick<Db, "select" | "insert" | "update">;

/** The stored mail settings of every client company. A broken entry falls back to the default. */
export async function readClientMailSettings(db: Runner): Promise<ClientMailSettings> {
  const row = await db
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
    .then((rows) => rows[0] ?? null);
  return normalizeClientMailSettings(row?.general?.[CLIENT_MAIL_GENERAL_KEY]);
}

/** Overwrite the whole mail settings object under a row lock. */
export async function writeClientMailSettings(db: Db, next: ClientMailSettings): Promise<ClientMailSettings> {
  return db.transaction(async (tx) => {
    await tx
      .insert(instanceSettings)
      .values({ singletonKey: SINGLETON_KEY, general: {}, experimental: {} })
      .onConflictDoNothing({ target: [instanceSettings.singletonKey] });
    const row = await tx
      .select({ id: instanceSettings.id })
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
      .for("update")
      .then((rows) => rows[0]!);
    await tx
      .update(instanceSettings)
      .set({
        general: sql`jsonb_set(coalesce(${instanceSettings.general}, '{}'::jsonb), ${`{${CLIENT_MAIL_GENERAL_KEY}}`}::text[], ${JSON.stringify(next)}::jsonb, true)`,
      })
      .where(eq(instanceSettings.id, row.id));
    return next;
  });
}

/**
 * Writes one company's entry, keeping every other company's untouched.
 *
 * The patch replaces only the keys it names, so two operators saving different
 * parts of one client (folders here, rules there) do not overwrite each other's
 * work the way a whole-object write would.
 */
export async function patchClientMailCompanySettings(
  db: Db,
  companyId: string,
  patch: ClientMailCompanySettingsPatch,
): Promise<ClientMailCompanySettings> {
  const current = await readClientMailSettings(db);
  const merged: ClientMailCompanySettings = { ...clientMailCompanySettings(current, companyId) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    (merged as Record<string, unknown>)[key] = value;
  }
  await writeClientMailSettings(db, { companies: { ...current.companies, [companyId]: merged } });
  return merged;
}

/** Carry our key over a vendor write of `instance_settings.general`. */
export function preserveClientMailGeneralKey(storedGeneral: unknown): Record<string, unknown> {
  if (typeof storedGeneral !== "object" || storedGeneral === null) return {};
  const value = (storedGeneral as Record<string, unknown>)[CLIENT_MAIL_GENERAL_KEY];
  return value === undefined ? {} : { [CLIENT_MAIL_GENERAL_KEY]: value };
}

/**
 * The ledger over the board's activity journal.
 *
 * `has` is what the pipeline asks first, so a re-delivered message is skipped
 * without a second model call, a second recognition or a second board task. The
 * key is `(companyId, entityId)`: the same message id may legitimately exist in
 * two client companies' mailboxes, and the two must not shadow each other.
 *
 * `readClientMailLedger` returns the stored rows' details, which is what makes
 * the idempotency visible from the panel: an operator can see how a message was
 * decided without opening the client's mailbox.
 */
const LEDGER_ACTIONS = [
  CLIENT_MAIL_JOURNAL_ACTIONS.itemClassified,
  CLIENT_MAIL_JOURNAL_ACTIONS.itemSkipped,
] as const;

export function createDbClientMailLedger(db: Db): ClientMailLedger {
  return {
    async has(companyId, messageId) {
      const row = await db
        .select({ id: activityLog.id })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, companyId),
            eq(activityLog.entityType, "client_mail_item"),
            eq(activityLog.entityId, messageId),
            inArray(activityLog.action, [...LEDGER_ACTIONS]),
          ),
        )
        .then((rows) => rows[0] ?? null);
      return row !== null;
    },
    async record(companyId, entry: ClientMailJournalEntry) {
      await db.insert(activityLog).values({
        companyId,
        actorType: "system",
        actorId: CLIENT_MAIL_ACTOR_ID,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        // Metadata only by construction: the entry is built from a decision, a
        // rule trace and counts — a message body or a subject never reaches it.
        details: entry.details,
      });
    },
  };
}

/** The ledger rows of one message, for the panel. */
export async function readClientMailLedger(
  db: Db,
  companyId: string,
  entityIds: string[],
): Promise<ClientMailLedgerRow[]> {
  if (entityIds.length === 0) return [];
  const rows = await db
    .select({
      entityId: activityLog.entityId,
      action: activityLog.action,
      details: activityLog.details,
      createdAt: activityLog.createdAt,
    })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.entityType, "client_mail_item"),
        inArray(activityLog.entityId, entityIds),
      ),
    );
  return rows.map((row) => ({
    entityId: row.entityId,
    action: row.action,
    details: (row.details ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt,
  }));
}