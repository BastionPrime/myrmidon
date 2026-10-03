// server/src/myrmidon/litellm-costs/reconcile.ts
//
// myrmidon(HERMES-USAGE-COST): fill the vendor cost ledger's unpriced
// hermes_gateway rows with the prices the LLM gateway (LiteLLM) actually
// charged, collected by the M2-A sweep into litellm_cost_events.
//
// Why this exists: the hermes_gateway adapter's terminal run payload carries
// token usage but no cost (the Hermes run record ends cost_status=unknown,
// cost_source=none for a custom OpenAI-compatible provider — Hermes cannot
// price a relay it has no rate card for). The heartbeat ledger therefore
// writes cost_events with cost_status='unpriced' and costCents=0, and every
// board surface that reads cost_events (dashboard month spend, Costs
// overview, per-agent/per-biller views, budgets) shows $0 while the gateway
// bills real money. The gateway's own spend log is the source of truth, so
// the reconcile pass copies its per-run sums into the matching unpriced rows.
//
// Matching rule: a litellm_cost_events row is already attached to a
// heartbeat run by the sweep's run-window match (same rule the vendor ledger
// uses). For each unpriced cost_events row of the same company with the same
// heartbeat_run_id, the pass writes the sum of that run's collected
// litellm_cost_events cost_cents, marks cost_status='reported' (the vendor
// status for "priced"), and refreshes the agent/company monthly spend
// counters the same way costService.createEvent does.
//
// Scope guards:
//  - Only rows with cost_status='unpriced' are touched: a row the adapter
//    itself priced (or an operator-adjusted row) is never overwritten.
//  - Only rows whose provider is hermes_gateway are touched: other adapters
//    price themselves or are subscription-billed, and double-filling them
//    would double-count.
//  - Idempotent: re-running the pass over the same window finds no unpriced
//    rows left and writes nothing.

import { and, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import { agents, companies, costEvents, litellmCostEvents, type Db } from "@paperclipai/db";

/** The provider string the hermes_gateway adapter reports. */
const HERMES_GATEWAY_PROVIDER = "hermes_gateway";
/** Vendor cost status for rows the adapter could not price. */
const COST_STATUS_UNPRICED = "unpriced";
/** Vendor cost status for priced rows — what a reconciled row becomes. */
const COST_STATUS_REPORTED = "reported";

export interface ReconcileResult {
  /** Unpriced cost_events rows filled with the gateway's price. */
  updated: number;
  /** Unpriced rows skipped because no collected spend matched their run. */
  stillUnpriced: number;
}

/**
 * Reconcile one company's unpriced hermes_gateway cost_events against the
 * litellm_cost_events collected in `window` (and any earlier collected rows —
 * a run's spend may have been collected by a previous sweep).
 */
export async function reconcileUnpricedCostEvents(
  db: Db,
  companyId: string,
  window: { from: Date; to: Date } | null = null,
): Promise<number> {
  const result = await reconcileUnpricedCostEventsDetailed(db, companyId, window);
  return result.updated;
}

/** Same as {@link reconcileUnpricedCostEvents}, but reports both counters. */
export async function reconcileUnpricedCostEventsDetailed(
  db: Db,
  companyId: string,
  window: { from: Date; to: Date } | null = null,
): Promise<ReconcileResult> {
  // Per-run gateway spend for this company. Window bounds are advisory:
  // rows already collected outside the window still reconcile their runs,
  // because the vendor ledger row they fill may sit at the run boundary.
  const spendConditions = [eq(litellmCostEvents.companyId, companyId)];
  if (window?.from) spendConditions.push(gte(litellmCostEvents.occurredAt, window.from));
  if (window?.to) spendConditions.push(lt(litellmCostEvents.occurredAt, window.to));
  const spendByRun = await db
    .select({
      runId: litellmCostEvents.heartbeatRunId,
      costCents: sql<number>`coalesce(sum(${litellmCostEvents.costCents}), 0)::int`,
    })
    .from(litellmCostEvents)
    .where(and(...spendConditions, isNotNull(litellmCostEvents.heartbeatRunId)))
    .groupBy(litellmCostEvents.heartbeatRunId);
  const runSpend = new Map<string, number>();
  for (const row of spendByRun) {
    if (row.runId) runSpend.set(row.runId, Number(row.costCents) || 0);
  }

  // Unpriced hermes_gateway rows, newest first; a run with collected spend
  // may have several ledger rows (retries) — each is filled with that run's
  // sum, because the run's costCents=0 rows are all the same run's unpriced
  // artifact.
  const unpricedConditions = [
    eq(costEvents.companyId, companyId),
    eq(costEvents.provider, HERMES_GATEWAY_PROVIDER),
    eq(costEvents.costStatus, COST_STATUS_UNPRICED),
  ];
  if (window?.from) unpricedConditions.push(gte(costEvents.occurredAt, window.from));
  const unpriced = await db
    .select({
      id: costEvents.id,
      heartbeatRunId: costEvents.heartbeatRunId,
      agentId: costEvents.agentId,
    })
    .from(costEvents)
    .where(and(...unpricedConditions))
    .orderBy(costEvents.occurredAt)
    .limit(5_000);

  let updated = 0;
  let stillUnpriced = 0;
  const touchedAgentIds = new Set<string>();
  for (const row of unpriced) {
    const spendCents = row.heartbeatRunId ? runSpend.get(row.heartbeatRunId) ?? 0 : 0;
    if (spendCents <= 0) {
      // No gateway spend collected for this run yet: leave it unpriced — a
      // later sweep may still collect it. Never invent a price.
      stillUnpriced += 1;
      continue;
    }
    await db
      .update(costEvents)
      .set({ costCents: spendCents, costStatus: COST_STATUS_REPORTED })
      .where(eq(costEvents.id, row.id));
    updated += 1;
    touchedAgentIds.add(row.agentId);
  }

  if (updated > 0) {
    await refreshMonthlySpendTotals(db, companyId, touchedAgentIds);
  }
  return { updated, stillUnpriced };
}

/**
 * Refresh the denormalized monthly-spend counters the same way
 * costService.createEvent does (agents.spentMonthlyCents,
 * companies.spentMonthlyCents), so the dashboard tile and agent cards move
 * the moment the reconcile fills rows.
 */
async function refreshMonthlySpendTotals(db: Db, companyId: string, agentIds: Set<string>): Promise<void> {
  const monthStart = new Date(
    Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1, 0, 0, 0, 0),
  );
  const sumCents = sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`;

  const [companyRow] = await db
    .select({ total: sumCents })
    .from(costEvents)
    .where(
      and(
        eq(costEvents.companyId, companyId),
        gte(costEvents.occurredAt, monthStart),
      ),
    );
  await db
    .update(companies)
    .set({ spentMonthlyCents: Number(companyRow?.total ?? 0), updatedAt: new Date() })
    .where(eq(companies.id, companyId));

  for (const agentId of agentIds) {
    const [agentRow] = await db
      .select({ total: sumCents })
      .from(costEvents)
      .where(
        and(
          eq(costEvents.companyId, companyId),
          eq(costEvents.agentId, agentId),
          gte(costEvents.occurredAt, monthStart),
        ),
      );
    await db
      .update(agents)
      .set({ spentMonthlyCents: Number(agentRow?.total ?? 0), updatedAt: new Date() })
      .where(eq(agents.id, agentId));
  }
}