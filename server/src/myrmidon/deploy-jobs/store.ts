// Board self-deploy (myrmidon R5-A): storage — the `myrmidonDeployJobs` key of
// instance_settings.general, the same pattern the maintenance mode uses (R3).
// The vendor settings service strips unknown keys, so this module reads and
// writes the raw row itself and instance-settings.ts carries the key over a
// vendor write (see preserveDeployJobsGeneralKey and the myrmidon(R5-A) call
// site there).

import { eq, sql } from "drizzle-orm";
import { instanceSettings, type Db } from "@paperclipai/db";
import { parseDeployJobDocument, type DeployJobDocument } from "./domain.js";

export const DEPLOY_JOBS_GENERAL_KEY = "myrmidonDeployJobs";
const SINGLETON_KEY = "default";

type Runner = Pick<Db, "select">;

export async function readDeployJobDocument(db: Runner): Promise<DeployJobDocument> {
  const row = await db
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
    .then((rows) => rows[0] ?? null);
  return parseDeployJobDocument(row?.general?.[DEPLOY_JOBS_GENERAL_KEY]);
}

/**
 * Read-modify-write the document under a row lock. `change` returns the next
 * document (or null to leave it as is) and a value handed back to the caller.
 */
export async function mutateDeployJobDocument<T>(
  db: Db,
  change: (current: DeployJobDocument) => { next: DeployJobDocument | null; result: T },
): Promise<{ doc: DeployJobDocument; result: T; changed: boolean }> {
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
    const current = parseDeployJobDocument(row.general?.[DEPLOY_JOBS_GENERAL_KEY]);
    const { next, result } = change(current);
    if (!next) return { doc: current, result, changed: false };
    await tx
      .update(instanceSettings)
      .set({
        general: sql`jsonb_set(coalesce(${instanceSettings.general}, '{}'::jsonb), ${`{${DEPLOY_JOBS_GENERAL_KEY}}`}::text[], ${JSON.stringify(next)}::jsonb, true)`,
      })
      .where(eq(instanceSettings.id, row.id));
    return { doc: next, result, changed: true };
  });
}

/** Carry our key over a vendor write of instance_settings.general. */
export function preserveDeployJobsGeneralKey(storedGeneral: unknown): Record<string, unknown> {
  if (typeof storedGeneral !== "object" || storedGeneral === null) return {};
  const value = (storedGeneral as Record<string, unknown>)[DEPLOY_JOBS_GENERAL_KEY];
  return value === undefined ? {} : { [DEPLOY_JOBS_GENERAL_KEY]: value };
}
