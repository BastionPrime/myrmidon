// server/src/myrmidon/tracing-health/attention-probe.ts
//
// myrmidon(TRACING-HEALTH): the probe the attention generator runs.
//
// The route (routes.ts) serves reports from its closure cache and answers
// 503 with `enabled: false` when unconfigured — both are wrong shapes for
// the attention sweep, which needs a plain report or a fast "off". This
// helper reuses the same probe functions, the same settings reader and the
// same gateway-key wiring, but computes a fresh report with no route-level
// cache and reports `enabled: false, state: "unknown"` as data (never an
// exception): the generator must not cry wolf on an unconfigured instance
// (state "unknown" is not degraded — no card) and must not take the feed
// down when the probes are slow.
//
// A TTL in-process cache keeps the sweep cheap: the board attention feed is
// polled far more often than tracing changes, and the probes hit the gateway
// and ClickHouse.

import { companies } from "@paperclipai/db";
import { isNotNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { secretService } from "../../services/index.js";
import { createLitellmGatewayClient } from "../litellm-costs/litellm-costs.js";
import { computeTracingHealthState, type TracingHealthReport } from "./domain.js";
import {
  callbackErrorRate,
  countEvents,
  countRejections,
  gatewayRequestCount,
  readTracingHealthSettings,
  type TracingHealthSettings,
} from "./probes.js";

export interface TracingHealthProbeDeps {
  env?: NodeJS.ProcessEnv;
  now(): Date;
  readGatewayKey(companyId: string, secretName: string): Promise<string | null>;
  listCompanyIds(): Promise<string[]>;
  client: (baseUrl: string, keyValue: string) => { listSpendLogs(window: { from: Date; to: Date }): Promise<unknown[]> };
  fetchFn: typeof fetch;
}

/** Cached report plus the cache stamp, kept in the closure of the probe. */
interface CacheSlot {
  at: number;
  report: TracingHealthReport;
}

/**
 * Build the report exactly like routes.ts `runProbes`, with overridable deps
 * for tests. No route-level 503 semantics: every failure is state "unknown".
 */
export async function probeTracingHealthReport(
  settings: TracingHealthSettings,
  now: Date,
  deps: TracingHealthProbeDeps,
): Promise<TracingHealthReport> {
  if (!settings.enabled) {
    return {
      enabled: false,
      state: "unknown",
      checkedAt: now.toISOString(),
      window: {
        from: new Date(now.getTime() - settings.windowMs).toISOString(),
        to: now.toISOString(),
      },
      evidence: {
        eventsInWindow: null,
        gatewayRequestsInWindow: null,
        callbackErrorRate: null,
        deliveryRatio: null,
        legacyRejections: null,
      },
      reason: "tracing health check is not configured",
    };
  }

  const to = now;
  const from = new Date(to.getTime() - settings.windowMs);
  const window = { from, to };

  let eventsInWindow: number | null = null;
  let gatewayRequestsInWindow: number | null = null;

  if (settings.baseUrl && settings.keySecret) {
    const companyIds = await deps.listCompanyIds().catch(() => [] as string[]);
    let keyValue: string | null = null;
    for (const companyId of companyIds) {
      keyValue = await deps
        .readGatewayKey(companyId, settings.keySecret)
        .catch(() => null as string | null);
      if (keyValue) break;
    }
    if (keyValue) {
      gatewayRequestsInWindow = await gatewayRequestCount(
        deps.client(settings.baseUrl, keyValue) as Parameters<typeof gatewayRequestCount>[0],
        window,
      );
    }
  }

  if (settings.clickhouseUrl) {
    eventsInWindow = await countEvents(window, settings, deps.fetchFn);
  }

  const deliveryRatio =
    eventsInWindow !== null && gatewayRequestsInWindow !== null && gatewayRequestsInWindow > 0
      ? eventsInWindow / gatewayRequestsInWindow
      : null;

  const evidence = {
    eventsInWindow,
    gatewayRequestsInWindow,
    callbackErrorRate: null as number | null,
    deliveryRatio,
    legacyRejections: null as number | null,
  };

  if (settings.clickhouseUrl) {
    // The 02.10 incident signature: ingestion rejecting legacy-format events.
    evidence.legacyRejections = await countRejections(window, settings, deps.fetchFn);
    if (gatewayRequestsInWindow !== null && gatewayRequestsInWindow > 0) {
      evidence.callbackErrorRate = await callbackErrorRate(window, gatewayRequestsInWindow, settings, deps.fetchFn);
    }
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
}

/**
 * The TTL-cached probe for the attention sweep. `maxAgeMs` reuses the route
 * cache TTL default (60 s) so the feed and the board card agree on the same
 * numbers within a minute.
 */
export function createTracingHealthAttentionProbe(deps: TracingHealthProbeDeps, maxAgeMs = 60_000) {
  let slot: CacheSlot | null = null;
  return {
    async report(now: Date = deps.now()): Promise<TracingHealthReport> {
      if (slot && now.getTime() - slot.at < maxAgeMs) {
        return slot.report;
      }
      const settings = readTracingHealthSettings(deps.env ?? process.env);
      const report = await probeTracingHealthReport(settings, now, deps).catch(
        (): TracingHealthReport => ({
          enabled: true,
          state: "unknown",
          checkedAt: now.toISOString(),
          window: { from: new Date(now.getTime() - settings.windowMs).toISOString(), to: now.toISOString() },
          evidence: {
            eventsInWindow: null,
            gatewayRequestsInWindow: null,
            callbackErrorRate: null,
            deliveryRatio: null,
            legacyRejections: null,
          },
          reason: "tracing health check failed",
        }),
      );
      slot = { at: now.getTime(), report };
      return report;
    },
  };
}

/** The real wiring: gateway key from the company secret store, like routes.ts. */
export function myrmidonTracingHealthAttentionProbe(db: Db) {
  const secrets = secretService(db);
  return createTracingHealthAttentionProbe({
    now: () => new Date(),
    readGatewayKey: async (companyId, secretName) => {
      const row = await secrets.getByName(companyId, secretName);
      return row ? secrets.resolveSecretValue(companyId, row.id, "latest") : null;
    },
    listCompanyIds: async () => {
      const rows = await db.select({ id: companies.id }).from(companies).where(isNotNull(companies.id));
      return rows.map((row) => row.id);
    },
    client: createLitellmGatewayClient as TracingHealthProbeDeps["client"],
    fetchFn: fetch,
  });
}
