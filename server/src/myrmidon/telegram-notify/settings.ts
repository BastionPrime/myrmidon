// myrmidon(TG-NOTIFY-D): topic-inbound settings reader for the Telegram
// group-topics bridge (part D of the 1.6.1 TG-NOTIFY-SETTINGS epic).
//
// The settings contract itself is owned by the shared module
// `packages/shared/src/myrmidon-telegram-notify.ts` (merged with part E of
// the epic: the full `telegramNotify` document schema and defaults, every
// surface OFF). Part A owns the GET/PATCH routes; until they merge, the
// document is read through the same instance-settings seam part E uses —
// the `telegramNotify` key of `instance_settings.experimental` — so both
// parts read one row without a migration.
//
// This module is read-only by design: part D only consumes the `inbound`
// area. Tests seed the document directly (the part-A area is mocked until
// it merges, per the epic's continuation convention).

import { eq } from "drizzle-orm";
import { instanceSettings, type Db } from "@paperclipai/db";
// myrmidon(TG-NOTIFY-D): the shared TG-NOTIFY settings contract.
import {
  defaultTelegramNotifySettings,
  telegramNotifySettingsSchema,
} from "@paperclipai/shared";

/** The `inbound` sub-settings of the shared TG-NOTIFY contract. */
export interface TelegramNotifyInboundSettings {
  enabled: boolean;
  requireMention: boolean;
}

export const DEFAULT_TELEGRAM_NOTIFY_INBOUND: TelegramNotifyInboundSettings = {
  enabled: false,
  requireMention: true,
};

const SINGLETON_KEY = "default";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse a stored `telegramNotify.inbound` document against the shared
 * contract, filling every absent or invalid field with the safe (OFF)
 * default. Tolerant by design: a partial or hand-edited row must never turn
 * inbound on by accident.
 */
export function parseTelegramNotifyInbound(
  raw: unknown,
): TelegramNotifyInboundSettings {
  if (!isRecord(raw)) return { ...DEFAULT_TELEGRAM_NOTIFY_INBOUND };
  const inbound = isRecord(raw.inbound) ? raw.inbound : {};
  return {
    enabled: inbound.enabled === true,
    requireMention:
      typeof inbound.requireMention === "boolean"
        ? inbound.requireMention
        : DEFAULT_TELEGRAM_NOTIFY_INBOUND.requireMention,
  };
}

/**
 * Read the `inbound` area through the part-E seam: the `telegramNotify`
 * key of `instance_settings.experimental`. `null` means no stored document
 * — every surface is OFF (the 1.6.1 release criterion).
 */
export async function readTelegramNotifyInbound(
  db: Pick<Db, "select">,
): Promise<TelegramNotifyInboundSettings> {
  const row = await db
    .select({ experimental: instanceSettings.experimental })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
    .then((rows) => rows[0] ?? null);
  if (!row) return { ...DEFAULT_TELEGRAM_NOTIFY_INBOUND };
  const stored = isRecord(row.experimental)
    ? (row.experimental as Record<string, unknown>)["telegramNotify"]
    : undefined;
  if (!isRecord(stored)) return { ...DEFAULT_TELEGRAM_NOTIFY_INBOUND };
  // Normalize through the shared contract first: defaults fill the areas
  // the stored document does not carry yet.
  const parsed = telegramNotifySettingsSchema.safeParse({
    ...defaultTelegramNotifySettings(),
    ...stored,
    inbound: {
      ...defaultTelegramNotifySettings().inbound,
      ...(isRecord(stored.inbound) ? stored.inbound : {}),
    },
  });
  if (!parsed.success) return { ...DEFAULT_TELEGRAM_NOTIFY_INBOUND };
  return {
    enabled: parsed.data.inbound.enabled,
    requireMention: parsed.data.inbound.requireMention,
  };
}