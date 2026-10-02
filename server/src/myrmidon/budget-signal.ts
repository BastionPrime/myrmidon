// server/src/myrmidon/budget-signal.ts
//
// myrmidon(M3): when a budget hard-stop is reached, the owner gets a signal
// delivered into the threads of the issues the stop actually interrupted,
// instead of a silent cancel. Vendor behaviour pauses the scope, cancels the
// runs and drops the queued wakeups; the only trace left in an issue is a
// cancelled run row. The person who can continue the work (raise the budget
// on the Costs screen or keep the scope paused) learns about it only if they
// happen to open the decision inbox.
//
// Design in one breath:
//  - One signal per incident per issue. The vendor already dedupes incidents
//    per (policy, window, threshold) — the hook fires only when the hard
//    incident was just CREATED, so window churn cannot re-fire it; and the
//    comment writer refuses a second comment whose metadata carries the same
//    signal key (budget-signal:<incidentId>:<issueId>).
//  - The signal is a system-notice comment (the same shape the recovery
//    notices use): what stopped, why, and the two ways to continue.
//  - Issues are selected from live rows: open issues of the scope whose
//    cancancellable runs were just cancelled by the budget stop, or — when the
//    stop cancelled no runs — the issue whose cost event tripped the limit.
//  - Delivery is best-effort and never breaks budget enforcement: every
//    failure is logged and swallowed — a failed signal must not leave the
//    ledger write half-done.
//  - MYRMIDON_BUDGET_SIGNAL_MODE=off disables the whole thing (on by default;
//    the feature is a notice, not a safety mechanism).

import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import type { IssueCommentMetadata, IssueCommentPresentation } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

export const BUDGET_SIGNAL_MODE_ENV = "MYRMIDON_BUDGET_SIGNAL_MODE";

/** Reason string cancelBudgetScopeWork passes to cancelRunInternal. */
export const BUDGET_CANCEL_REASON = "Cancelled due to budget pause";

/** Input the vendor hook receives; everything the signal text needs. */
export interface BudgetHardStopSignalInput {
  companyId: string;
  policyId: string;
  scopeType: "company" | "agent" | "project";
  scopeId: string;
  scopeName: string;
  amountLimit: number;
  amountObserved: number;
  windowStart: Date;
  windowEnd: Date;
  incidentId: string;
  approvalId: string | null;
}

/** Ports so tests can stub the comment service boundary. */
export interface BudgetSignalPorts {
  addComment(
    issueId: string,
    body: string,
    actor: { agentId?: string; userId?: string; runId?: string | null },
    options: {
      authorType: "system";
      presentation: IssueCommentPresentation;
      metadata: IssueCommentMetadata;
    },
  ): Promise<unknown>;
  now(): Date;
  log: Pick<typeof logger, "info" | "warn">;
}

export function budgetSignalEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const mode = env[BUDGET_SIGNAL_MODE_ENV]?.trim().toLowerCase();
  return mode !== "off";
}

export function budgetSignalKey(incidentId: string, issueId: string): string {
  return `budget-signal:${incidentId}:${issueId}`;
}

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function scopeLabel(scopeType: BudgetHardStopSignalInput["scopeType"]): string {
  if (scopeType === "company") return "organization";
  return scopeType;
}

/** The signal text: cause, what stopped, and how to continue. English, neutral. */
export function buildBudgetHardStopBody(input: BudgetHardStopSignalInput): string {
  return [
    "The spend budget hard-stop was reached, so work in this scope is paused.",
    "",
    `- Scope: ${scopeLabel(input.scopeType)} "${input.scopeName}"`,
    `- Limit: ${formatUsd(input.amountLimit)} (observed spend: ${formatUsd(input.amountObserved)})`,
    `- Window: ${input.windowStart.toISOString().slice(0, 10)} to ${input.windowEnd.toISOString().slice(0, 10)}`,
    "",
    "Active runs in the scope were cancelled and queued wakeups were dropped; the assignee cannot continue this task until the budget stop is resolved.",
    "",
    "To continue: raise the budget (Costs \u2192 Budgets, or the decision inbox card) and the paused scope resumes; or keep the scope paused to hold the spend.",
  ].join("\n");
}

export function buildBudgetHardStopPresentation(): IssueCommentPresentation {
  return {
    kind: "system_notice",
    tone: "warning",
    title: "Budget hard stop reached",
    detailsDefaultOpen: true,
  };
}

