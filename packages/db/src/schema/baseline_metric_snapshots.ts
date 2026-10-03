// packages/db/src/schema/baseline_metric_snapshots.ts
//
// myrmidon(1.6-BASELINE): frozen metric snapshots.
//
// One additive table. The periodic job (server/src/myrmidon/baseline/) computes
// the BASELINE metrics for a fixed window and stores the whole API answer here
// unchanged (payload jsonb), so a later release can be compared against the
// number the board produced at a known moment even after the source rows moved
// on. Nothing vendor-side is touched.

import { index, jsonb, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const baselineMetricSnapshots = pgTable(
  "baseline_metric_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    windowFrom: timestamp("window_from", { withTimezone: true }).notNull(),
    windowTo: timestamp("window_to", { withTimezone: true }).notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  },
  (table) => ({
    companyGeneratedIdx: index("baseline_metric_snapshots_company_generated_idx").on(
      table.companyId,
      table.generatedAt,
    ),
  }),
);