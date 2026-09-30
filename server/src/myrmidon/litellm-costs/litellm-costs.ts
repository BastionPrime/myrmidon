// server/src/myrmidon/litellm-costs/litellm-costs.ts
//
// myrmidon(M2-A): collect spend logs and model prices from the LLM gateway
// (LiteLLM) into the board's own ledger, attributed per agent, per run and
// per issue.
//
// Design in one breath:
//  - An instance-level switch (MYRMIDON_LITELLM_BASE_URL +
//    MYRMIDON_LITELLM_KEY_SECRET, both unset by default) turns collection
//    on; without both the sweep is a no-op, exactly like the other myrmidon
//    features.
//  - The gateway is read only through its REST API (/spend/logs,
//    /v1/model/info). No gateway schema knowledge ships in this repo.
//  - Attribution: the gateway's ledger stores the sha256 of the caller's key
//    (its "api_key" column), and each bot's gateway key value lives in the
//    company secret store — the same secret the bot profile compiles from.
//    The sweep hashes each bot's key and matches. No key value is logged or
//    stored; only the hash ever appears, and only in the gateway's own DB.
//  - Dedup: rows carry the gateway's request_id, and the table's partial
//    unique index makes a repeated sweep over the same window a no-op. The
//    collection window starts at the last collected row's occurred_at.
//  - Run/issue attachment: an entry lands on the heartbeat run whose
//    [startedAt, finishedAt) window contains the entry's start time; the
//    issue comes from that run's context snapshot (the same field the vendor
//    cost ledger reads, resolveLedgerScopeForRun).
//  - The collected rows go to litellm_cost_events (a myrmidon table), NOT to
//    the vendor cost_events: the vendor ledger stays what adapters report,
//    this table is what the gateway said, and the Costs screen shows both —
//    their sums matching is the acceptance criterion.
//  - Prices come from /v1/model/info into litellm_models (insert-per-refresh,
//    so price history survives; the latest row per model is what reads show).

