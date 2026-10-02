// server/src/myrmidon/tracing-health/attention-sweep.ts
//
// myrmidon(TRACING-HEALTH part D): the periodic sweep that keeps the operator
// signal fresh. The card on the settings page is pull-driven (react-query);
// the attention desk must not depend on somebody having the page open — the
// incident was exactly "nobody looked". The sweep calls part C's report
// source (injected; the real wiring builds part C's deps, never a self-HTTP
// call), records the signal into the attention registry and writes ONE
// activity-log row per state TRANSITION (ok→degraded, degraded→ok — the
// durable trace an operator can audit; a steady state writes nothing, so a
// red pipeline does not spam the journal).
//
// Off unless part C's settings are on (MYRMIDON_LITELLM_* +
// MYRMIDON_TRACING_*): no timer, no query — the same default-off contract as
// every myrmidon sweep. server/src/index.ts gets one marked call.

import { isNotNull } from "drizzle-orm";
import { companies, type Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { logActivity } from "../../services/activity-log.js";
import { secretService } from "../../services/index.js";
import { createLitellmGatewayClient } from "../litellm-costs/litellm-costs.js";
import { readTracingHealthSettings } from "./probes.js";
import type { TracingHealthReport } from "./domain.js";
import {
  readTracingHealthAttentionSignal,
  recordTracingHealthSignal,
  TRACING_ATTENTION_ACTION_TRANSITION,
  type TracingAttentionSignal,
} from "./attention.js";

export const TRACING_SWEEP_INTERVAL_SEC_ENV = "MYRMIDON_TRACING_SIGNAL_INTERVAL_SEC";
const DEFAULT_SWEEP_INTERVAL_SEC = 300;
const MIN_SWEEP_INTERVAL_SEC = 60;
const MAX_SWEEP_INTERVAL_SEC = 86400;

export function readTracingSignalSweepIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[TRACING_SWEEP_INTERVAL_SEC_ENV]?.trim();
  if (!raw) return DEFAULT_SWEEP_INTERVAL_SEC * 1000;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < MIN_SWEEP_INTERVAL_SEC || value > MAX_SWEEP_INTERVAL_SEC) {
    return DEFAULT_SWEEP_INTERVAL_SEC * 1000;
  }
  return value * 1000;
}

export interface TracingAttentionSweepDeps {
  /** Produces the report the signal is built from (part C's report source). */
  report(companyId: string): Promise<TracingHealthReport>;
  /** Company ids to sweep (one registry slot per company). */
  listCompanyIds(): Promise<string[]>;
  /** Activity log write; failures are logged and swallowed. */
  writeActivity(input: {
    companyId: string;
    action: string;
    state: string;
    severity: string | null;
    reason: string | null;
  }): Promise<void>;
  log?: { warn(fields: object, message: string): void; error(fields: object, message: string): void };
}

export interface TracingAttentionSweeper {
  /** One pass: evaluate every company, record signals, write transitions. */
  sweep(): Promise<{ companies: number; signals: number; transitions: number }>;
  stop(): void;
}

/** The per-process record of the last written transition state. */
const lastWrittenState = new Map<string, string>();

