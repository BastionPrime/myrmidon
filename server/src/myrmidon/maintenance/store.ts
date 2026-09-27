// Maintenance mode storage: the `myrmidonMaintenance` key of instance_settings.general.
// The vendor settings service strips unknown keys, so this module reads and writes the
// raw row itself, and the vendor's updateGeneral keeps the key via
// preserveMaintenanceGeneralKey().

import { eq, sql } from "drizzle-orm";
import { instanceSettings, type Db } from "@paperclipai/db";
import { parseMaintenanceDocument, type MaintenanceDocument } from "./domain.js";

export const MAINTENANCE_GENERAL_KEY = "myrmidonMaintenance";
const SINGLETON_KEY = "default";

type Runner = Pick<Db, "select" | "insert" | "update">;

export async function readMaintenanceDocument(db: Runner): Promise<MaintenanceDocument> {
  const row = await db
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
    .then((rows) => rows[0] ?? null);
  return parseMaintenanceDocument(row?.general?.[MAINTENANCE_GENERAL_KEY]);
}

/**
 * Read-modify-write the document under a row lock. `change` returns the next
 * document (or null to leave it as is) and a value handed back to the caller.
 */
export async function mutateMaintenanceDocument<T>(
  db: Db,
  change: (current: MaintenanceDocument) => { next: MaintenanceDocument | null; result: T },
): Promise<{ doc: MaintenanceDocument; result: T; changed: boolean }> {
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
    const current = parseMaintenanceDocument(row.general?.[MAINTENANCE_GENERAL_KEY]);
    const { next, result } = change(current);
    if (!next) return { doc: current, result, changed: false };
    await tx
      .update(instanceSettings)
      .set({
        general: sql`jsonb_set(coalesce(${instanceSettings.general}, '{}'::jsonb), ${`{${MAINTENANCE_GENERAL_KEY}}`}::text[], ${JSON.stringify(next)}::jsonb, true)`,
      })
      .where(eq(instanceSettings.id, row.id));
    return { doc: next, result, changed: true };
  });
}

/** Carry our key over a vendor write of instance_settings.general. */
export function preserveMaintenanceGeneralKey(storedGeneral: unknown): Record<string, unknown> {
  if (typeof storedGeneral !== "object" || storedGeneral === null) return {};
  const value = (storedGeneral as Record<string, unknown>)[MAINTENANCE_GENERAL_KEY];
  return value === undefined ? {} : { [MAINTENANCE_GENERAL_KEY]: value };
}
