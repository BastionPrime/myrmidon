// packages/db/src/schema/agent_castes.ts
//
// myrmidon(CUSTOM-CASTES): the company caste (agent role) directory.
//
// One row per caste a company owns. The `key` is the stable identifier that
// matches `agents.role` (latin letters, digits, hyphen; 1-60 chars) — it is
// unique per company and immutable after creation. `agents.role` itself is NOT
// migrated or re-validated here: the 12 AGENT_ROLES values stay as they are,
// part B of CUSTOM-CASTES wires the agent editor to this directory.
//
// `builtIn` marks the 12 rows the lazy idempotent seed inserts on a company's
// first read; they are editable (labels, color, swarm flag) but not deletable
// as "built-in" — the flag cannot be turned off.
//
// Additive migration only: one new table + indexes, no vendor table touched.

import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const agentCastes = pgTable(
  "agent_castes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** Stable identifier matching `agents.role`; immutable after creation. */
    key: text("key").notNull(),
    /** English display name (API contract requires it). */
    nameEn: text("name_en").notNull(),
    /** Russian display name; null falls back to nameEn. */
    nameRu: text("name_ru"),
    description: text("description"),
    /** Token-layer color name of the caste badge. */
    color: text("color").notNull().default("gray"),
    /** Icon name (AGENT_ICON_NAMES vocabulary); null = default icon. */
    icon: text("icon"),
    /** Model an agent of this caste should use by default; null = none. */
    defaultModel: text("default_model"),
    /** Whether agents of this caste may join the swarm claim queue. */
    swarmEligible: boolean("swarm_eligible").notNull().default(true),
    /** Per-caste active-task ceiling; null = the global swarm limit. */
    maxActiveTasks: integer("max_active_tasks"),
    /** True for the 12 seed rows; cannot be turned off. */
    builtIn: boolean("built_in").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyKeyUq: uniqueIndex("agent_castes_company_key_uq").on(
      table.companyId,
      table.key,
    ),
    companyIdx: index("agent_castes_company_idx").on(table.companyId),
  }),
);
