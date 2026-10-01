// myrmidon(R5-B): storage for the bot image canary — the `myrmidonBotCanary`
// key of instance_settings.general, the same pattern the maintenance mode (R3)
// and the board self-deploy (R5-A) use. The vendor settings service strips
// unknown keys, so this module reads and writes the raw row itself and
// instance-settings.ts carries the key over a vendor write (see
// preserveBotCanaryGeneralKey and the myrmidon(R5-B) call site there).

import { eq, sql } from "drizzle-orm";
import { instanceSettings, type Db } from "@paperclipai/db";
import { parseBotCanaryDocument, type BotCanaryDocument } from "./canary-domain.js";

export const BOT_CANARY_GENERAL_KEY = "myrmidonBotCanary";
const SINGLETON_KEY = "default";

type Runner = Pick<Db, "select">;

export async function readBotCanaryDocument(db: Runner): Promise<BotCanaryDocument> {
  const row = await db
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
    .then((rows) => rows[0] ?? null);
  return parseBotCanaryDocument(row?.general?.[BOT_CANARY_GENERAL_KEY]);
}

/**
 * Read-modify-write the document under a row lock. `change` returns the next
 * document (or null to leave it as is) and a value handed back to the caller.
 */
export async function mutateBotCanaryDocument<T>(
  db: Db,
  change: (current: BotCanaryDocument) => { next: BotCanaryDocument | null; result: T },
): Promise<{ doc: BotCanaryDocument; result: T; changed: boolean }> {
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
    const current = parseBotCanaryDocument(row.general?.[BOT_CANARY_GENERAL_KEY]);
    const { next, result } = change(current);
    if (!next) return { doc: current, result, changed: false };
    await tx
      .update(instanceSettings)
      .set({
        general: sql`jsonb_set(coalesce(${instanceSettings.general}, '{}'::jsonb), ${`{${BOT_CANARY_GENERAL_KEY}}`}::text[], ${JSON.stringify(next)}::jsonb, true)`,
      })
      .where(eq(instanceSettings.id, row.id));
    return { doc: next, result, changed: true };
  });
}

/** Carry our key over a vendor write of instance_settings.general. */
export function preserveBotCanaryGeneralKey(storedGeneral: unknown): Record<string, unknown> {
  if (typeof storedGeneral !== "object" || storedGeneral === null) return {};
  const value = (storedGeneral as Record<string, unknown>)[BOT_CANARY_GENERAL_KEY];
  return value === undefined ? {} : { [BOT_CANARY_GENERAL_KEY]: value };
}