import { createHash } from "node:crypto";
import { and, desc, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import { heartbeatRuns, litellmCostEvents, litellmModels, type Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";

export const LITELLM_BASE_URL_ENV = "MYRMIDON_LITELLM_BASE_URL";
export const LITELLM_KEY_SECRET_ENV = "MYRMIDON_LITELLM_KEY_SECRET";
export const LITELLM_SWEEP_INTERVAL_ENV = "MYRMIDON_LITELLM_COST_INTERVAL_SEC";
export const LITELLM_BILLER = "litellm";

const DEFAULT_SWEEP_INTERVAL_SEC = 300;
const MIN_SWEEP_INTERVAL_SEC = 30;
const MAX_SWEEP_INTERVAL_SEC = 86400;
/** First-sweep lookback when no collected row exists yet. */
const FIRST_SWEEP_LOOKBACK_MS = 24 * 3_600_000;
/** /spend/logs page size. */
const SPEND_LOGS_PAGE_SIZE = 1000;
/** Page cap so a stuck sweep cannot loop forever. */
const SPEND_LOGS_MAX_PAGES = 50;
/** Runs are matched with a start before the window; give the match slack. */
const RUN_MATCH_LOOKBACK_MS = 6 * 3_600_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface LitellmCostSettings {
  enabled: boolean;
  baseUrl: string | null;
  keySecret: string | null;
  intervalMs: number;
}

export function readLitellmCostSettings(env: NodeJS.ProcessEnv = process.env): LitellmCostSettings {
  const baseUrl = env[LITELLM_BASE_URL_ENV]?.trim() || null;
  const keySecret = env[LITELLM_KEY_SECRET_ENV]?.trim() || null;
  const enabled = Boolean(baseUrl && keySecret);
  let intervalSec = DEFAULT_SWEEP_INTERVAL_SEC;
  const raw = env[LITELLM_SWEEP_INTERVAL_ENV]?.trim();
  if (raw) {
    const value = Number(raw);
    if (Number.isInteger(value) && value >= MIN_SWEEP_INTERVAL_SEC && value <= MAX_SWEEP_INTERVAL_SEC) {
      intervalSec = value;
    }
  }
  return { enabled, baseUrl, keySecret, intervalMs: intervalSec * 1000 };
}

// ---------------------------------------------------------------------------
// Gateway client
// ---------------------------------------------------------------------------

export interface SpendLogEntry {
  requestId: string | null;
  apiKey: string | null;
  spend: number;
  promptTokens: number;
  completionTokens: number;
  startTime: string;
  model: string;
  provider: string | null;
}

export interface GatewayModelRow {
  modelName: string;
  provider: string | null;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  rates: Record<string, number | null>;
}

export interface LitellmGatewayClient {
  listSpendLogs(window: { from: Date; to: Date }): Promise<SpendLogEntry[]>;
  listModels(): Promise<GatewayModelRow[]>;
}

export function createLitellmGatewayClient(baseUrl: string, keyValue: string): LitellmGatewayClient {
  const url = (path: string) => `${baseUrl.replace(/\/$/, "")}${path}`;

  async function getJson<T>(path: string): Promise<T> {
    const response = await fetch(url(path), { headers: { Authorization: `Bearer ${keyValue}` } });
    if (!response.ok) throw new Error(`LLM gateway ${path} answered ${response.status}`);
    return (await response.json()) as T;
  }

  return {
    async listSpendLogs(window: { from: Date; to: Date }) {
      const entries: SpendLogEntry[] = [];
      for (let page = 1; page <= SPEND_LOGS_MAX_PAGES; page += 1) {
        const rows = await getJson<Array<Record<string, unknown>>>(
          `/spend/logs?page=${page}&page_size=${SPEND_LOGS_PAGE_SIZE}` +
            `&start_date=${window.from.toISOString().slice(0, 10)}` +
            `&end_date=${window.to.toISOString().slice(0, 10)}`,
        );
        for (const row of rows) {
          const startTime = typeof row.startTime === "string" ? row.startTime : "";
          if (!startTime) continue;
          const when = new Date(startTime);
          if (when < window.from || when >= window.to) continue;
          entries.push({
            requestId: typeof row.request_id === "string" && row.request_id ? row.request_id : null,
            apiKey: typeof row.api_key === "string" && row.api_key.trim() ? row.api_key.trim() : null,
            spend: asNumber(row.spend),
            promptTokens: asNumber(row.prompt_tokens),
            completionTokens: asNumber(row.completion_tokens),
            startTime,
            model: typeof row.model === "string" ? row.model : "unknown",
            provider: typeof row.custom_llm_provider === "string" ? row.custom_llm_provider : null,
          });
        }
        if (rows.length < SPEND_LOGS_PAGE_SIZE) break;
      }
      return entries;
    },

    async listModels() {
      const payload = await getJson<{ data?: Array<Record<string, unknown>> }>("/v1/model/info");
      const rows: GatewayModelRow[] = [];
      for (const item of payload.data ?? []) {
        const modelName = typeof item.model_name === "string" ? item.model_name : null;
        if (!modelName) continue;
        const info = asRecord(item.model_info);
        rows.push({
          modelName,
          provider: typeof info?.custom_llm_provider === "string" ? info.custom_llm_provider : null,
          maxInputTokens: asNullableNumber(info?.max_input_tokens),
          maxOutputTokens: asNullableNumber(info?.max_tokens),
          rates: readRates(info),
        });
      }
      return rows;
    },
  };
}

const RATE_KEYS = [
  "input_cost_per_token",
  "output_cost_per_token",
  "cache_read_input_token_cost",
  "cache_creation_input_token_cost",
] as const;

function readRates(info: Record<string, unknown> | null): Record<string, number | null> {
  const rates: Record<string, number | null> = {};
  for (const key of RATE_KEYS) rates[key] = asNullableNumber(info?.[key]);
  return rates;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// ---------------------------------------------------------------------------
// Pure attribution helpers (exported for tests)
// ---------------------------------------------------------------------------

/** sha256 hex of the key value — what the gateway's ledger stores. */
export function gatewayKeyHash(keyValue: string): string {
  return createHash("sha256").update(keyValue).digest("hex");
}

export interface BotKeyEntry {
  agentId: string;
  keyValue: string;
}

/** Map of hashed key -> agent for the company's bots. */
export function botKeyIndex(bots: BotKeyEntry[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const bot of bots) map.set(gatewayKeyHash(bot.keyValue), bot.agentId);
  return map;
}

export interface RunWindow {
  runId: string;
  agentId: string;
  issueId: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

/**
 * The run whose [startedAt, finishedAt) window contains "when" — latest start
 * wins when several overlap (retries). A still-running run (finishedAt null)
 * counts as open-ended, matching how the vendor ledger's live runtime ticks.
 */
export function runWindowFor(when: Date, agentId: string, windows: RunWindow[]): RunWindow | null {
  let best: RunWindow | null = null;
  for (const window of windows) {
    if (window.agentId !== agentId) continue;
    if (when < window.startedAt) continue;
    if (window.finishedAt && when >= window.finishedAt) continue;
    if (!best || window.startedAt > best.startedAt) best = window;
  }
  return best;
}

/** Cents from the gateway's USD spend; a positive sub-cent row keeps 1 cent. */
export function spendUsdToCents(spendUsd: number): number {
  if (!Number.isFinite(spendUsd) || spendUsd <= 0) return 0;
  return Math.max(1, Math.round(spendUsd * 100));
}

export interface CollectedRow {
  agentId: string;
  issueId: string | null;
  heartbeatRunId: string | null;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  occurredAt: Date;
  requestId: string | null;
}

/** Pure core of the sweep: entries -> ledger rows. Exported for tests. */
export function collectRows(
  entries: SpendLogEntry[],
  keys: Map<string, string>,
  windows: RunWindow[],
): { rows: CollectedRow[]; skippedUnattributed: number } {
  const rows: CollectedRow[] = [];
  let skippedUnattributed = 0;
  for (const entry of entries) {
    const agentId = entry.apiKey ? keys.get(entry.apiKey) ?? null : null;
    if (!agentId) {
      skippedUnattributed += 1;
      continue;
    }
    const costCents = spendUsdToCents(entry.spend);
    if (costCents === 0 && entry.promptTokens === 0 && entry.completionTokens === 0) continue;
    const when = new Date(entry.startTime);
    const run = runWindowFor(when, agentId, windows);
    rows.push({
      agentId,
      issueId: run?.issueId ?? null,
      heartbeatRunId: run?.runId ?? null,
      provider: entry.provider ?? "unknown",
      model: entry.model,
      inputTokens: Math.max(0, Math.floor(entry.promptTokens)),
      outputTokens: Math.max(0, Math.floor(entry.completionTokens)),
      costCents,
      occurredAt: when,
      requestId: entry.requestId,
    });
  }
  return { rows, skippedUnattributed };
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

export interface LitellmCostsDeps {
  db: Db;
  /** Gateway key value from the company secret store. */
  readGatewayKey(companyId: string, secretName: string): Promise<string | null>;
  /** Bot gateway keys: agentId -> key value (from the secret store). */
  listBotKeys(companyId: string): Promise<BotKeyEntry[]>;
  /** Client factory; overridden in tests. */
  client: (baseUrl: string, keyValue: string) => LitellmGatewayClient;
  now(): Date;
  log?: { info(fields: object, message: string): void; warn(fields: object, message: string): void };
}

export interface SweepResult {
  collected: number;
  written: number;
  skippedUnattributed: number;
  modelsRefreshed: number | null;
  window: { from: Date; to: Date };
}

/** One sweep for one company; see the module comment for the design. */
export async function sweepLitellmCosts(
  deps: LitellmCostsDeps,
  companyId: string,
  settings: LitellmCostSettings,
): Promise<SweepResult> {
  if (!settings.enabled || !settings.baseUrl || !settings.keySecret) {
    throw new Error("litellm cost collection is not configured");
  }
  const log = deps.log ?? logger;
  const to = deps.now();
  const from = await readCollectedSince(deps.db, companyId, to);
  const window = { from, to };

  const keyValue = await deps.readGatewayKey(companyId, settings.keySecret);
  if (!keyValue) {
    log.warn({ companyId }, "litellm cost sweep skipped: gateway key secret not found");
    return { collected: 0, written: 0, skippedUnattributed: 0, modelsRefreshed: null, window };
  }

  const entries = await deps.client(settings.baseUrl, keyValue).listSpendLogs(window);
  const keys = botKeyIndex(await deps.listBotKeys(companyId));
  const windows = await loadRunWindows(deps.db, companyId, window);
  const { rows, skippedUnattributed } = collectRows(entries, keys, windows);
  const written = await insertRows(deps.db, companyId, rows, to);

  let modelsRefreshed: number | null = null;
  try {
    const models = await deps.client(settings.baseUrl, keyValue).listModels();
    await refreshModels(deps.db, models, to);
    modelsRefreshed = models.length;
  } catch (err) {
    log.warn({ err }, "litellm cost sweep: model catalog refresh failed");
  }

  log.info(
    { companyId, collected: entries.length, written, skippedUnattributed, modelsRefreshed },
    "litellm cost sweep done",
  );
  return { collected: entries.length, written, skippedUnattributed, modelsRefreshed, window };
}

/** Window start: the newest collected row's occurred_at (bounded by lookback). */
async function readCollectedSince(db: Db, companyId: string, now: Date): Promise<Date> {
  const fallback = new Date(now.getTime() - FIRST_SWEEP_LOOKBACK_MS);
  const rows = await db
    .select({ last: litellmCostEvents.occurredAt })
    .from(litellmCostEvents)
    .where(eq(litellmCostEvents.companyId, companyId))
    .orderBy(desc(litellmCostEvents.occurredAt))
    .limit(1);
  const last = rows[0]?.last ?? null;
  if (!last || last <= fallback) return fallback;
  return last;
}

async function loadRunWindows(
  db: Db,
  companyId: string,
  window: { from: Date; to: Date },
): Promise<RunWindow[]> {
  const rows = await db
    .select({
      runId: heartbeatRuns.id,
      agentId: heartbeatRuns.agentId,
      issueId: sql<string | null>`(context_snapshot ->> 'issueId')`,
      startedAt: heartbeatRuns.startedAt,
      finishedAt: heartbeatRuns.finishedAt,
    })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        gte(heartbeatRuns.startedAt, new Date(window.from.getTime() - RUN_MATCH_LOOKBACK_MS)),
        lt(heartbeatRuns.startedAt, window.to),
        isNotNull(heartbeatRuns.finishedAt),
      ),
    );
  const windows: RunWindow[] = [];
  for (const row of rows) {
    if (!row.startedAt) continue; // a run without a start cannot bound a window
    windows.push({
      runId: row.runId,
      agentId: row.agentId,
      issueId: row.issueId && UUID_PATTERN.test(row.issueId) ? row.issueId : null,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt ?? null,
    });
  }
  return windows;
}

async function insertRows(db: Db, companyId: string, rows: CollectedRow[], collectedAt: Date): Promise<number> {
  let written = 0;
  for (const row of rows) {
    const inserted = await db
      .insert(litellmCostEvents)
      .values({
        id: `${companyId}:${row.requestId ?? `${row.agentId}:${row.occurredAt.toISOString()}`}`,
        companyId,
        agentId: row.agentId,
        issueId: row.issueId,
        heartbeatRunId: row.heartbeatRunId,
        provider: row.provider,
        model: row.model,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        costCents: row.costCents,
        occurredAt: row.occurredAt,
        requestId: row.requestId,
        collectedAt,
      })
      .onConflictDoNothing()
      .returning({ id: litellmCostEvents.id });
    written += inserted.length;
  }
  return written;
}

async function refreshModels(db: Db, models: GatewayModelRow[], seenAt: Date): Promise<void> {
  for (const model of models) {
    await db
      .insert(litellmModels)
      .values({
        id: `${model.modelName}:${seenAt.toISOString()}`,
        modelName: model.modelName,
        provider: model.provider,
        maxInputTokens: model.maxInputTokens,
        maxOutputTokens: model.maxOutputTokens,
        rates: model.rates,
        seenAt,
      })
      .onConflictDoNothing();
  }
}

// ---------------------------------------------------------------------------
// Read API (routes + UI)
// ---------------------------------------------------------------------------

export interface LitellmCostRow {
  agentId: string;
  issueId: string | null;
  heartbeatRunId: string | null;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  occurredAt: string;
}

export async function listLitellmCostEvents(
  db: Db,
  companyId: string,
  range: { from?: Date; to?: Date } | undefined,
  limit = 500,
): Promise<LitellmCostRow[]> {
  const conditions = [eq(litellmCostEvents.companyId, companyId)];
  if (range?.from) conditions.push(gte(litellmCostEvents.occurredAt, range.from));
  if (range?.to) conditions.push(lt(litellmCostEvents.occurredAt, range.to));
  const rows = await db
    .select()
    .from(litellmCostEvents)
    .where(and(...conditions))
    .orderBy(desc(litellmCostEvents.occurredAt))
    .limit(Math.min(Math.max(limit, 1), 1000));
  return rows.map((row) => ({
    agentId: row.agentId,
    issueId: row.issueId,
    heartbeatRunId: row.heartbeatRunId,
    provider: row.provider,
    model: row.model,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    costCents: row.costCents,
    occurredAt: row.occurredAt instanceof Date ? row.occurredAt.toISOString() : String(row.occurredAt),
  }));
}

export interface LitellmModelView {
  modelName: string;
  provider: string | null;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  inputCostPerToken: number | null;
  outputCostPerToken: number | null;
  cacheReadInputTokenCost: number | null;
  cacheCreationInputTokenCost: number | null;
  seenAt: string;
}

/** Latest-seen row per model name. */
export async function listLitellmModels(db: Db): Promise<LitellmModelView[]> {
  const latest = db
    .select({
      modelName: litellmModels.modelName,
      seenAt: sql<Date>`max(${litellmModels.seenAt})`.as("seenAt"),
    })
    .from(litellmModels)
    .groupBy(litellmModels.modelName)
    .as("latest");
  const rows = await db
    .select({ model: litellmModels })
    .from(litellmModels)
    .innerJoin(latest, sql`${litellmModels.modelName} = ${latest.modelName} and ${litellmModels.seenAt} = ${latest.seenAt}`)
    .orderBy(litellmModels.modelName);
  return rows.map((row) => toModelView(row.model));
}

function toModelView(row: typeof litellmModels.$inferSelect): LitellmModelView {
  const rates = row.rates ?? {};
  return {
    modelName: row.modelName,
    provider: row.provider,
    maxInputTokens: row.maxInputTokens,
    maxOutputTokens: row.maxOutputTokens,
    inputCostPerToken: rates.input_cost_per_token ?? null,
    outputCostPerToken: rates.output_cost_per_token ?? null,
    cacheReadInputTokenCost: rates.cache_read_input_token_cost ?? null,
    cacheCreationInputTokenCost: rates.cache_creation_input_token_cost ?? null,
    seenAt: row.seenAt instanceof Date ? row.seenAt.toISOString() : String(row.seenAt),
  };
}
