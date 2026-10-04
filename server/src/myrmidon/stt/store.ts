// server/src/myrmidon/stt/store.ts
//
// myrmidon(1.6.1 VOICE-STT A1): the runtime-mutable per-company settings,
// stored in the existing instance_settings JSON columns — no new migration
// (the repo's convention: migrations are forbidden by default).
//
// The document lives under `general.myrmidonSttCompanies[companyId]`, a
// company-keyed map, written with the same jsonb_set read-modify-write under
// a row lock the deploy-jobs and canary modules use. A vendor write of
// `general` strips unknown keys, so `server/src/services/instance-settings.ts`
// carries `myrmidonSttCompanies` over (see the preserve line marked
// myrmidon(1.6.1 VOICE-STT A1) there).

import { eq, sql } from "drizzle-orm";
import { instanceSettings, type Db } from "@paperclipai/db";
import type { StoredSttOverrides } from "./settings.js";

export const STT_COMPANIES_GENERAL_KEY = "myrmidonSttCompanies";
const SINGLETON_KEY = "default";

type Runner = Pick<Db, "select">;

function normalizeCompanyId(companyId: string): string {
  return companyId.trim().toLowerCase();
}

/** Reads the stored overrides of one company; null when nothing is stored. */
export async function readSttOverrides(db: Runner, companyId: string): Promise<StoredSttOverrides | null> {
  const row = await db
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
    .then((rows) => rows[0] ?? null);
  const companies = (row?.general as Record<string, unknown> | null)?.[STT_COMPANIES_GENERAL_KEY];
  if (typeof companies !== "object" || companies === null) return null;
  const stored = (companies as Record<string, unknown>)[normalizeCompanyId(companyId)];
  if (typeof stored !== "object" || stored === null) return null;
  return stored as StoredSttOverrides;
}

/** Reads the whole stored map (keys normalized company ids), for the preserve hook. */
export function readSttCompaniesMap(general: unknown): Record<string, unknown> {
  if (typeof general !== "object" || general === null) return {};
  const value = (general as Record<string, unknown>)[STT_COMPANIES_GENERAL_KEY];
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** Carry our key over a vendor write of instance_settings.general. */
export function preserveSttGeneralKey(storedGeneral: unknown): Record<string, unknown> {
  const value = readSttCompaniesMap(storedGeneral);
  return Object.keys(value).length > 0 ? { [STT_COMPANIES_GENERAL_KEY]: value } : {};
}

/** Read-modify-write the overrides of one company under a row lock. */
export async function mutateSttOverrides<T>(
  db: Db,
  companyId: string,
  change: (current: StoredSttOverrides | null) => { next: StoredSttOverrides | null; result: T },
): Promise<{ doc: StoredSttOverrides | null; result: T; changed: boolean }> {
  const key = normalizeCompanyId(companyId);
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
    const companies = readSttCompaniesMap(row.general);
    const current = (companies[key] as StoredSttOverrides | undefined) ?? null;
    const { next, result } = change(current);
    if (!next || JSON.stringify(next) === JSON.stringify(current)) {
      return { doc: current, result, changed: false };
    }
    const companiesNext = { ...companies, [key]: next };
    await tx
      .update(instanceSettings)
      .set({
        general: sql`jsonb_set(coalesce(${instanceSettings.general}, '{}'::jsonb), ${`{${STT_COMPANIES_GENERAL_KEY}}`}::text[], ${JSON.stringify(companiesNext)}::jsonb, true)`,
      })
      .where(eq(instanceSettings.id, row.id));
    return { doc: next, result, changed: true };
  });
}
