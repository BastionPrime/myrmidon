// myrmidon(EXTCASE-PANEL): the journal view of the browser bridge.
//
// Part B journals every bridge event into the company activity log. This
// module is the read side: it selects the bridge rows for one company and
// maps them into the flat rows the panel renders. Nothing is summarized or
// redacted here — part B already decided what a row may carry (sizes and
// references, never page content), so the read side only filters and shapes.
//
// Filters mirror the panel's controls: device, method, outcome, and a
// signatures-only switch that keeps the rows a signature leaves behind
// (action type, status, document hash). `from`/`to` bound `createdAt`.

import { and, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog } from "@paperclipai/db";
import { BROWSER_BRIDGE_ENTITY_TYPE, BROWSER_BRIDGE_ACTIONS } from "./journal.js";

/** Actions that describe an action attempt (the journal's action rows). */
const BRIDGE_ACTION_ROW_ACTIONS = new Set<string>([
  BROWSER_BRIDGE_ACTIONS.actionExecuted,
  BROWSER_BRIDGE_ACTIONS.actionDenied,
  BROWSER_BRIDGE_ACTIONS.actionTimedOut,
]);

export interface BridgeJournalQuery {
  companyId: string;
  deviceId?: string;
  method?: string;
  outcome?: string;
  signaturesOnly?: boolean;
  from?: Date;
  to?: Date;
  limit?: number;
}

export interface BridgeJournalRow {
  id: string;
  createdAt: string;
  action: string;
  deviceId: string;
  label: string | null;
  method: string | null;
  url: string | null;
  target: string | null;
  outcome: string | null;
  confirmation: string | null;
  durationMs: number | null;
  reasonCode: number | null;
  signActionType: string | null;
  signStatus: string | null;
  documentHash: string | null;
  actorType: string | null;
  actorId: string | null;
  runId: string | null;
}

const DEFAULT_JOURNAL_LIMIT = 50;
const MAX_JOURNAL_LIMIT = 200;

export function normalizeJournalLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return DEFAULT_JOURNAL_LIMIT;
  return Math.max(1, Math.min(MAX_JOURNAL_LIMIT, Math.floor(limit ?? DEFAULT_JOURNAL_LIMIT)));
}

function readString(details: Record<string, unknown> | null, key: string): string | null {
  const value = details?.[key];
  return typeof value === "string" ? value : null;
}

function readNumber(details: Record<string, unknown> | null, key: string): number | null {
  const value = details?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Whether an activity row is a bridge row at all: the entity type part B
 * stamps on every entry, checked as text because `entityId` is a text column.
 */
export function isBridgeJournalRow(row: { entityType: string; action: string }): boolean {
  return row.entityType === BROWSER_BRIDGE_ENTITY_TYPE;
}

/**
 * The signature rows of the journal: bridge action rows about `browser.sign`.
 * The document hash a signature leaves behind is the whole point of the view.
 */
export function isSignatureRow(row: { entityType: string; action: string; details: unknown }): boolean {
  if (!isBridgeJournalRow(row)) return false;
  if (!BRIDGE_ACTION_ROW_ACTIONS.has(row.action)) return false;
  const details = row.details as Record<string, unknown> | null;
  return readString(details, "method") === "browser.sign";
}

export function bridgeJournalService(db: Db) {
  async function list(query: BridgeJournalQuery): Promise<BridgeJournalRow[]> {
    const conditions: SQL[] = [
      eq(activityLog.companyId, query.companyId),
      eq(activityLog.entityType, BROWSER_BRIDGE_ENTITY_TYPE),
    ];

    // Only actions part B records carry a deviceId worth filtering on. The
    // device-independent rows (allowlist, signing policy) stay visible with
    // no filter, and disappear only when the operator picks a device.
    if (query.deviceId) {
      conditions.push(eq(activityLog.entityId, query.deviceId));
    }
    if (query.method) {
      conditions.push(sqlEqDetailText("method", query.method));
    }
    if (query.outcome) {
      conditions.push(sqlEqDetailText("outcome", query.outcome));
    }
    if (query.signaturesOnly) {
      conditions.push(sqlEqDetailText("method", "browser.sign"));
    }
    if (query.from) {
      conditions.push(gte(activityLog.createdAt, query.from));
    }
    if (query.to) {
      conditions.push(lte(activityLog.createdAt, query.to));
    }

    const rows = await db
      .select({ row: activityLog })
      .from(activityLog)
      .where(and(...conditions))
      .orderBy(desc(activityLog.createdAt))
      .limit(normalizeJournalLimit(query.limit))
      .then((found) => found.map((r) => r.row));
    return rows.map(toRow);
  }

  /** Journaled signatures today (UTC) for one company — the daily-limit counter. */
  async function countSignaturesToday(companyId: string, now: Date): Promise<number> {
    const startOfDay = new Date(now);
    startOfDay.setUTCHours(0, 0, 0, 0);
    const rows = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.entityType, BROWSER_BRIDGE_ENTITY_TYPE),
          eq(activityLog.action, BROWSER_BRIDGE_ACTIONS.actionExecuted),
          sqlEqDetailText("method", "browser.sign"),
          gte(activityLog.createdAt, startOfDay),
        ),
      )
      .limit(1000);
    return rows.length;
  }

  return { list, countSignaturesToday };
}

function sqlEqDetailText(key: string, value: string): SQL {
  // activity_log.details is jsonb; the ->> operator is indexed nowhere, but the
  // bridge rows of one company are few (an operator panel, not a firehose).
  return sqlEqTextOnJsonb(activityLog.details, key, value);
}

function sqlEqTextOnJsonb(
  column: typeof activityLog.details,
  key: string,
  value: string,
): SQL {
  return sql`${column}->>${key} = ${value}`;
}

function toRow(row: typeof activityLog.$inferSelect): BridgeJournalRow {
  const details = (row.details ?? null) as Record<string, unknown> | null;
  const labelSource = typeof row.details === "object" && row.details !== null
    ? (row.details as Record<string, unknown>).label
    : undefined;
  return {
    id: row.id,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    action: row.action,
    deviceId: BRIDGE_ACTION_ROW_ACTIONS.has(row.action) || row.action === BROWSER_BRIDGE_ACTIONS.deviceRevoked
      ? row.entityId
      : null,
    label: typeof labelSource === "string" ? labelSource : null,
    method: readString(details, "method"),
    url: readString(details, "url"),
    target: readString(details, "target"),
    outcome: readString(details, "outcome"),
    confirmation: readString(details, "confirmation"),
    durationMs: readNumber(details, "durationMs"),
    reasonCode: readNumber(details, "reasonCode"),
    signActionType: readString(details, "signActionType"),
    signStatus: readString(details, "signStatus"),
    documentHash: readString(details, "documentHash"),
    actorType: row.actorType,
    actorId: row.actorId,
    runId: row.runId,
  };
}

export type BridgeJournalService = ReturnType<typeof bridgeJournalService>;
