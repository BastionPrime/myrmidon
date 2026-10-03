// server/src/myrmidon/baseline/service.ts
//
// myrmidon(1.6-BASELINE): assembles the API answer from the query slices and
// the pure math. The response shape is the one fixed in the BASELINE design
// note and is additive-only from here on.

import type { Db } from "@paperclipai/db";
import { badRequest } from "../../errors.js";
import {
  type BaselineGroupMetrics,
  type BaselineMetrics,
  type BaselineWindow,
  computeBaselineMetrics as computeGroups,
} from "./metrics.js";
import {
  type BaselineCostSource,
  detectCostSource,
  loadBlockers,
  loadCompletedTasks,
  loadCosts,
  loadRoles,
  loadRuns,
  loadTransitions,
} from "./queries.js";

export interface BaselineMetricsResponse {
  window: { from: string; to: string };
  generatedAt: string;
  source: { statusLog: string; costs: BaselineCostSource };
  byProject: BaselineGroupMetrics[];
  byRole: BaselineGroupMetrics[];
}

function parseDate(value: unknown, field: string): Date {
  if (typeof value !== "string" || value.length === 0) {
    throw badRequest(`'${field}' is required`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw badRequest(`invalid '${field}' date`);
  }
  return date;
}

/** Reads and validates the required `from`/`to` query parameters. */
export function parseBaselineWindow(query: Record<string, unknown>): BaselineWindow {
  const from = parseDate(query.from, "from");
  const to = parseDate(query.to, "to");
  if (from.getTime() > to.getTime()) {
    throw badRequest("'from' must not be after 'to'");
  }
  return { from, to };
}

/** Computes the full metrics answer for one company over one window. */
export async function computeBaselineMetrics(
  db: Db,
  companyId: string,
  window: BaselineWindow,
  now: Date,
): Promise<BaselineMetricsResponse> {
  const source = await detectCostSource(db, companyId, window);
  const tasks = await loadCompletedTasks(db, companyId, window);

  const taskIds = tasks.map((task) => task.id);
  const agentIds = [
    ...new Set(tasks.map((task) => task.assigneeAgentId).filter((id): id is string => Boolean(id))),
  ];

  const [transitions, runs, costs, blockers, roles] = await Promise.all([
    loadTransitions(db, companyId, taskIds),
    loadRuns(db, companyId, taskIds, window),
    loadCosts(db, companyId, taskIds, window, source),
    loadBlockers(db, companyId, taskIds),
    loadRoles(db, companyId, agentIds),
  ]);

  const metrics: BaselineMetrics = computeGroups(
    { tasks, transitions, runs, costs, blockers, roles },
    window,
  );

  return {
    window: { from: window.from.toISOString(), to: window.to.toISOString() },
    generatedAt: now.toISOString(),
    source: { statusLog: "activity_log", costs: source },
    byProject: metrics.byProject,
    byRole: metrics.byRole,
  };
}