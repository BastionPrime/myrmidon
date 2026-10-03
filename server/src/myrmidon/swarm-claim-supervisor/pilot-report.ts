// myrmidon(1.6-SWARM-CLAIM-B): the pilot report — the swarm claim pilot window
// measured with the BASELINE definitions, next to the frozen BASELINE snapshot.
//
// The metrics themselves are BASELINE part A's contract
// (`GET /api/myrmidon/companies/:id/baseline/metrics`): this module calls that
// endpoint for the pilot window (the same numbers, the same definitions, no
// second math) and reads the frozen snapshot from the issue document named by
// `MYRMIDON_SWARM_PILOT_BASELINE_DOC`. Until the snapshot exists the report
// answers `baseline: null` with an explanatory note — there is nothing to
// compare a window against yet.

import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { readSwarmSupervisorSettings } from "./settings.js";

/** The shape BASELINE part A returns (and the snapshot stores). */
export interface BaselineMetricRowJson {
  key: string | null;
  tasksCompleted: number;
  cycleTimeHours: { mean: number; median: number; p90: number };
  timeInReviewHours: { mean: number; median: number };
  returnRate: { enteredReview: number; returned: number; rate: number };
  blockedHours: { total: number; mean: number; topCauses: { cause: string; hours: number }[] };
  runsPerTask: { total: number; mean: number };
  costPerTask: { totalCents: number; meanCents: number };
}

export interface BaselineMetricsReportJson {
  window: { from: string; to: string };
  generatedAt: string;
  source: { statusLog: string; costs: string };
  byProject: BaselineMetricRowJson[];
  byRole: BaselineMetricRowJson[];
}

export interface SwarmComparisonMetric {
  pilot: number | null;
  baseline: number | null;
  deltaPercent: number | null;
}

export interface SwarmPilotReport {
  window: { from: string; to: string } | null;
  enabled: boolean;
  generatedAt: string;
  pilot: BaselineMetricsReportJson | null;
  baseline: BaselineMetricsReportJson | null;
  comparison: {
    cycleTimeHoursMean: SwarmComparisonMetric;
    returnRate: SwarmComparisonMetric;
    timeInReviewHoursMean: SwarmComparisonMetric;
    costPerTaskMeanCents: SwarmComparisonMetric;
  };
  notes: string[];
}

export class SwarmPilotNotEnabledError extends Error {
  readonly code = "swarm_pilot_not_enabled";
  constructor() {
    super("swarm claim pilot report is not enabled");
    this.name = "SwarmPilotNotEnabledError";
  }
}

export class SwarmPilotWindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwarmPilotWindowError";
  }
}

export interface SwarmPilotDeps {
  /** Calls BASELINE part A's metrics endpoint (the frozen contract). */
  fetchBaselineMetrics(companyId: string, from: string, to: string): Promise<BaselineMetricsReportJson | null>;
  /** Reads the frozen BASELINE snapshot document body. */
  readBaselineSnapshot(companyId: string, documentKey: string): Promise<{ body: string } | null>;
  /** Whether the swarm claim pilot flag is on (part A's setting, read-only). */
  pilotEnabled(): Promise<boolean>;
  env?: NodeJS.ProcessEnv;
  now(): Date;
}

const DEFAULT_PILOT_WINDOW_DAYS = 14;

export function parsePilotWindow(
  from: unknown,
  to: unknown,
  now: () => Date,
): { from: Date; to: Date } {
  const fromMs = typeof from === "string" ? Date.parse(from) : Number.NaN;
  if (typeof from !== "string" || Number.isNaN(fromMs)) {
    throw new SwarmPilotWindowError("from must be an ISO date");
  }
  const toMs = typeof to === "string" ? Date.parse(to) : Number.NaN;
  if (typeof to !== "string" || Number.isNaN(toMs)) {
    throw new SwarmPilotWindowError("to must be an ISO date");
  }
  if (toMs <= fromMs) {
    throw new SwarmPilotWindowError("to must be after from");
  }
  if (toMs > now().getTime() + 60_000) {
    throw new SwarmPilotWindowError("to must not be in the future");
  }
  return { from: new Date(fromMs), to: new Date(toMs) };
}

/** The default window: the last 14 days, floored to the minute. */
export function defaultPilotWindow(now: () => Date): { from: string; to: string } {
  const to = new Date(now());
  to.setSeconds(0, 0);
  const from = new Date(to);
  from.setDate(from.getDate() - DEFAULT_PILOT_WINDOW_DAYS);
  return { from: from.toISOString(), to: to.toISOString() };
}