export function createTracingAttentionSweeper(
  deps: TracingAttentionSweepDeps,
  intervalMs: number,
): TracingAttentionSweeper {
  let sweeping = false;
  let stopped = false;
  const log = deps.log ?? logger;

  async function sweep(): Promise<{ companies: number; signals: number; transitions: number }> {
    if (sweeping || stopped) return { companies: 0, signals: 0, transitions: 0 };
    sweeping = true;
    let companiesCount = 0;
    let signals = 0;
    let transitions = 0;
    try {
      const companyIds = await deps.listCompanyIds().catch(() => [] as string[]);
      companiesCount = companyIds.length;
      for (const companyId of companyIds) {
        try {
          const report = await deps.report(companyId);
          recordTracingHealthSignal(companyId, report);
          const signal: TracingAttentionSignal | null = readTracingHealthAttentionSignal(companyId);
          if (signal) signals += 1;
          // Transition = the recorded state changed since the last written
          // row (or the first time this company produces a state at all).
          const recorded = signal?.state ?? "none";
          const previous = lastWrittenState.get(companyId);
          if (recorded !== previous) {
            lastWrittenState.set(companyId, recorded);
            transitions += 1;
            await deps
              .writeActivity({
                companyId,
                action: TRACING_ATTENTION_ACTION_TRANSITION,
                state: recorded,
                severity: signal?.severity ?? null,
                reason: signal?.summary ?? null,
              })
              .catch((err) => log.warn({ err, companyId }, "tracing health signal activity write failed"));
          }
        } catch (err) {
          log.warn({ err, companyId }, "tracing health signal sweep failed for one company");
        }
      }
    } finally {
      sweeping = false;
    }
    return { companies: companiesCount, signals, transitions };
  }

  const timer = setInterval(() => {
    void sweep().catch((err) => log.error({ err }, "tracing health signal sweep tick failed"));
  }, intervalMs);
  timer.unref?.();

  return {
    sweep,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

let stopRunning: (() => void) | null = null;

/**
 * Starts the sweep; returns the stop function. A no-op when part C's
 * settings are off. The report source is part C's own probe pipeline with its
 * own cache: the sweep and the card share one probe cadence.
 */
export function startTracingAttentionSweep(
  db: Db,
  opts: {
    env?: NodeJS.ProcessEnv;
    report?: (companyId: string) => Promise<TracingHealthReport>;
  } = {},
): () => void {
  const env = opts.env ?? process.env;
  const settings = readTracingHealthSettings(env);
  if (!settings.enabled) return () => {};

  const report = opts.report ?? defaultReportSource(db, env);
  const sweeper = createTracingAttentionSweeper(
    {
      report,
      async listCompanyIds() {
        const rows = await db.select({ id: companies.id }).from(companies).where(isNotNull(companies.id));
        return rows.map((row) => row.id);
      },
      async writeActivity(input) {
        await logActivity(db, {
          companyId: input.companyId,
          actorType: "system",
          actorId: "tracing_health_sweep",
          action: input.action,
          entityType: "tracing_health",
          entityId: input.companyId,
          details: { state: input.state, severity: input.severity, reason: input.reason },
        });
      },
    },
    readTracingSignalSweepIntervalMs(env),
  );

  stopTracingAttentionSweep();
  stopRunning = sweeper.stop;
  // First pass at startup: the signal exists before anyone opens the page.
  void sweeper.sweep().catch((err) => logger.error({ err }, "tracing health first signal sweep failed"));
  return sweeper.stop;
}

/** Stops the sweep (idempotent). */
export function stopTracingAttentionSweep(): void {
  stopRunning?.();
  stopRunning = null;
}

// ---------------------------------------------------------------------------
// The default report source: part C's probe pipeline with its own TTL cache.
// Mirrors myrmidonTracingHealthRoutes' wiring (routes.ts) — the sweep and the
// route must agree on the report, so both build the same deps; injected here
// so tests never touch the network.
// ---------------------------------------------------------------------------

import {
  callbackErrorRate,
  countEvents,
  countRejections,
  gatewayRequestCount,
} from "./probes.js";
import { computeTracingHealthState, type TracingHealthEvidence } from "./domain.js";

function defaultReportSource(db: Db, env: NodeJS.ProcessEnv): (companyId: string) => Promise<TracingHealthReport> {
  const secrets = secretService(db);
  const settings = () => readTracingHealthSettings(env);

  return async () => {
    const current = settings();
    const now = new Date();
    const to = now;
    const from = new Date(to.getTime() - current.windowMs);

    let eventsInWindow: number | null = null;
    let gatewayRequestsInWindow: number | null = null;
    let callbackErrorRateValue: number | null = null;
    let legacyRejections: number | null = null;

    if (current.baseUrl && current.keySecret) {
      const rows = await db
        .select({ id: companies.id })
        .from(companies)
        .where(isNotNull(companies.id))
        .catch(() => [] as Array<{ id: string }>);
      let keyValue: string | null = null;
      for (const row of rows) {
        keyValue = await secrets
          .getByName(row.id, current.keySecret!)
          .then((secretRow) => (secretRow ? secrets.resolveSecretValue(row.id, secretRow.id, "latest") : null))
          .catch(() => null as string | null);
        if (keyValue) break;
      }
      if (keyValue) {
        gatewayRequestsInWindow = await gatewayRequestCount(
          createLitellmGatewayClient(current.baseUrl, keyValue),
          { from, to },
        );
      }
    }

    if (current.clickhouseUrl) {
      eventsInWindow = await countEvents({ from, to }, current);
      legacyRejections = await countRejections({ from, to }, current);
    }

    const deliveryRatio =
      eventsInWindow !== null && gatewayRequestsInWindow !== null && gatewayRequestsInWindow > 0
        ? eventsInWindow / gatewayRequestsInWindow
        : null;

    const evidence: TracingHealthEvidence = {
      eventsInWindow,
      gatewayRequestsInWindow,
      callbackErrorRate: callbackErrorRateValue,
      deliveryRatio,
      legacyRejections,
    };
    if (gatewayRequestsInWindow !== null && gatewayRequestsInWindow > 0 && current.clickhouseUrl) {
      evidence.callbackErrorRate = await callbackErrorRate({ from, to }, gatewayRequestsInWindow, current);
    }

    const { state, reason } = computeTracingHealthState(evidence);
    return {
      enabled: true,
      state,
      checkedAt: now.toISOString(),
      window: { from: from.toISOString(), to: to.toISOString() },
      evidence,
      reason,
    };
  };
}
