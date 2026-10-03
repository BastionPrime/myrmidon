// server/src/myrmidon/guardrails/events.ts
//
// myrmidon(1.6-GRD): the guardrail event journal — the flag-only record of
// detector firings on run output. One row per event in `guardrail_events`
// plus an `activity_log` line; the snippet column only ever stores text that
// ALREADY went through the existing secret masking (S5 / redaction), so the
// journal itself cannot leak a credential value.
//
// The recordGuardrailEvent contract below is FROZEN for the sibling part B
// (prompt-injection detectors): same name, same shape, part B writes against
// it with a mock. Do not change either.
//
// The output hook (`run-output.ts`) is the only caller for part A; part B
// (input injection) and later parts reuse recordGuardrailEvent directly.

import { desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { guardrailEvents } from "@paperclipai/db";
import { logActivity } from "../../services/activity-log.js";
import { maskSecretsInText } from "../secret-masking.js";
import { detectGuardrailHits, guardrailSnippet, summarizeGuardrailHits } from "./detect.js";

/** Where the detector ran. Part A reports run-output surfaces. */
export const GUARDRAIL_SURFACE_RUN_OUTPUT = "run_output";

export const GUARDRAILS_ACTOR_ID = "myrmidon-guardrails";

/** Env vars of the guardrail layer, read here and not in config.ts. */
export const GUARDRAILS_OUTPUT_ENABLED_ENV = "MYRMIDON_GUARDRAILS_OUTPUT_ENABLED";
export const GUARDRAILS_OUTPUT_CATEGORIES_ENV = "MYRMIDON_GUARDRAILS_OUTPUT_CATEGORIES";

export interface GuardrailOutputSettings {
  /** Master switch; off by default and turned on at rollout. */
  enabled: boolean;
  /** Which detector kinds run (csv from env, default every category). */
  categories: readonly ("secret" | "pii")[];
}

const ALL_CATEGORIES = ["secret", "pii"] as const;

/** Reads the module env; `1`/`true` enable (the ticket default is off). */
export function readGuardrailOutputSettings(env: NodeJS.ProcessEnv = process.env): GuardrailOutputSettings {
  const enabled = env[GUARDRAILS_OUTPUT_ENABLED_ENV] === "1" || env[GUARDRAILS_OUTPUT_ENABLED_ENV] === "true";
  const raw = (env[GUARDRAILS_OUTPUT_CATEGORIES_ENV] ?? "").trim();
  if (!raw) return { enabled, categories: ALL_CATEGORIES };
  const wanted = new Set(
    raw
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => (ALL_CATEGORIES as readonly string[]).includes(entry)),
  );
  // Unknown csv entries mean misconfiguration, not "detect nothing": fall
  // back to all categories rather than silently disabling a detector.
  if (wanted.size === 0) return { enabled, categories: ALL_CATEGORIES };
  return { enabled, categories: ALL_CATEGORIES.filter((kind) => wanted.has(kind)) };
}

/**
 * FROZEN public contract (part B depends on this exact shape).
 * `snippet` must already be masked by the caller when it comes from real
 * output; this module masks it once more so a caller mistake cannot store
 * a raw value.
 */
export interface RecordGuardrailEventInput {
  companyId: string;
  issueId: string | null;
  runId: string | null;
  kind: "secret" | "pii";
  surface: string;
  severity: "info" | "warn" | "error";
  snippet: string | null;
  occurredAt: Date;
}

/** FROZEN for part B. Inserts one event row and one activity-log line. */
export async function recordGuardrailEvent(db: Db, input: RecordGuardrailEventInput): Promise<{ id: string }> {
  const maskedSnippet = maskSecretsInText(input.snippet ?? "").trim() || null;
  const [row] = await db
    .insert(guardrailEvents)
    .values({
      companyId: input.companyId,
      kind: input.kind,
      surface: input.surface,
      severity: input.severity,
      runId: input.runId,
      issueId: input.issueId,
      snippet: maskedSnippet,
      occurredAt: input.occurredAt,
    })
    .returning({ id: guardrailEvents.id });
  await logActivity(db, {
    companyId: input.companyId,
    actorType: "system",
    actorId: GUARDRAILS_ACTOR_ID,
    action: "guardrails.event_recorded",
    entityType: "guardrail_event",
    entityId: row.id,
    runId: input.runId,
    issueId: input.issueId,
    details: {
      kind: input.kind,
      surface: input.surface,
      severity: input.severity,
      snippet: maskedSnippet,
    },
  });
  return { id: row.id };
}

/** Newest-first event list for the board route. */
export async function listGuardrailEvents(db: Db, companyId: string, limit: number) {
  return db
    .select()
    .from(guardrailEvents)
    .where(eq(guardrailEvents.companyId, companyId))
    .orderBy(desc(guardrailEvents.occurredAt))
    .limit(limit);
}

/**
 * The run-output scan: detect on the text, mask once, record one event per
 * hit. Flag-only — the text is never modified. Returns the report so the
 * caller can decide what to log. Failures never propagate: the guardrail
 * must not break run finalization.
 */
export async function recordRunOutputGuardrailEvents(
  db: Db,
  input: {
    companyId: string;
    runId: string;
    issueId: string | null;
    text: string | null;
    now(): Date;
    env?: NodeJS.ProcessEnv;
  },
): Promise<{ recorded: number; total: number; totalSecrets: number; totalPii: number } | null> {
  const settings = readGuardrailOutputSettings(input.env);
  if (!settings.enabled) return null;
  if (typeof input.text !== "string" || input.text.trim().length === 0) return null;
  try {
    const report = summarizeGuardrailHits(detectGuardrailHits(input.text, settings.categories));
    if (report.hits.length === 0) return { recorded: 0, total: 0, totalSecrets: 0, totalPii: 0 };
    // The snippet comes from the masked copy of the same text, cut around
    // each hit's span; recordGuardrailEvent masks again defensively.
    const masked = maskSecretsInText(input.text);
    let recorded = 0;
    for (const hit of report.hits) {
      const snippet = guardrailSnippet(masked, hit.span);
      await recordGuardrailEvent(db, {
        companyId: input.companyId,
        issueId: input.issueId,
        runId: input.runId,
        kind: hit.kind,
        surface: GUARDRAIL_SURFACE_RUN_OUTPUT,
        severity: hit.kind === "secret" ? "warn" : "info",
        snippet,
        occurredAt: input.now(),
      });
      recorded += 1;
    }
    return { recorded, total: report.total, totalSecrets: report.totalSecrets, totalPii: report.totalPii };
  } catch {
    // Flag-only and best-effort: a journaling failure is swallowed, the
    // run result itself is never affected in 1.6.1.
    return null;
  }
}
