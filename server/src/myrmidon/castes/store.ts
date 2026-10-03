// server/src/myrmidon/castes/store.ts
//
// myrmidon(1.6.1 CUSTOM-CASTES A): the database store of the company caste
// directory — reads, writes and the lazy idempotent seed.
//
// Liveness (owner's criterion): the directory is read from the database on
// every call. There is NO read cache and NO env: create / assign / delete are
// visible to the swarm without a restart. The only in-process state is a
// seeded-company MISS cache (a Set of company ids whose seed insert already
// ran), which saves a redundant count query after the first read — never a
// cache of caste rows.
//
// The seed inserts only the keys the company is still missing, keyed on
// (companyId, key) unique constraint, so a concurrent first read converges to
// the same 12 rows.

import { and, asc, eq, inArray } from "drizzle-orm";
import { MYRMIDON_CASTE_SEED } from "@paperclipai/shared";
import { agentCastes, type Db } from "@paperclipai/db";
import { conflict, notFound } from "../../errors.js";

export type CasteRow = typeof agentCastes.$inferSelect;
export type CasteInsert = typeof agentCastes.$inferInsert;

export interface CasteStoreDeps {
  db: Db;
  now?(): Date;
}

export function createCasteStore(deps: CasteStoreDeps) {
  const now = deps.now ?? (() => new Date());
  /** Company ids whose seed pass already ran in this process (miss cache). */
  const seeded = new Set<string>();

  /**
   * Lists the company's castes, seeding the 12 built-ins first if the company
   * has no rows yet. Fresh read on every call — no row cache.
   */
  async function listCastes(companyId: string): Promise<CasteRow[]> {
    await seedIfMissing(companyId);
    return deps.db
      .select()
      .from(agentCastes)
      .where(eq(agentCastes.companyId, companyId))
      .orderBy(asc(agentCastes.key));
  }

  /** Loads one caste by key; null when the company has no such caste. */
  async function findCaste(companyId: string, key: string): Promise<CasteRow | null> {
    const rows = await deps.db
      .select()
      .from(agentCastes)
      .where(and(eq(agentCastes.companyId, companyId), eq(agentCastes.key, key)))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Inserts a new caste. Throws conflict (409) when the company already has a
   * caste with this key.
   */
  async function insertCaste(row: CasteInsert): Promise<CasteRow> {
    const existing = await findCaste(row.companyId as string, row.key as string);
    if (existing) {
      throw conflict(`a caste with key "${row.key}" already exists in this company`, {
        code: "caste_key_exists",
      });
    }
    const inserted = await deps.db.insert(agentCastes).values(row).returning();
    return inserted[0]!;
  }

  /**
   * Updates a caste row. The caller (service) has already validated that the
   * patch touches no immutable field.
   */
  async function updateCaste(
    companyId: string,
    key: string,
    patch: Partial<CasteInsert>,
  ): Promise<CasteRow> {
    const updated = await deps.db
      .update(agentCastes)
      .set({ ...patch, updatedAt: now() })
      .where(and(eq(agentCastes.companyId, companyId), eq(agentCastes.key, key)))
      .returning();
    const row = updated[0];
    if (!row) throw notFound("Caste not found in this company");
    return row;
  }

  /** Deletes one caste row; returns whether a row was removed. */
  async function deleteCaste(companyId: string, key: string): Promise<boolean> {
    const deleted = await deps.db
      .delete(agentCastes)
      .where(and(eq(agentCastes.companyId, companyId), eq(agentCastes.key, key)))
      .returning({ id: agentCastes.id });
    return deleted.length > 0;
  }
  /**
   * The lazy idempotent seed: when the company has no caste rows at all,
   * insert the 12 built-ins. Only the missing keys are written, so re-running
   * converges (and the unique (companyId, key) index backstops races).
   */
  async function seedIfMissing(companyId: string): Promise<void> {
    if (seeded.has(companyId)) return;
    const count = await deps.db
      .select({ id: agentCastes.id })
      .from(agentCastes)
      .where(eq(agentCastes.companyId, companyId))
      .limit(1);
    if (count.length > 0) {
      seeded.add(companyId);
      return;
    }
    const existingKeys = await deps.db
      .select({ key: agentCastes.key })
      .from(agentCastes)
      .where(
        and(
          eq(agentCastes.companyId, companyId),
          inArray(
            agentCastes.key,
            MYRMIDON_CASTE_SEED.map((seed) => seed.key),
          ),
        ),
      );
    const have = new Set(existingKeys.map((row) => row.key));
    const missing = MYRMIDON_CASTE_SEED.filter((seed) => !have.has(seed.key));
    if (missing.length > 0) {
      await deps.db
        .insert(agentCastes)
        .values(
          missing.map((seed) => ({
            companyId,
            key: seed.key,
            nameEn: seed.nameEn,
            nameRu: seed.nameRu,
            description: null,
            color: seed.color as string,
            icon: null,
            defaultModel: null,
            swarmEligible: true,
            maxActiveTasks: null,
            builtIn: true,
          })),
        )
        .onConflictDoNothing({ target: [agentCastes.companyId, agentCastes.key] });
    }
    seeded.add(companyId);
  }

  /** Test seam: forgets the miss cache (only tests use it). */
  function forgetSeedCache(): void {
    seeded.clear();
  }

  return {
    listCastes,
    findCaste,
    insertCaste,
    updateCaste,
    deleteCaste,
    seedIfMissing,
    forgetSeedCache,
  };
}

export type CasteStore = ReturnType<typeof createCasteStore>;
