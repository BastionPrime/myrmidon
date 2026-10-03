// packages/db/src/schema/issue_claims.ts
//
// myrmidon(1.6-SWARM): the lease table of the per-role task queues.
//
// Why a table and not JSON columns on `issues` (the design note left the choice
// open, the PR records the decision): a claim is a *history* — who held a task,
// when the lease ran out, who released it and why — and the supervisor view
// reads exactly that history to explain "who holds what" and to show the leases
// that expired. JSON fields would overwrite the previous holder on every
// re-claim and leave the release reason with nowhere to live. The table is also
// what lets the expiry sweep be one indexed `expires_at < now` read instead of a
// scan over the issue payload.
//
// One row per lease, immutable except for the three columns the lifecycle
// writes (`heartbeat_at`, `expires_at` on a refresh; `released_at`,
// `release_reason` on a release). A live lease is `released_at IS NULL`; an
// expired one is a live row whose `expires_at` has passed. History rows are
// kept so the supervisor can show a task's recent holders.
//
// Additive only: one new table and its indexes; no vendor table is touched and
// no data is rewritten.

import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const issueClaims = pgTable(
  "issue_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    /** The agent holding the lease. */
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /** The run the claim was taken for, when the claim came from a checkout. */
    runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    /** The role queue the task was taken from (`agents.role` at claim time). */
    role: text("role"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
    /** Last heartbeat that refreshed the lease; equals `claimed_at` until one lands. */
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
    /** The lease covers its task while `now < expires_at` and it is not released. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Set by every release path: run finished, expiry sweep, supervisor rebalance. */
    releasedAt: timestamp("released_at", { withTimezone: true }),
    /** Free text; the code writes the `SWARM_CLAIM_RELEASE_REASON_*` values. */
    releaseReason: text("release_reason"),
  },
  (table) => ({
    // The one lookup every path makes: the live claim of one task.
    issueLiveIdx: index("issue_claims_issue_live_idx").on(table.issueId, table.releasedAt),
    // The agent's active-task count against the per-agent ceiling.
    agentLiveIdx: index("issue_claims_company_agent_live_idx").on(
      table.companyId,
      table.agentId,
      table.releasedAt,
    ),
    // The expiry sweep: live rows ordered by the moment they run out.
    expiryIdx: index("issue_claims_expires_idx").on(table.expiresAt, table.releasedAt),
    // The supervisor view: one company's leases, newest first.
    companyClaimedIdx: index("issue_claims_company_claimed_idx").on(
      table.companyId,
      table.claimedAt,
    ),
  }),
);

export type IssueClaim = typeof issueClaims.$inferSelect;
export type NewIssueClaim = typeof issueClaims.$inferInsert;