// packages/db/src/schema/litellm_costs.ts
//
// myrmidon(M2-A): the LLM gateway (LiteLLM) spend ledger and model catalog,
// collected by the periodic sweep (server/src/myrmidon/litellm-costs/).
//
// Two tables, both additive (no vendor table is touched):
//  - litellm_cost_events: one row per gateway spend-log entry, attributed to
//    an agent by the hashed gateway key, deduplicated by the gateway's
//    request_id. The vendor cost_events ledger stays the request-scoped
//    ledger adapters fill; this table is the gateway-collected view the
//    Costs screens read, so the two sources stay comparable (the acceptance
//    criterion is exactly that their sums match).
//  - litellm_models: the model catalog with the price rates the gateway's
//    /v1/model/info last reported; a new refresh inserts a new seen_at row
//    instead of updating, so a price change keeps its history.

import { integer, jsonb, pgTable, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";

/** Cost fields the gateway reports, kept as-is (USD per token). */
export type LitellmModelRates = Record<string, number | null>;

export const litellmCostEvents = pgTable(
  "litellm_cost_events",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    agentId: text("agent_id").notNull(),
    issueId: text("issue_id"),
    heartbeatRunId: text("heartbeat_run_id"),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costCents: integer("cost_cents").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    /** The gateway's request_id: the dedup key for repeated sweeps. */
    requestId: text("request_id"),
    collectedAt: timestamp("collected_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    requestIdx: uniqueIndex("litellm_cost_events_request_uq").on(table.requestId),
    companyOccurredIdx: index("litellm_cost_events_company_occurred_idx").on(table.companyId, table.occurredAt),
    companyRunIdx: index("litellm_cost_events_company_run_idx").on(table.companyId, table.heartbeatRunId),
  }),
);

export const litellmModels = pgTable(
  "litellm_models",
  {
    id: text("id").primaryKey(),
    modelName: text("model_name").notNull(),
    provider: text("provider"),
    maxInputTokens: integer("max_input_tokens"),
    maxOutputTokens: integer("max_output_tokens"),
    rates: jsonb("rates").$type<LitellmModelRates>().notNull().default({}),
    seenAt: timestamp("seen_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    nameSeenIdx: uniqueIndex("litellm_models_name_seen_uq").on(table.modelName, table.seenAt),
  }),
);
