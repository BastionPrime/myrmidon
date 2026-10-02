// server/src/myrmidon/tracing-health/routes.ts
//
// myrmidon(TRACING-HEALTH): GET /api/myrmidon/tracing/health.
//
// A board-side health check for LLM tracing: whether trace events keep
// flowing while the gateway serves traffic. The response shape is frozen
// for part D (the attention/card side) — see domain.ts.
//
//  - Any board user can read (assertBoardOrgAccess, like the stack registry).
//  - Off (either gateway or ClickHouse setting unset, the default): 503 with
//    `{ enabled: false, state: "unknown", ... }`, the same convention as the
//    litellm-costs routes.
//  - Any probe failure is state "unknown" with a reason in the JSON contract,
//    never a 500 and never a board crash: the route-level catch mirrors the
//    stack-registry routes (503 + the previous cached report).
//  - Probes run at most once per cache TTL; within the TTL the previous
//    report is served (checkedAt shows when it was actually measured).
//  - No secrets or addresses in the response; the gateway address comes from
//    the same env row as litellm-costs and never leaves the process.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import { isNotNull } from "drizzle-orm";
import { secretService } from "../../services/index.js";
import { logger } from "../../middleware/logger.js";
import { assertBoardOrgAccess } from "../../routes/authz.js";
import { createLitellmGatewayClient, type LitellmGatewayClient } from "../litellm-costs/litellm-costs.js";
import {
  computeTracingHealthState,
  type TracingHealthEvidence,
  type TracingHealthReport,
  type TracingHealthState,
} from "./domain.js";
import {
  callbackErrorRate,
  countEvents,
  countRejections,
  gatewayRequestCount,
  readTracingHealthSettings,
  type TracingHealthSettings,
} from "./probes.js";

export interface TracingHealthRoutesDeps {
  env?: NodeJS.ProcessEnv;
  now(): Date;
  /** Gateway key value from the company secret store. */
  readGatewayKey(companyId: string, secretName: string): Promise<string | null>;
  /** Company ids whose secrets may hold the gateway key. */
  listCompanyIds(): Promise<string[]>;
  /** Client factory, overridable in tests. */
  client: (baseUrl: string, keyValue: string) => Pick<LitellmGatewayClient, "listSpendLogs">;
  /** ClickHouse query port, overridable in tests. */
  fetchFn: typeof fetch;
  log?: { warn(fields: object, message: string): void; error(fields: object, message: string): void };
}

export function tracingHealthRoutes(db: Db, deps: TracingHealthRoutesDeps) {
  const router = Router();
  const settings = () => readTracingHealthSettings(deps.env ?? process.env);
  let cached: TracingHealthReport | null = null;

  const emptyEvidence = (): TracingHealthEvidence => ({
    eventsInWindow: null,
    gatewayRequestsInWindow: null,
    callbackErrorRate: null,
    deliveryRatio: null,
    legacyRejections: null,
  });

  const disabledReport = (now: Date, windowMs: number): TracingHealthReport => ({
    enabled: false,
    state: "unknown",
    checkedAt: now.toISOString(),
    window: {
      from: new Date(now.getTime() - windowMs).toISOString(),
      to: now.toISOString(),
    },
    evidence: emptyEvidence(),
    reason: "tracing health check is not configured",
  });

  async function runProbes(current: TracingHealthSettings, now: Date): Promise<TracingHealthReport> {
    const to = now;
    const from = new Date(to.getTime() - current.windowMs);
    const window = { from, to };

    let eventsInWindow: number | null = null;
    let gatewayRequestsInWindow: number | null = null;
    let callbackErrorRateValue: number | null = null;
    let legacyRejections: number | null = null;

    // Gateway traffic: count /spend/logs/v2 rows over the window for the
    // first company whose secret resolves — the gateway is instance-wide.
    if (current.baseUrl && current.keySecret) {
      const companyIds = await deps.listCompanyIds().catch(() => [] as string[]);
      let keyValue: string | null = null;
      for (const companyId of companyIds) {
        keyValue = await deps
          .readGatewayKey(companyId, current.keySecret)
          .catch(() => null as string | null);
        if (keyValue) break;
      }
      if (keyValue) {
        gatewayRequestsInWindow = await gatewayRequestCount(deps.client(current.baseUrl, keyValue), window);
      }
      // No key anywhere: the traffic probe failed — "unknown", not a 500.
    }

    if (current.clickhouseUrl) {
      eventsInWindow = await countEvents(window, current, deps.fetchFn);
      // The 02.10 incident signature: ingestion rejecting legacy-format
      // events. Any count above zero in the window is degraded.
      legacyRejections = await countRejections(window, current, deps.fetchFn);
    }

    // Delivery ratio: OTEL events delivered per gateway request over the
    // window. null without data on either side or without traffic — never
    // blocks the state machine.
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
    // The callback error rate needs the traffic count first.
    if (gatewayRequestsInWindow !== null && gatewayRequestsInWindow > 0 && current.clickhouseUrl) {
      evidence.callbackErrorRate = await callbackErrorRate(window, gatewayRequestsInWindow, current, deps.fetchFn);
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

  router.get("/myrmidon/tracing/health", async (_req, res) => {
    assertBoardOrgAccess(_req);
    const current = settings();
    if (!current.enabled) {
      const now = deps.now();
      res.status(503).json(disabledReport(now, current.windowMs));
      return;
    }
    const now = deps.now();
    const fresh = !cached || now.getTime() - Date.parse(cached.checkedAt) >= current.cacheTtlMs;
    if (fresh) {
      try {
        cached = await runProbes(current, now);
      } catch (error) {
        // A broken probe must not take the board down: keep the previous
        // report and answer 503 with it (the stack-registry pattern).
        (deps.log ?? logger).error({ err: error }, "tracing health check failed");
        if (cached) {
          res.status(503).json(cached);
          return;
        }
        const to = now;
        const from = new Date(to.getTime() - current.windowMs);
        res.status(503).json({
          enabled: true,
          state: "unknown" as TracingHealthState,
          checkedAt: now.toISOString(),
          window: { from: from.toISOString(), to: to.toISOString() },
          evidence: emptyEvidence(),
          reason: "tracing health check failed",
        });
        return;
      }
    }
    res.json(cached);
  });

  return router;
}

/** The real wiring: gateway key from the company secret store, like litellm-costs. */
export function myrmidonTracingHealthRoutes(db: Db) {
  const secrets = secretService(db);
  return tracingHealthRoutes(db, {
    now: () => new Date(),
    readGatewayKey: async (companyId, secretName) => {
      const row = await secrets.getByName(companyId, secretName);
      return row ? secrets.resolveSecretValue(companyId, row.id, "latest") : null;
    },
    listCompanyIds: async () => {
      const rows = await db.select({ id: companies.id }).from(companies).where(isNotNull(companies.id));
      return rows.map((row) => row.id);
    },
    client: createLitellmGatewayClient,
    fetchFn: fetch,
  });
}