export function buildBudgetHardStopMetadata(
  input: Pick<BudgetHardStopSignalInput, "incidentId" | "policyId" | "scopeType" | "scopeName" | "amountLimit" | "amountObserved" | "windowStart" | "windowEnd">,
  issueId: string,
  issueIdentifier: string | null,
): IssueCommentMetadata {
  return {
    version: 1,
    sections: [
      {
        title: "Budget stop",
        rows: [
          { type: "key_value", label: "Signal key", value: budgetSignalKey(input.incidentId, issueId) },
          { type: "key_value", label: "Scope", value: `${scopeLabel(input.scopeType)}: ${input.scopeName}` },
          { type: "key_value", label: "Policy", value: input.policyId },
          { type: "key_value", label: "Limit (cents)", value: String(input.amountLimit) },
          { type: "key_value", label: "Observed (cents)", value: String(input.amountObserved) },
          { type: "key_value", label: "Window", value: `${input.windowStart.toISOString()} to ${input.windowEnd.toISOString()}` },
          { type: "key_value", label: "Incident", value: input.incidentId },
          { type: "key_value", label: "Issue", value: issueIdentifier ?? issueId },
        ],
      },
    ],
  };
}

/**
 * The open issue threads a hard stop should signal:
 *  - issues whose (still open, i.e. todo/in_progress) runs carry the budget
 *    cancel reason — the runs the stop actually interrupted (contextSnapshot
 *    holds the issue, the same field the cost ledger reads);
 *  - when the stop interrupted no open issue (a limit crossed by spend on a
 *    closed task, or from the settings page), the scope's open issues for an
 *    agent scope — their queued wakeups were dropped too. A company scope
 *    with no interrupted run signals nothing: there is no single thread that
 *    speaks for the whole organization, and the inbox card already exists.
 *
 * Read-only; no lock is taken (the comment write is separately deduped).
 */
export async function listBudgetStopIssueIds(
  db: Db,
  input: Pick<BudgetHardStopSignalInput, "companyId" | "scopeType" | "scopeId">,
  now: Date,
): Promise<string[]> {
  const cutoff = new Date(now.getTime() - 15 * 60_000);
  const cancelledIssues = await db
    .select({ issueId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'` })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.error, BUDGET_CANCEL_REASON),
        gte(heartbeatRuns.finishedAt, cutoff),
      ),
    )
    .limit(200);
  const ids = new Set<string>();
  for (const row of cancelledIssues) {
    if (row.issueId) ids.add(row.issueId);
  }

  if (input.scopeType === "agent" && ids.size === 0) {
    const assigned = await db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, input.companyId),
          eq(issues.assigneeAgentId, input.scopeId),
          inArray(issues.status, ["todo", "in_progress"]),
        ),
      )
      .limit(50);
    for (const row of assigned) ids.add(row.id);
  }

  if (ids.size === 0) return [];
  const open = await db
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, input.companyId),
        inArray(issues.id, [...ids]),
        inArray(issues.status, ["todo", "in_progress", "in_review"]),
      ),
    );
  return open.map((row) => row.id);
}

/** True when an issue already carries this incident's signal comment. */
async function hasBudgetSignalComment(
  db: Db,
  companyId: string,
  incidentId: string,
  issueId: string,
): Promise<boolean> {
  const key = budgetSignalKey(incidentId, issueId);
  const existing = await db
    .select({ id: issueComments.id })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, companyId),
        eq(issueComments.issueId, issueId),
        eq(issueComments.authorType, "system"),
        sql`${issueComments.metadata} -> 'sections' -> 0 -> 'rows' -> 0 ->> 'value' = ${key}`,
      ),
    )
    .limit(1);
  return Boolean(existing[0]);
}

/**
 * Deliver the signal: one comment per (incident, issue). Never throws — the
 * budget enforcement that called it has already committed its own state.
 */
export async function deliverBudgetHardStopSignal(
  db: Db,
  ports: BudgetSignalPorts,
  input: BudgetHardStopSignalInput,
): Promise<{ issueIds: string[]; written: number }> {
  const log = ports.log;
  let written = 0;
  const issueIds: string[] = [];
  try {
    const candidates = await listBudgetStopIssueIds(
      db,
      { companyId: input.companyId, scopeType: input.scopeType, scopeId: input.scopeId },
      ports.now(),
    );
    for (const issueId of candidates) {
      try {
        if (await hasBudgetSignalComment(db, input.companyId, input.incidentId, issueId)) continue;
        const [issue] = await db
          .select({ identifier: issues.identifier })
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.companyId, input.companyId)))
          .limit(1);
        await ports.addComment(
          issueId,
          buildBudgetHardStopBody(input),
          {},
          {
            authorType: "system",
            presentation: buildBudgetHardStopPresentation(),
            metadata: buildBudgetHardStopMetadata(input, issueId, issue?.identifier ?? null),
          },
        );
        written += 1;
        issueIds.push(issueId);
      } catch (err) {
        log.warn({ err, issueId, incidentId: input.incidentId }, "budget hard-stop signal delivery failed for one issue");
      }
    }
    if (written > 0) {
      log.info(
        { companyId: input.companyId, incidentId: input.incidentId, issueIds, written },
        "budget hard-stop signal delivered to issue threads",
      );
    }
  } catch (err) {
    log.warn({ err, incidentId: input.incidentId }, "budget hard-stop signal failed");
  }
  return { issueIds, written };
}
