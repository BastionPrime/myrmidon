// myrmidon(1.6-TG-NOTIFY-C): the settings read path of the errors channel.

// The umbrella contract stores the whole telegramNotify area under
// instance_settings.general (part A owns the store, the routes and the
// changelog; the key name `telegramNotify` is fixed by the contract).
// Until part A lands, this adapter is the only reader: it reads the raw
// general row the same way the stack-registry and autonomy stores do
// (their own key, read directly, never through the vendor settings
// service that strips unknown keys) and parses just the `errors` block
// with the shared schema. Absent key → the safe default: the channel is
// OFF, which is the release criterion for 1.6.1.

// When part A merges, it becomes the writer of this key; this reader
// stays valid unchanged (same key, same schema).

import { eq } from "drizzle-orm";
import { instanceSettings, type Db } from "@paperclipai/db";
import { parseTelegramNotifyErrors, type TelegramNotifyErrorsSettings } from "@paperclipai/shared";
import type { ErrorChannelSettings } from "./errors.js";

/** instance_settings.general key of the telegramNotify contract (fixed by the umbrella task). */
export const TELEGRAM_NOTIFY_GENERAL_KEY = "telegramNotify";

const SINGLETON_KEY = "default";

/** Keep the telegramNotify area across vendor writes of instance_settings.general. */
export function preserveTelegramNotifyGeneralKey(storedGeneral: unknown): Record<string, unknown> {
  if (typeof storedGeneral !== "object" || storedGeneral === null) return {};
  const value = (storedGeneral as Record<string, unknown>)[TELEGRAM_NOTIFY_GENERAL_KEY];
  return value === undefined ? {} : { [TELEGRAM_NOTIFY_GENERAL_KEY]: value };
}

type Runner = Pick<Db, "select">;

export async function readTelegramNotifyErrors(db: Runner): Promise<TelegramNotifyErrorsSettings> {
  const row = await db
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
    .then((rows) => rows[0] ?? null);
  const area = (row?.general as Record<string, unknown> | null | undefined)?.[TELEGRAM_NOTIFY_GENERAL_KEY];
  const errors = typeof area === "object" && area !== null
    ? (area as Record<string, unknown>).errors
    : undefined;
  return parseTelegramNotifyErrors(errors);
}

/**
 * The production settings source of the errors channel: one row read per
 * company sweep, safe default when the area is absent.
 */
export function dbErrorChannelSettingsSource(db: Runner): {
  read(companyId: string): Promise<ErrorChannelSettings>;
} {
  // instance settings are instance-scoped, but the source is shaped
  // per-company (the contract models per-company chat targets) so part A
  // can move storage to a company-scoped key without touching consumers.
  return {
    read: async (_companyId: string) => readTelegramNotifyErrors(db),
  };
}