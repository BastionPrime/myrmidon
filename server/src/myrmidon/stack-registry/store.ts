// Stack registry (SUA): storage — the `myrmidonStack` key of
// instance_settings.general, following the maintenance store pattern
// (row-lock + jsonb_set). The vendor settings service strips unknown keys, so
// this module reads and writes the raw row itself; instance-settings.ts
// preserves the key across vendor general writes.

import { eq, sql } from "drizzle-orm";
import { instanceSettings, type Db } from "@paperclipai/db";
import { parseStackDocument, STACK_GENERAL_KEY, type StackDocument } from "./domain.js";

const SINGLETON_KEY = "default";

type Runner = Pick<Db, "select" | "insert" | "update">;

export async function readStackDocument(db: Runner): Promise<StackDocument> {
  const row = await db
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
    .then((rows) => rows[0] ?? null);
  return parseStackDocument(row?.general?.[STACK_GENERAL_KEY]);
}

/** Overwrite the cached document under a row lock (the maintenance store pattern). */
export async function writeStackDocument(db: Db, next: StackDocument): Promise<StackDocument> {
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
        general: sql`jsonb_set(coalesce(${instanceSettings.general}, '{}'::jsonb), ${`{${STACK_GENERAL_KEY}}`}::text[], ${JSON.stringify(next)}::jsonb, true)`,
      })
      .where(eq(instanceSettings.id, row.id));
    return next;
  });
}

/** Carry our key over a vendor write of instance_settings.general. */
export function preserveStackGeneralKey(storedGeneral: unknown): Record<string, unknown> {
  if (typeof storedGeneral !== "object" || storedGeneral === null) return {};
  const value = (storedGeneral as Record<string, unknown>)[STACK_GENERAL_KEY];
  return value === undefined ? {} : { [STACK_GENERAL_KEY]: value };
}
