import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const agentWakeupRequests = pgTable(
  "agent_wakeup_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    source: text("source").notNull(),
    triggerDetail: text("trigger_detail"),
    reason: text("reason"),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    status: text("status").notNull().default("queued"),
    coalescedCount: integer("coalesced_count").notNull().default(0),
    requestedByActorType: text("requested_by_actor_type"),
    requestedByActorId: text("requested_by_actor_id"),
    idempotencyKey: text("idempotency_key"),
    runId: uuid("run_id"),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    companyAgentStatusIdx: index(
      "agent_wakeup_requests_company_agent_status_idx",
    ).on(table.companyId, table.agentId, table.status),
    companyRequestedIdx: index(
      "agent_wakeup_requests_company_requested_idx",
    ).on(table.companyId, table.requestedAt),
    agentRequestedIdx: index("agent_wakeup_requests_agent_requested_idx").on(
      table.agentId,
      table.requestedAt,
    ),
    reviewPathRecoveryIdempotencyUq: uniqueIndex(
      "agent_wakeup_requests_review_path_recovery_idempotency_uq",
    )
      .on(table.companyId, table.idempotencyKey)
      .where(
        sql`${table.idempotencyKey} LIKE 'issue_review_path_lost:%' AND ${table.status} <> 'skipped'`,
      ),
    dispositionRepairIdempotencyUq: uniqueIndex(
      "agent_wakeup_requests_disposition_repair_idempotency_uq",
    )
      .on(table.companyId, table.idempotencyKey)
      .where(
        sql`${table.idempotencyKey} LIKE 'issue_disposition_repair:%' AND ${table.status} <> 'skipped'`,
      ),
    questionResponseDeliveryIdempotencyUq: uniqueIndex(
      "agent_wakeup_requests_question_response_delivery_idempotency_uq",
    )
      .on(table.companyId, table.idempotencyKey)
      .where(sql`(${table.idempotencyKey} LIKE 'question-response:%' OR ${table.idempotencyKey} LIKE 'interaction:%') AND ${table.status} NOT IN ('skipped', 'failed', 'cancelled')`),
    connectionIntentDeliveryIdempotencyUq: uniqueIndex("agent_wakeup_requests_connection_intent_delivery_idempotency_uq")
      .on(table.companyId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} LIKE 'connection-intent:%' AND ${table.status} NOT IN ('skipped', 'failed', 'cancelled')`),
    toolActionDeliveryIdempotencyUq: uniqueIndex("agent_wakeup_requests_tool_action_delivery_uq")
      .on(table.companyId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} LIKE 'tool-action-response:%' AND ${table.status} NOT IN ('skipped', 'failed', 'cancelled')`),
    // myrmidon(WAKE-KEYS-UNIQUE): the pause-resume wake (pause-drain.ts) and
    // the stranded auto-policy retry wake (stranded-autopolicy.ts) are keyed
    // per issue, but two racers decide from a snapshot they read before the
    // insert, so the caller-side checks cannot close the window. Terminal
    // wakes stay out of the predicate: a refused or failed wake must not block
    // the next legitimate one.
    pauseResumeIdempotencyUq: uniqueIndex(
      "agent_wakeup_requests_pause_resume_idempotency_uq",
    )
      .on(table.companyId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} LIKE 'pause_resume:%' AND ${table.status} NOT IN ('skipped', 'failed', 'cancelled')`),
    strandedAutopolicyRetryIdempotencyUq: uniqueIndex(
      "agent_wakeup_requests_stranded_autopolicy_retry_idempotency_uq",
    )
      .on(table.companyId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} LIKE 'myrmidon.stranded_autopolicy_retry:%' AND ${table.status} NOT IN ('skipped', 'failed', 'cancelled')`),
    companyPayloadIssueIdx: index("agent_wakeup_requests_company_payload_issue_idx").on(
      table.companyId,
      sql`(${table.payload} ->> 'issueId')`,
    ),
  }),
);