/** Compute one comparison metric: pilot vs baseline with a signed delta %. */
export function compareMetric(
  pilot: number | null,
  baseline: number | null,
): SwarmComparisonMetric {
  if (pilot === null || baseline === null) {
    return { pilot, baseline, deltaPercent: null };
  }
  if (baseline === 0) {
    return { pilot, baseline, deltaPercent: null };
  }
  return { pilot, baseline, deltaPercent: round2(((pilot - baseline) / baseline) * 100) };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function roleMeanCycleTime(report: BaselineMetricsReportJson | null): number | null {
  return meanOverRows(report, (row) => row.cycleTimeHours?.mean ?? null);
}

function roleMeanReturnRate(report: BaselineMetricsReportJson | null): number | null {
  return meanOverRows(report, (row) => row.returnRate?.rate ?? null);
}

function roleMeanReviewHours(report: BaselineMetricsReportJson | null): number | null {
  return meanOverRows(report, (row) => row.timeInReviewHours?.mean ?? null);
}

function roleMeanCostCents(report: BaselineMetricsReportJson | null): number | null {
  return meanOverRows(report, (row) => row.costPerTask?.meanCents ?? null);
}

function meanOverRows(
  report: BaselineMetricsReportJson | null,
  read: (row: BaselineMetricRowJson) => number | null,
): number | null {
  if (!report) return null;
  const values = [...(report.byRole ?? []), ...(report.byProject ?? [])]
    .map(read)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (values.length === 0) return null;
  return round2(values.reduce((sum, value) => sum + value, 0) / values.length);
}

export async function swarmPilotReport(
  deps: SwarmPilotDeps,
  companyId: string,
  fromInput?: string,
  toInput?: string,
): Promise<SwarmPilotReport> {
  const settings = readSwarmSupervisorSettings(deps.env ?? process.env);
  const generatedAt = new Date(deps.now()).toISOString();
  const enabled = await deps.pilotEnabled();
  if (!enabled) {
    throw new SwarmPilotNotEnabledError();
  }

  const window =
    fromInput || toInput
      ? (() => {
          const parsed = parsePilotWindow(fromInput, toInput, deps.now);
          return { from: parsed.from.toISOString(), to: parsed.to.toISOString() };
        })()
      : defaultPilotWindow(deps.now);

  const notes: string[] = [];
  let pilot: BaselineMetricsReportJson | null = null;
  try {
    pilot = await deps.fetchBaselineMetrics(companyId, window.from, window.to);
  } catch {
    pilot = null;
    notes.push("baseline metrics for the pilot window are not available");
  }
  if (pilot && (pilot.byProject?.length ?? 0) === 0 && (pilot.byRole?.length ?? 0) === 0) {
    notes.push("the pilot window has no completed tasks");
  }

  let baseline: BaselineMetricsReportJson | null = null;
  try {
    const snapshot = await deps.readBaselineSnapshot(companyId, settings.baselineDocumentKey);
    baseline = snapshot ? parseSnapshot(snapshot.body) : null;
  } catch {
    baseline = null;
  }
  if (!baseline) {
    notes.push(
      `no frozen BASELINE snapshot under document key ${settings.baselineDocumentKey}; the report answers baseline: null until it exists`,
    );
  }

  return {
    window,
    enabled: true,
    generatedAt,
    pilot,
    baseline,
    comparison: {
      cycleTimeHoursMean: compareMetric(roleMeanCycleTime(pilot), roleMeanCycleTime(baseline)),
      returnRate: compareMetric(roleMeanReturnRate(pilot), roleMeanReturnRate(baseline)),
      timeInReviewHoursMean: compareMetric(roleMeanReviewHours(pilot), roleMeanReviewHours(baseline)),
      costPerTaskMeanCents: compareMetric(roleMeanCostCents(pilot), roleMeanCostCents(baseline)),
    },
    notes,
  };
}

/** The snapshot is stored as the metrics JSON (optionally in a fenced block). */
export function parseSnapshot(body: string): BaselineMetricsReportJson | null {
  const fenced = body.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = fenced ? [fenced[1], body] : [body];
  for (const candidate of candidates) {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) continue;
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1)) as BaselineMetricsReportJson;
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.byProject) && Array.isArray(parsed.byRole)) {
        return parsed;
      }
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** DB-backed deps: the snapshot is an issue document of the pilot company. */
export function createSwarmPilotDeps(
  db: Db,
  env: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date(),
): SwarmPilotDeps {
  return {
    async fetchBaselineMetrics(companyId, from, to) {
      const rows = await db.execute(sql`
        SELECT payload
        FROM baseline_metric_snapshots
        WHERE company_id = ${companyId}
          AND window_to <= ${to}
          AND window_from >= ${from}
        ORDER BY window_to DESC
        LIMIT 1
      `);
      const first = Array.isArray(rows) ? rows[0] : null;
      if (!first || typeof first !== "object") return null;
      const payload = (first as Record<string, unknown>).payload;
      if (!payload || typeof payload !== "object") return null;
      return payload as unknown as BaselineMetricsReportJson;
    },
    async readBaselineSnapshot(companyId, documentKey) {
      const rows = await db.execute(sql`
        SELECT d.latest_body AS body
        FROM documents d
        JOIN issue_documents idoc ON idoc.document_id = d.id AND idoc.company_id = d.company_id
        WHERE d.company_id = ${companyId}
          AND idoc.key = ${documentKey}
        ORDER BY d.updated_at DESC
        LIMIT 1
      `);
      const first = Array.isArray(rows) ? rows[0] : null;
      if (!first || typeof first !== "object") return null;
      const body = (first as Record<string, unknown>).body;
      return typeof body === "string" ? { body } : null;
    },
    async pilotEnabled() {
      const raw = env.MYRMIDON_SWARM_CLAIM_ENABLED?.trim().toLowerCase();
      return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
    },
    env,
    now,
  };
}