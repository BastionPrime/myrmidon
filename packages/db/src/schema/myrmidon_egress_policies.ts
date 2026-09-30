// packages/db/src/schema/myrmidon_egress_policies.ts
//
// myrmidon(EGRESS-B): the destination allowlists and the per-project mode of the
// bot egress proxy (release 1.3, plan §2.5 item 5). EGRESS-A gave the fleet a
// journal: every bot's outward traffic goes through a proxy that records where
// it went and refuses nothing. This table is the *decision* half — which
// destinations a project (and a single bot) may reach, and whether that project
// is still recording or already refusing.
//
// One row per target, so a card edit and a project edit never overwrite each
// other:
//   - scope `project`, target_id = the project's uuid — the project's list and
//     its mode (`log` or `block`);
//   - scope `bot`, target_id = the bot key — the project that bot belongs to
//     (the name the journal shows) and the extra destinations only that bot may
//     reach.
//
// `verified` is what keeps a blocking mode from breaking the fleet: the plan's
// risk note says blocking without an inventory of the real destinations does
// exactly that, so a project may only be switched to `block` once somebody has
// compared its list with the journal (docs/myrmidon/egress.md).

import { pgTable, uuid, text, boolean, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const myrmidonEgressPolicies = pgTable(
  "myrmidon_egress_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** `project` or `bot`. */
    scope: text("scope").notNull(),
    /** The project's uuid (scope `project`) or the bot key (scope `bot`). */
    targetId: text("target_id").notNull(),
    /** `log` (record only) or `block` (refuse what is not on the list). */
    mode: text("mode").notNull().default("log"),
    /** The list was compared with the journal of the observation period. */
    verified: boolean("verified").notNull().default(false),
    /** Destinations as `host` or `host:port`, lowercase, without duplicates. */
    allow: jsonb("allow").$type<string[]>().notNull().default([]),
    /** scope `bot`: the project the journal should name for this bot. */
    project: text("project"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    scopeTargetUq: uniqueIndex("myrmidon_egress_policies_company_scope_target_uq").on(
      table.companyId,
      table.scope,
      table.targetId,
    ),
    companyScopeIdx: index("myrmidon_egress_policies_company_scope_idx").on(table.companyId, table.scope),
  }),
);