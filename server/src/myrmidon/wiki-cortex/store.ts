// server/src/myrmidon/wiki-cortex/store.ts
//
// myrmidon(1.6-WIKI): the database side of the regulation lifecycle.
//
// One row per regulation (`myrmidon_wiki_regulations`, additive migration); the
// revision history rides in the `revisions` jsonb column. Writes take a row lock
// first, the pattern the instructions-revisions module uses, so two concurrent
// edits cannot take the same revision number.

import { and, eq, sql } from "drizzle-orm";
import { myrmidonWikiRegulations, type Db, type MyrmidonWikiRegulationRevision } from "@paperclipai/db";
import type { RegulationStore } from "./service.js";
import type { RegulationPageRecord, RegulationRevisionRecord } from "./types.js";

function toRevision(row: MyrmidonWikiRegulationRevision): RegulationRevisionRecord {
  return {
    revisionNumber: row.revisionNumber,
    title: row.title,
    roles: row.roles ?? [],
    content: row.content,
    status: row.status,
    changeSummary: row.changeSummary ?? null,
    createdByAgentId: row.createdByAgentId ?? null,
    createdByUserId: row.createdByUserId ?? null,
    createdAt: row.createdAt,
  };
}

export function toPage(row: typeof myrmidonWikiRegulations.$inferSelect): RegulationPageRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    slug: row.slug,
    title: row.title,
    roles: row.roles ?? [],
    status: row.status,
    revisionNumber: row.revisionNumber,
    content: row.content,
    revisions: (row.revisions ?? []).map(toRevision),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toRowValues(page: RegulationPageRecord) {
  return {
    id: page.id,
    companyId: page.companyId,
    slug: page.slug,
    title: page.title,
    roles: page.roles,
    status: page.status,
    revisionNumber: page.revisionNumber,
    content: page.content,
    revisions: page.revisions,
    updatedAt: page.updatedAt,
  };
}

export function createDbRegulationStore(db: Db): RegulationStore {
  return {
    async list(companyId: string) {
      const rows = await db
        .select()
        .from(myrmidonWikiRegulations)
        .where(eq(myrmidonWikiRegulations.companyId, companyId));
      return rows.map(toPage);
    },

    async get(companyId: string, slug: string) {
      const rows = await db
        .select()
        .from(myrmidonWikiRegulations)
        .where(and(eq(myrmidonWikiRegulations.companyId, companyId), eq(myrmidonWikiRegulations.slug, slug)));
      return rows[0] ? toPage(rows[0]) : null;
    },

    async put(page: RegulationPageRecord) {
      const row = await db.transaction(async (tx) => {
        await tx.execute(sql`
          select ${myrmidonWikiRegulations.id}
          from ${myrmidonWikiRegulations}
          where ${myrmidonWikiRegulations.companyId} = ${page.companyId}
            and ${myrmidonWikiRegulations.slug} = ${page.slug}
          for update
        `);
        const values = toRowValues(page);
        const rows = await tx
          .insert(myrmidonWikiRegulations)
          .values({ ...values, createdAt: page.createdAt })
          .onConflictDoUpdate({
            target: [myrmidonWikiRegulations.companyId, myrmidonWikiRegulations.slug],
            set: {
              title: values.title,
              roles: values.roles,
              status: values.status,
              revisionNumber: values.revisionNumber,
              content: values.content,
              revisions: values.revisions,
              updatedAt: values.updatedAt,
            },
          })
          .returning();
        return rows[0];
      });
      return toPage(row);
    },
  };
}