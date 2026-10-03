// myrmidon(1.6-FORAGE): the source registry and the findings log of FORAGING.
//
// Two additive tables, no vendor table is touched:
//  - foraging_sources: one row per approved source of a role. `last_snapshot`
//    keeps the previous read (one normalized line per element), `last_snapshot_at`
//    when it was taken, so the next pass compares against it and a restart does
//    not lose the baseline.
//  - foraging_findings: one row per diff a pass produced. A finding starts as
//    `unverified`; when the skill-lifecycle port accepted it as a candidate the
//    row keeps the returned candidate reference and moves to `candidate` (or to
//    `rejected` when the port refused it). Nothing here writes to a skill table:
//    a finding is evidence, the skill lifecycle owns the skill.
//
// Rollback restores the image, not the database: an older image ignores both
// tables, which is why they are additive only.

import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/** The kinds of source a registry row may have. */
export type ForagingSourceKind = "url" | "feed" | "repo" | "docs";

/** A finding's state; see the module comment. */
export type ForagingFindingStatus = "unverified" | "candidate" | "rejected";

export const foragingSources = pgTable(
  "foraging_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** The agent role this source feeds (`engineer`, `designer`, …). */
    role: text("role").notNull(),
    url: text("url").notNull(),
    kind: text("kind").$type<ForagingSourceKind>().notNull().default("url"),
    enabled: boolean("enabled").notNull().default(true),
    /** The normalized lines of the previous read; null before the first pass. */
    lastSnapshot: jsonb("last_snapshot").$type<string[] | null>(),
    lastSnapshotAt: timestamp("last_snapshot_at", { withTimezone: true }),
    /** When the source was last read, whether or not it changed. */
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    /** Why the last pass could not read the source; null when it could. */
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyRoleUq: uniqueIndex("foraging_sources_company_role_url_uq").on(
      table.companyId,
      table.role,
      table.url,
    ),
    companyRoleIdx: index("foraging_sources_company_role_idx").on(table.companyId, table.role),
  }),
);

export const foragingFindings = pgTable(
  "foraging_findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => foragingSources.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    status: text("status").$type<ForagingFindingStatus>().notNull().default("unverified"),
    summary: text("summary").notNull(),
    /** The diff: `{ added: string[], removed: string[] }`, bounded by the pass. */
    diff: jsonb("diff").$type<{ added: string[]; removed: string[] }>().notNull(),
    /** The skill key the finding is about; derived from the source role. */
    skillKey: text("skill_key").notNull(),
    /** What the skill-lifecycle port returned when the finding became a candidate. */
    candidateRef: text("candidate_ref"),
    /** Why the port refused the finding, or why the sweep stopped before it. */
    reason: text("reason"),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyDetectedIdx: index("foraging_findings_company_detected_idx").on(
      table.companyId,
      table.detectedAt,
    ),
    companyStatusIdx: index("foraging_findings_company_status_idx").on(table.companyId, table.status),
    sourceIdx: index("foraging_findings_source_idx").on(table.sourceId),
  }),
);