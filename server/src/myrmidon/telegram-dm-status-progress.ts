import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRunEvents } from "@paperclipai/db";
import { redactSensitiveText } from "../redaction.js";

// myrmidon(OPE-3650): live progress text for the editable Telegram DM status
// row (MYRMIDON_TELEGRAM_DM_STATUS). The owner asked to see WHAT the bot is
// doing right now — the current step in plain words, elapsed time, and the
// last few completed steps — updated in place in the single durable status
// message, never as new provider messages.
//
// Source of truth: the run-log rows the board already records
// (`heartbeat_run_events`; a run-log path, no extra review per AGENTS.md §7).
// Only event identity/type/sequence/time and the already-redacted `message`
// column are read here; raw payloads, tool arguments, and results never
// cross into provider text. Events are redacted with redactSensitiveText at
// the append boundary (appendRunEvent); the label reader re-applies it as a
// second guard and truncates hard.

const DM_STATUS_STEP_EVENT_TYPES = [
  "tool.execution.started",
  "tool.execution.completed",
  "research.started",
  "research.completed",
  "delegation.started",
  "delegation.completed",
  "plan.updated",
  "item.completed",
] as const;

const DM_STATUS_STEP_EVENT_TYPE_SET = new Set<string>(DM_STATUS_STEP_EVENT_TYPES);

export function isDmStatusStepEventType(eventType: string): boolean {
  return DM_STATUS_STEP_EVENT_TYPE_SET.has(eventType);
}

const MAX_CURRENT_STEP_CHARS = 120;
const MAX_COMPLETED_STEPS = 3;
const MAX_COMPLETED_STEP_CHARS = 80;

function normalizeStepText(value: string, maxChars: number): string | null {
  const normalized = value.replace(/\s+/g, " ").trim().slice(0, maxChars);
  if (!normalized) return null;
  // Second guard: the append boundary already redacted these fields, but the
  // status text crosses to an external provider, so re-apply the closed
  // redaction before it leaves.
  return redactSensitiveText(normalized) || null;
}

function stepLabelForEventType(eventType: string, message: string | null): string | null {
  switch (eventType) {
    case "tool.execution.started":
      return message ? `инструмент: ${message}` : "запускаю инструмент…";
    case "tool.execution.completed":
      return message ? `готово: ${message}` : null;
    case "research.started":
      return "ищу информацию…";
    case "research.completed":
      return "поиск завершён";
    case "delegation.started":
      return message ? `помощник: ${message}` : "запускаю помощника…";
    case "delegation.completed":
      return "помощник завершил работу";
    case "plan.updated":
      return message ? `план: ${message}` : "обновляю план…";
    case "item.completed":
      return message ? `шаг готов: ${message}` : null;
    default:
      return message;
  }
}

type DmStatusStep = {
  eventType: string;
  message: string | null;
  createdAt: Date;
};

export function formatDmStatusElapsed(startedAt: Date | null, now: Date): string {
  if (!startedAt) return "";
  const seconds = Math.max(0, Math.floor((now.getTime() - startedAt.getTime()) / 1000));
  // Coarse buckets: the elapsed string participates in the payload-changed
  // comparison that gates provider edits, so a per-second clock would edit
  // the Telegram message on every 1s sweep. 30s buckets keep edits well
  // inside Telegram's per-message edit rate limit while the elapsed line
  // still advances a few times per minute.
  const bucketed = Math.floor(seconds / 30) * 30;
  if (bucketed < 60) return "<1 мин";
  const minutes = Math.floor(bucketed / 60);
  if (minutes < 60) return `${minutes} мин`;
  return `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`;
}

/**
 * Compose the live-progress status text for the bridged Telegram DM status
 * row: the agent's current step in plain words, the elapsed time, and the
 * last few completed steps as a short list. Falls back to the vendor's safe
 * milestone wording when the run has no step events yet.
 */
export function composeDmStatusText(input: {
  agentName: string;
  milestone: "queued" | "working";
  startedAt: Date | null;
  steps: DmStatusStep[];
  now: Date;
}): string {
  if (input.milestone === "queued") return `${input.agentName} is queued.`;

  const labels = input.steps
    .map((step) => {
      const message = step.message ? normalizeStepText(step.message, MAX_CURRENT_STEP_CHARS) : null;
      return stepLabelForEventType(step.eventType, message);
    })
    .filter((label): label is string => label !== null);

  if (labels.length === 0) {
    const elapsed = formatDmStatusElapsed(input.startedAt, input.now);
    return elapsed
      ? `${input.agentName} is working… (${elapsed})`
      : `${input.agentName} is working…`;
  }

  const current = labels[labels.length - 1]!;
  const completed = labels
    .slice(Math.max(0, labels.length - 1 - MAX_COMPLETED_STEPS), labels.length - 1)
    .map((label) => normalizeStepText(label, MAX_COMPLETED_STEP_CHARS))
    .filter((label): label is string => label !== null);
  const elapsed = formatDmStatusElapsed(input.startedAt, input.now);

  const lines = [`${input.agentName}: ${current}${elapsed ? ` · ${elapsed}` : ""}`];
  if (completed.length > 0) {
    lines.push("", "Сделано:");
    for (const label of completed) lines.push(`• ${label}`);
  }
  return lines.join("\n");
}

/**
 * Read the most recent step-family run-log events for one run, bounded, for
 * the DM status text. Only the already-redacted `message` column and event
 * identity are projected; payloads are never read here.
 */
export async function readDmStatusSteps(
  db: Db,
  input: { companyId: string; runId: string; limit?: number },
): Promise<DmStatusStep[]> {
  const limit = Math.max(1, Math.min(input.limit ?? 8, 16));
  const rows = await db
    .select({
      eventType: heartbeatRunEvents.eventType,
      message: heartbeatRunEvents.message,
      createdAt: heartbeatRunEvents.createdAt,
    })
    .from(heartbeatRunEvents)
    .where(
      and(
        eq(heartbeatRunEvents.companyId, input.companyId),
        eq(heartbeatRunEvents.runId, input.runId),
        inArray(heartbeatRunEvents.eventType, [...DM_STATUS_STEP_EVENT_TYPES]),
      ),
    )
    .orderBy(desc(heartbeatRunEvents.id))
    .limit(limit);
  // Query returns newest-first; the composer reads oldest-first semantics.
  return rows.reverse().map((row) => ({
    eventType: row.eventType,
    message: row.message,
    createdAt: row.createdAt,
  }));
}
