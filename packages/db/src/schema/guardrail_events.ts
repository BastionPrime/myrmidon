import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

/**
 * myrmidon(1.6-GRD): one guardrail flagging event, company-scoped.
 *
 * The 1.6.1 guardrail layer is flag-only: a row says a detector fired on a
 * run's output surface. The stored `snippet` is cut from text that already
 * went through the existing secret masking (S5), so no raw secret value is
 * ever persisted here. Legal-entity requisites are a separate backlog item
 * and never appear.
 */
export const guardrailEvents = pgTable(
  "guardrail_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    kind: text("kind").notNull(),
    surface: text("surface").notNull(),
    severity: text("severity").notNull(),
    runId: uuid("run_id").references(() => heartbeatRuns.id),
    issueId: uuid("issue_id"),
    /** Masked excerpt; the plain text itself is never stored. */
    snippet: text("snippet"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyOccurredIdx: index("guardrail_events_company_occurred_idx").on(
      table.companyId,
      table.occurredAt,
    ),
    runIdx: index("guardrail_events_run_id_idx").on(table.runId),
  }),
);
