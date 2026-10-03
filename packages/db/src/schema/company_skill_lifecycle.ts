// myrmidon(1.6-SKILL-LIFE): additive lifecycle tables for company skills.
//
// Why a separate table instead of columns on `company_skills`: the vendor table
// stays untouched, so a vendor sync never collides with our lifecycle. The
// current state lives in `company_skill_lifecycle` (one row per skill) and the
// append-only audit trail in `company_skill_lifecycle_events`. A skill with no
// row is legacy/unmanaged and is delivered to everyone, exactly as before.
//
// Rollback reads content from `company_skill_versions`: `verified_version_id`
// points at the revision that is currently delivered, `previous_verified_version_id`
// keeps the one it replaced, so a rollback restores the previous verified content
// on the next run of every agent that uses the skill.

import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { companySkills, companySkillVersions } from "./company_skills.js";

export const companySkillLifecycle = pgTable(
  "company_skill_lifecycle",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id").notNull().references(() => companySkills.id, { onDelete: "cascade" }),
    state: text("state").notNull().default("candidate"),
    verifiedVersionId: uuid("verified_version_id").references(() => companySkillVersions.id, { onDelete: "set null" }),
    previousVerifiedVersionId: uuid("previous_verified_version_id").references(() => companySkillVersions.id, {
      onDelete: "set null",
    }),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companySkillUniqueIdx: uniqueIndex("company_skill_lifecycle_company_skill_idx").on(table.companyId, table.skillId),
    companyStateIdx: index("company_skill_lifecycle_company_state_idx").on(table.companyId, table.state),
  }),
);

export const companySkillLifecycleEvents = pgTable(
  "company_skill_lifecycle_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id").notNull().references(() => companySkills.id, { onDelete: "cascade" }),
    fromState: text("from_state"),
    toState: text("to_state").notNull(),
    versionId: uuid("version_id").references(() => companySkillVersions.id, { onDelete: "set null" }),
    actorType: text("actor_type").notNull().default("system"),
    actorId: text("actor_id"),
    approvalId: uuid("approval_id"),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companySkillCreatedIdx: index("company_skill_lifecycle_events_company_skill_created_idx").on(
      table.companyId,
      table.skillId,
      table.createdAt,
    ),
  }),
);