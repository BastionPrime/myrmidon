// packages/db/src/schema/myrmidon_wiki_regulations.ts
//
// myrmidon(1.6-WIKI): company regulations as wiki pages with a lifecycle.
//
// A regulation is a page of the wiki whose audience is a set of roles, not a
// person: "how the engineers run a deploy", "what the owner approves". The
// roles read them on every run, so a regulation has two states — a draft nobody
// outside the wiki sees, and an approved text every agent of the listed roles
// gets in its next run. Editing an approved regulation never changes what the
// fleet reads: the edit is a new draft revision, and only an explicit approval
// makes it the delivered text. A rollback is one more revision (append-only),
// so restoring an earlier text is itself undoable.
//
// One row per regulation; the revision history lives in the `revisions` jsonb
// column (the wiki brief's "lifecycle in the page metadata, no extra table"
// rule) and every revision carries its own status, so the delivered revision —
// the newest approved one — is readable without a second table. The current
// revision is also mirrored into `content`/`title`/`roles`/`status` so listing
// the wiki does not have to walk the history.
//
// Additive migration only: a new table with its indexes.

import { pgTable, uuid, text, integer, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/** The role key that means "every role of the company". */
export const MYRMIDON_WIKI_REGULATION_ANY_ROLE = "*";

export type MyrmidonWikiRegulationStatus = "draft" | "approved";

/** One entry of a regulation's append-only history. */
export interface MyrmidonWikiRegulationRevision {
  /** 1-based, strictly increasing within the regulation. */
  revisionNumber: number;
  title: string;
  /** Role keys this revision applies to; `["*"]` means every role. */
  roles: string[];
  content: string;
  status: MyrmidonWikiRegulationStatus;
  /** Why the revision was written (what changed), free text. */
  changeSummary: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  /** ISO timestamp of the write. */
  createdAt: string;
}

export const myrmidonWikiRegulations = pgTable(
  "myrmidon_wiki_regulations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** Stable page key inside the company (`deploy/oncall`), unique per company. */
    slug: text("slug").notNull(),
    /** Title of the newest revision. */
    title: text("title").notNull(),
    /** Roles of the newest revision; `["*"]` means every role. */
    roles: jsonb("roles").$type<string[]>().notNull().default([]),
    /** Status of the newest revision: only an approved text reaches agents. */
    status: text("status").$type<MyrmidonWikiRegulationStatus>().notNull().default("draft"),
    /** Number of the newest revision. */
    revisionNumber: integer("revision_number").notNull().default(1),
    /** Content of the newest revision (the draft when `status` is draft). */
    content: text("content").notNull(),
    /** Append-only history, oldest first. */
    revisions: jsonb("revisions").$type<MyrmidonWikiRegulationRevision[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companySlugUq: uniqueIndex("myrmidon_wiki_regulations_company_slug_uq").on(table.companyId, table.slug),
    companyStatusIdx: index("myrmidon_wiki_regulations_company_status_idx").on(table.companyId, table.status),
  }),
);