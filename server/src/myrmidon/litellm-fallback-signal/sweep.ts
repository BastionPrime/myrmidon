// server/src/myrmidon/litellm-fallback-signal/sweep.ts
//
// myrmidon(BOT-RUNTIME-TUNING D): the periodic sweep that computes the model
// fallback share and records the attention signals.
//
// Reads the gateway's spend log over the window (through the existing
// litellm-costs client — this module never builds its own HTTP), maps each
// row to an agent by the sha256 of the bot's virtual key (bot-keys.ts), loads
// every agent's card model set, computes the shares and writes the signals
// into the process-level registry the attention feed reads on every list.
// Per-company, per-sweep isolation like the other myrmidon sweeps: one
// company's failure is logged and never stops the tick.
//
// Off unless MYRMIDON_MODEL_FALLBACK_ENABLED is set (deployment values stay
// off by default). The gateway itself must already be configured
// (MYRMIDON_LITELLM_BASE_URL + MYRMIDON_LITELLM_KEY_SECRET) — the same
// master-key secret litellm-costs reads; without it the sweep logs one warn
// per first tick and stays idle, it does not fail the server.

import { and, eq, ne, isNotNull } from "drizzle-orm";
import { agents, companies, type Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { secretService } from "../../services/index.js";
import {
  botKeyIndex,
  createLitellmGatewayClient,
  type LitellmGatewayClient,
  type SpendLogEntry,
  readLitellmCostSettings,
} from "../litellm-costs/litellm-costs.js";
import { listGatewayBotKeys } from "../litellm-costs/bot-keys.js";
import {
  cardModelSet,
  fallbackShares,
  fallbackSignalForShare,
  shareClearsSignal,
  shareTripsSignal,
  readFallbackSignalSettings,
  recordModelFallbackSignals,
  type FallbackCall,
  type FallbackSignalSettings,
  type ModelFallbackAttentionSignal,
} from "./attention.js";

export interface FallbackSweepDeps {
  /** Spend-log read for the window; overridden in tests (mock, no network). */
  listSpendLogs(companyId: string, window: { from: Date; to: Date }): Promise<SpendLogEntry[]>;
  /** Bot virtual keys for attribution: agentId -> key value. */
  listBotKeys(companyId: string): Promise<Array<{ agentId: string; keyValue: string }>>;
  /** The gateway master key (PROXY_ADMIN) from the company secret store. */
  readGatewayKey(companyId: string, secretName: string): Promise<string | null>;
  /** Agent cards of the company: agentId -> adapterConfig. */
  listAgentCards(companyId: string): Promise<Array<{ agentId: string; adapterConfig: Record<string, unknown> | null }>>;
  /** Company ids to sweep. */
  listCompanyIds(): Promise<string[]>;
  now(): Date;
  log?: { info(fields: object, message: string): void; warn(fields: object, message: string): void; error(fields: object, message: string): void };
}

export interface FallbackSweepResult {
  companies: number;
  signals: number;
}

/**
 * One sweep for every company: entries -> fallback shares -> signals. Pure
 * plumbing around the policy in attention.ts; exported for tests.
 */
export async function sweepModelFallbackSignals(
  deps: FallbackSweepDeps,
  settings: FallbackSignalSettings,
): Promise<FallbackSweepResult> {
  const log = deps.log ?? logger;
  let signalsTotal = 0;
  let companies = 0;
  const companyIds = await deps.listCompanyIds().catch(() => [] as string[]);
  companies = companyIds.length;
  for (const companyId of companyIds) {
    try {
      const to = deps.now();
      const from = new Date(to.getTime() - settings.windowMs);
      const entries = await deps.listSpendLogs(companyId, { from, to });
      const keys = botKeyIndex(await deps.listBotKeys(companyId));
      const modelSetByAgent = new Map<string, Set<string>>();
      for (const card of await deps.listAgentCards(companyId)) {
        modelSetByAgent.set(card.agentId, cardModelSet(card.adapterConfig));
      }
      const calls: FallbackCall[] = [];
      for (const entry of entries) {
        const agentId = entry.apiKey ? keys.get(entry.apiKey) ?? null : null;
        if (!agentId) continue;
        calls.push({ agentId, model: entry.model, startTime: entry.startTime });
      }
      const signals: ModelFallbackAttentionSignal[] = [];
      for (const share of fallbackShares(calls, modelSetByAgent)) {
        if (!shareTripsSignal(share, settings)) continue;
        signals.push(fallbackSignalForShare(share, settings, to.toISOString()));
      }
      recordModelFallbackSignals(companyId, signals);
      signalsTotal += signals.length;
      log.info(
        { companyId, calls: calls.length, signals: signals.length, window: { from: from.toISOString(), to: to.toISOString() } },
        "model fallback signal sweep done",
      );
    } catch (err) {
      log.warn({ err, companyId }, "model fallback signal sweep failed for one company");
    }
  }
  return { companies, signals: signalsTotal };
}

// ---------------------------------------------------------------------------
// Timer wiring (start/stop; one marked call from server/src/index.ts)
// ---------------------------------------------------------------------------

export function startModelFallbackSignalSweep(
  db: Db,
  opts: { env?: NodeJS.ProcessEnv; deps?: Partial<FallbackSweepDeps> } = {},
): () => void {
  const env = opts.env ?? process.env;
  const settings = readFallbackSignalSettings(env);
  if (!settings.enabled) return () => {};
  const costSettings = readLitellmCostSettings(env);
  const log = opts.deps?.log ?? logger;

  const deps: FallbackSweepDeps = {
    async listSpendLogs(companyId, window) {
      if (!costSettings.enabled || !costSettings.baseUrl || !costSettings.keySecret) {
        log.warn({ companyId }, "model fallback sweep needs the gateway settings (MYRMIDON_LITELLM_*) to read spend logs");
        return [];
      }
      const keyValue = await defaultReadGatewayKey(db, companyId, costSettings.keySecret);
      if (!keyValue) {
        log.warn({ companyId, secret: costSettings.keySecret }, "model fallback sweep: gateway key secret not found");
        return [];
      }
      const client: LitellmGatewayClient = createLitellmGatewayClient(costSettings.baseUrl, keyValue);
      return client.listSpendLogs(window);
    },
    listBotKeys(companyId) {
      return listGatewayBotKeys(db, companyId, env);
    },
    async listAgentCards(companyId) {
      const rows = await db
        .select({ agentId: agents.id, adapterConfig: agents.adapterConfig })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated")));
      return rows.map((row) => ({ agentId: row.agentId, adapterConfig: row.adapterConfig ?? null }));
    },
    async listCompanyIds() {
      const rows = await db.select({ id: companies.id }).from(companies).where(isNotNull(companies.id));
      return rows.map((row) => row.id);
    },
    async readGatewayKey(companyId, secretName) {
      return defaultReadGatewayKey(db, companyId, secretName);
    },
    now: () => new Date(),
    log,
    ...opts.deps,
  };

  let sweeping = false;
  let stopped = false;
  const tick = async () => {
    if (sweeping || stopped) return;
    sweeping = true;
    try {
      await sweepModelFallbackSignals(deps, settings);
    } catch (err) {
      log.error({ err }, "model fallback signal sweep tick failed");
    } finally {
      sweeping = false;
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, settings.intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  void tick(); // first pass at startup: the signal exists before anyone opens the desk

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
  return stop;
}

async function defaultReadGatewayKey(db: Db, companyId: string, secretName: string): Promise<string | null> {
  const secrets = secretService(db);
  const row = await secrets.getByName(companyId, secretName);
  if (!row) return null;
  return secrets.resolveSecretValue(companyId, row.id, "latest");
}
