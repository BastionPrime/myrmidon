import { and, eq, gte, sql } from "drizzle-orm";
import { activityLog, agents, companies, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

/**
 * AUTO-RESUME (Myrmidon 1.4).
 *
 * A run that fails (gateway HTTP 500, run timeout, adapter crash) leaves the
 * agent in `error` (`finalizeAgentStatus` in `services/heartbeat.ts`), and the
 * vendor never brings it back on its own: those agents sat in `error` until an
 * operator called resume by hand. This module makes the board resume them with
 * a backoff of 1, 5 and 15 minutes and, when the resumes keep failing, stops
 * and raises a `needs attention` card for the operator instead of retrying
 * forever.
 *
 * It reuses the L3 pause/resume wake chain (`heartbeat.resumeAgentAfterPause`
 * -> `myrmidon/pause-drain.ts`), not a raw `clearError` that would flip the
 * agent back to idle without waking the work it was stranded on.
 *
 * State lives in the existing `agents.metadata` JSON column under the key
 * `myrmidon_auto_resume` (no migration, no new table): the failed-resume
 * counter of the current streak, when the streak last failed, when the next
 * resume is due, and when the module gave up. An agent record change after the
 * give-up point (`agents.updated_at` becomes newer than `exhaustedAt`) is how
 * an operator action re-arms the streak.
 */

export const AUTO_RESUME_ENABLED_ENV = "MYRMIDON_AUTO_RESUME_ENABLED";
export const AUTO_RESUME_BACKOFF_MS_ENV = "MYRMIDON_AUTO_RESUME_BACKOFF_MS";
export const AUTO_RESUME_MAX_ATTEMPTS_ENV = "MYRMIDON_AUTO_RESUME_MAX_ATTEMPTS";
export const AUTO_RESUME_INTERVAL_SEC_ENV = "MYRMIDON_AUTO_RESUME_INTERVAL_SEC";
export const AUTO_RESUME_WINDOW_MS_ENV = "MYRMIDON_AUTO_RESUME_WINDOW_MS";

/** Backoff between resume attempts: 1, 5 and 15 minutes. */
export const DEFAULT_AUTO_RESUME_BACKOFF_MS: readonly number[] = [60_000, 300_000, 900_000];
/** Failed resumes in one streak before the module stops and raises the card. */
export const DEFAULT_AUTO_RESUME_MAX_ATTEMPTS = 3;
/** The sweep runs on every scheduler tick (~30 s); this gate keeps it per-minute. */
export const DEFAULT_AUTO_RESUME_INTERVAL_SEC = 60;
export const MIN_AUTO_RESUME_INTERVAL_SEC = 10;
/** A streak whose last failure is older than this is treated as a new episode. */
export const DEFAULT_AUTO_RESUME_WINDOW_MS = 60 * 60 * 1000;

/** Key of the state object inside `agents.metadata`. */
export const AUTO_RESUME_METADATA_KEY = "myrmidon_auto_resume";
/** Activity-log action for one automatic resume (part E reads this for the 24 h metric). */
export const AUTO_RESUME_ACTIVITY_ACTION = "agent.auto_resume_issued";
/** Activity-log action for giving up on an agent after the attempt cap. */
export const AUTO_RESUME_EXHAUSTED_ACTIVITY_ACTION = "agent.auto_resume_exhausted";

const AUTO_RESUME_ACTOR_ID = "auto_resume";

const DISABLED_VALUES = new Set(["0", "false", "off", "no"]);

export interface AutoResumeSettings {
  enabled: boolean;
  /** Backoff step in milliseconds per attempt index; the last step repeats. */
  backoffMs: number[];
  maxAttempts: number;
  intervalSec: number;
  failureWindowMs: number;
}

function parsePositiveInt(raw: string | undefined, fallback: number, min = 1): number {
  const value = raw?.trim();
  if (!value || !/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min) return fallback;
  return parsed;
}

function parseBackoff(raw: string | undefined): number[] {
  const value = raw?.trim();
  if (!value) return [...DEFAULT_AUTO_RESUME_BACKOFF_MS];
  const parsed = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => (/^\d+$/.test(part) ? Number(part) : NaN))
    .filter((part) => Number.isSafeInteger(part) && part > 0);
  return parsed.length > 0 ? parsed : [...DEFAULT_AUTO_RESUME_BACKOFF_MS];
}

/**
 * The feature ships enabled (a defect fix per CONVENTIONS.md §8): an unset or
 * unrecognized value keeps it on. Only an explicit off value disables it.
 */
export function readAutoResumeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[AUTO_RESUME_ENABLED_ENV]?.trim().toLowerCase();
  return !raw || !DISABLED_VALUES.has(raw);
}

export function readAutoResumeSettings(env: NodeJS.ProcessEnv = process.env): AutoResumeSettings {
  return {
    enabled: readAutoResumeEnabled(env),
    backoffMs: parseBackoff(env[AUTO_RESUME_BACKOFF_MS_ENV]),
    maxAttempts: parsePositiveInt(env[AUTO_RESUME_MAX_ATTEMPTS_ENV], DEFAULT_AUTO_RESUME_MAX_ATTEMPTS),
    intervalSec: Math.max(
      MIN_AUTO_RESUME_INTERVAL_SEC,
      parsePositiveInt(env[AUTO_RESUME_INTERVAL_SEC_ENV], DEFAULT_AUTO_RESUME_INTERVAL_SEC),
    ),
    failureWindowMs: parsePositiveInt(env[AUTO_RESUME_WINDOW_MS_ENV], DEFAULT_AUTO_RESUME_WINDOW_MS),
  };
}

/** Backoff step for the Nth attempt (index clamped to the last configured step). */
export function backoffForAttempt(backoffMs: readonly number[], attemptIndex: number): number {
  if (backoffMs.length === 0) return DEFAULT_AUTO_RESUME_BACKOFF_MS[0];
  const index = Math.min(Math.max(0, Math.floor(attemptIndex)), backoffMs.length - 1);
  return backoffMs[index]!;
}

export interface AutoResumeState {
  /** Failed-resume count in the current streak. */
  failures: number;
  /** ISO timestamp of the last observed failure (or the error entry that started the streak). */
  lastFailureAt: string;
  /** ISO timestamp when the next resume becomes due. */
  nextAttemptAt: string | null;
  /** ISO timestamp when the module gave up; reset by an operator action. */
  exhaustedAt: string | null;
  /** ISO timestamp of the last automatic resume. */
  lastResumeAt: string | null;
}

function readIsoString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return Number.isFinite(Date.parse(trimmed)) ? trimmed : null;
}

export function readAutoResumeState(metadata: unknown): AutoResumeState | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const raw = (metadata as Record<string, unknown>)[AUTO_RESUME_METADATA_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const lastFailureAt = readIsoString(value.lastFailureAt);
  if (!lastFailureAt) return null;
  const failures = typeof value.failures === "number" && Number.isFinite(value.failures) && value.failures >= 0
    ? Math.floor(value.failures)
    : 0;
  return {
    failures,
    lastFailureAt,
    nextAttemptAt: readIsoString(value.nextAttemptAt),
    exhaustedAt: readIsoString(value.exhaustedAt),
    lastResumeAt: readIsoString(value.lastResumeAt),
  };
}

/** Merge the auto-resume state into an agent's metadata, preserving every other key. */
export function mergeAutoResumeState(metadata: unknown, state: AutoResumeState | null): Record<string, unknown> {
  const base = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? { ...(metadata as Record<string, unknown>) }
    : {};
  if (state === null) {
    delete base[AUTO_RESUME_METADATA_KEY];
    return base;
  }
  base[AUTO_RESUME_METADATA_KEY] = state;
  return base;
}

export interface AutoResumeAttentionState {
  exhausted: boolean;
  failures: number;
  exhaustedAt: string | null;
}

/**
 * The slice of the auto-resume state the attention feed reads to escalate the
 * `agent_error_alert` card after the module gave up. Returns null when the
 * agent has no auto-resume state.
 */
export function readAutoResumeAttentionState(metadata: unknown): AutoResumeAttentionState | null {
  const state = readAutoResumeState(metadata);
  if (!state) return null;
  return { exhausted: Boolean(state.exhaustedAt), failures: state.failures, exhaustedAt: state.exhaustedAt };
}

export type AutoResumeDecisionAction = "skip" | "resume" | "exhaust";

export interface AutoResumeDecision {
  action: AutoResumeDecisionAction;
  reason: string;
  /** State to persist. Equals the incoming state when nothing changes. */
  nextState: AutoResumeState | null;
}

export interface AutoResumePolicyAgent {
  status: string;
  /** `agents.updated_at`: the agent error entry (or the last operator/system touch). */
  updatedAt: Date;
}

/**
 * Pure policy: what to do with one agent on this tick. No I/O, so the backoff
 * steps, the attempt cap and the maintenance/pause gates are unit-testable.
 */
export function decideAutoResume(params: {
  agent: AutoResumePolicyAgent;
  state: AutoResumeState | null;
  settings: AutoResumeSettings;
  now: Date;
  invokable: boolean;
  underMaintenance: boolean;
}): AutoResumeDecision {
  const { agent, settings, now, invokable, underMaintenance } = params;
  let state = params.state;

  if (!settings.enabled) return { action: "skip", reason: "disabled", nextState: state };
  if (agent.status !== "error") return { action: "skip", reason: "not_error", nextState: state };
  // A paused, terminated or otherwise non-invokable agent must not be resumed;
  // the wake chain would refuse it anyway, so keep the sweep off that path.
  if (!invokable) return { action: "skip", reason: "not_invokable", nextState: state };
  if (underMaintenance) return { action: "skip", reason: "maintenance", nextState: state };

  // Re-arm after an operator acted: the record changed after we gave up, so
  // this is a new episode and the attempt counter starts over.
  if (state?.exhaustedAt) {
    const exhaustedAtMs = Date.parse(state.exhaustedAt);
    if (Number.isFinite(exhaustedAtMs) && agent.updatedAt.getTime() > exhaustedAtMs + 1_000) {
      state = null;
    }
  }

  // A streak older than the window is not one streak: start fresh.
  if (state && !state.exhaustedAt) {
    const lastFailureAtMs = Date.parse(state.lastFailureAt);
    if (!Number.isFinite(lastFailureAtMs) || now.getTime() - lastFailureAtMs > settings.failureWindowMs) {
      state = null;
    }
  }

  if (state?.exhaustedAt) return { action: "skip", reason: "exhausted", nextState: state };

  const failures = state?.failures ?? 0;
  if (failures >= settings.maxAttempts) {
    return {
      action: "exhaust",
      reason: "max_attempts",
      nextState: {
        failures,
        lastFailureAt: state?.lastFailureAt ?? agent.updatedAt.toISOString(),
        nextAttemptAt: state?.nextAttemptAt ?? null,
        exhaustedAt: now.toISOString(),
        lastResumeAt: state?.lastResumeAt ?? null,
      },
    };
  }

  const lastFailureAtMs = state ? Date.parse(state.lastFailureAt) : agent.updatedAt.getTime();
  const dueAtMs = lastFailureAtMs + backoffForAttempt(settings.backoffMs, failures);
  if (Number.isFinite(dueAtMs) && now.getTime() < dueAtMs) {
    return { action: "skip", reason: "not_due", nextState: state };
  }

  const nextFailures = failures + 1;
  return {
    action: "resume",
    reason: "due",
    nextState: {
      failures: nextFailures,
      lastFailureAt: now.toISOString(),
      nextAttemptAt: new Date(now.getTime() + backoffForAttempt(settings.backoffMs, nextFailures)).toISOString(),
      exhaustedAt: null,
      lastResumeAt: now.toISOString(),
    },
  };
}

export interface AutoResumeActivityInput {
  companyId: string;
  actorType: "system";
  actorId: string;
  agentId: string | null;
  runId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown>;
}

export interface AutoResumeSweeperDeps {
  db: Db;
  /** Existing wake chain for a resumed agent (`heartbeat.resumeAgentAfterPause`). */
  resumeWake: (agentId: string) => Promise<unknown>;
  /** Invokability check for one agent (false for paused/terminated/broken chain). */
  isAgentInvokable: (agent: {
    id: string;
    companyId: string;
    name: string;
    reportsTo: string | null;
    status: string;
  }) => Promise<boolean>;
  /** Maintenance-mode gate (myrmidon R3): agents in a window are not resumed. */
  isAgentUnderMaintenance: (agentId: string) => Promise<boolean>;
  /** Optional activity log; absent in unit tests. */
  logActivity?: (input: AutoResumeActivityInput) => Promise<void>;
  env?: NodeJS.ProcessEnv;
}

export interface AutoResumeSweepResult {
  agentsChecked: number;
  resumed: number;
  exhausted: number;
  skipped: number;
  /** Agents that received an automatic resume this pass. */
  agentIds: string[];
}

const AUTO_RESUME_RESULT_ZERO: Omit<AutoResumeSweepResult, "agentIds"> = {
  agentsChecked: 0,
  resumed: 0,
  exhausted: 0,
  skipped: 0,
};

/** A fresh zero result; a bare spread would share the agentIds array across calls. */
function emptyAutoResumeResult(): AutoResumeSweepResult {
  return { ...AUTO_RESUME_RESULT_ZERO, agentIds: [] };
}

interface AutoResumeAgentRow {
  id: string;
  companyId: string;
  name: string;
  reportsTo: string | null;
  status: string;
  errorReason: string | null;
  updatedAt: Date;
  metadata: Record<string, unknown> | null;
}

/**
 * Flips an errored agent back to idle and records the next streak state in the
 * same conditional update. Only the agent that still sits in `error` is
 * claimed, so a concurrent resume (an operator, another tick) cannot double
 * fire. The caller issues the wake chain only when this returns true.
 */
async function claimAutoResume(db: Db, agent: AutoResumeAgentRow, nextState: AutoResumeState, now: Date): Promise<boolean> {
  const rows = await db
    .update(agents)
    .set({
      status: "idle",
      errorReason: null,
      pauseReason: null,
      pausedAt: null,
      updatedAt: now,
      metadata: mergeAutoResumeState(agent.metadata, nextState),
    })
    .where(and(eq(agents.id, agent.id), eq(agents.status, "error")))
    .returning({ id: agents.id });
  return Boolean(rows[0]);
}

/**
 * Marks the agent as given up: writes `exhaustedAt` and deliberately leaves
 * `updated_at` untouched, because the re-arm rule compares a later operator
 * touch against that timestamp.
 */
async function markAutoResumeExhausted(
  db: Db,
  agent: AutoResumeAgentRow,
  nextState: AutoResumeState,
): Promise<boolean> {
  const rows = await db
    .update(agents)
    .set({ metadata: mergeAutoResumeState(agent.metadata, nextState) })
    .where(and(eq(agents.id, agent.id), eq(agents.status, "error")))
    .returning({ id: agents.id });
  return Boolean(rows[0]);
}

export interface AutoResumeSweeper {
  sweep(now?: Date): Promise<AutoResumeSweepResult>;
  resetForTest(): void;
}

/**
 * The scheduler-tick pass: resumes every errored agent whose backoff step is
 * due, at most once per `MYRMIDON_AUTO_RESUME_INTERVAL_SEC` seconds. The tick
 * handler owns the timer; this only remembers the last pass. Single-flight is
 * the caller's job (the sweep queue in `server/src/index.ts`).
 */
export function createAutoResumeSweeper(deps: AutoResumeSweeperDeps): AutoResumeSweeper {
  let lastSweepAtMs = 0;
  return {
    resetForTest() {
      lastSweepAtMs = 0;
    },
    async sweep(now = new Date()): Promise<AutoResumeSweepResult> {
      const env = deps.env ?? process.env;
      const settings = readAutoResumeSettings(env);
      if (!settings.enabled) return emptyAutoResumeResult();
      if (now.getTime() - lastSweepAtMs < settings.intervalSec * 1000) return emptyAutoResumeResult();
      lastSweepAtMs = now.getTime();

      const rows = (await deps.db
        .select({
          id: agents.id,
          companyId: agents.companyId,
          name: agents.name,
          reportsTo: agents.reportsTo,
          status: agents.status,
          errorReason: agents.errorReason,
          updatedAt: agents.updatedAt,
          metadata: agents.metadata,
        })
        .from(agents)
        .innerJoin(companies, eq(companies.id, agents.companyId))
        .where(and(eq(companies.status, "active"), eq(agents.status, "error")))) as AutoResumeAgentRow[];

      const result = emptyAutoResumeResult();
      for (const agent of rows) {
        result.agentsChecked += 1;
        const invokable = await deps.isAgentInvokable(agent);
        const underMaintenance = await deps.isAgentUnderMaintenance(agent.id);
        const decision = decideAutoResume({
          agent: { status: agent.status, updatedAt: agent.updatedAt },
          state: readAutoResumeState(agent.metadata),
          settings,
          now,
          invokable,
          underMaintenance,
        });

        if (decision.action === "skip") {
          result.skipped += 1;
          continue;
        }

        if (decision.action === "exhaust") {
          const marked = await markAutoResumeExhausted(deps.db, agent, decision.nextState!);
          if (!marked) {
            result.skipped += 1;
            continue;
          }
          result.exhausted += 1;
          await deps.logActivity?.({
            companyId: agent.companyId,
            actorType: "system",
            actorId: AUTO_RESUME_ACTOR_ID,
            agentId: agent.id,
            runId: null,
            action: AUTO_RESUME_EXHAUSTED_ACTIVITY_ACTION,
            entityType: "agent",
            entityId: agent.id,
            details: {
              attempts: decision.nextState!.failures,
              errorReason: agent.errorReason,
              reason: decision.reason,
            },
          });
          continue;
        }

        const claimed = await claimAutoResume(deps.db, agent, decision.nextState!, now);
        if (!claimed) {
          result.skipped += 1;
          continue;
        }
        try {
          await deps.resumeWake(agent.id);
        } catch (err) {
          // Best-effort: the agent is already back to idle; the next tick sees
          // it as idle and stops, and a stranded wake is retried by the other
          // resume paths (pause-drain, stranded recovery).
          logger.warn({ err, agentId: agent.id }, "auto-resume wake failed after an automatic resume");
        }
        result.resumed += 1;
        result.agentIds.push(agent.id);
        await deps.logActivity?.({
          companyId: agent.companyId,
          actorType: "system",
          actorId: AUTO_RESUME_ACTOR_ID,
          agentId: agent.id,
          runId: null,
          action: AUTO_RESUME_ACTIVITY_ACTION,
          entityType: "agent",
          entityId: agent.id,
          details: {
            attempt: decision.nextState!.failures,
            errorReason: agent.errorReason,
            nextAttemptAt: decision.nextState!.nextAttemptAt,
          },
        });
      }

      if (result.resumed > 0 || result.exhausted > 0) {
        logger.warn(
          { resumed: result.resumed, exhausted: result.exhausted, agentIds: result.agentIds },
          "auto-resume swept errored agents",
        );
      }
      return result;
    },
  };
}

/**
 * 24 h metric for the health page (part E): how many automatic resumes the
 * board issued for a company since the given instant. Reads the activity log,
 * so it survives a restart.
 */
export async function countAutoResumesSince(db: Db, companyId: string, since: Date): Promise<number> {
  return countActivitySince(db, companyId, AUTO_RESUME_ACTIVITY_ACTION, since);
}

/** How many agents the board gave up auto-resuming for a company since the given instant. */
export async function countAutoResumeExhaustionsSince(db: Db, companyId: string, since: Date): Promise<number> {
  return countActivitySince(db, companyId, AUTO_RESUME_EXHAUSTED_ACTIVITY_ACTION, since);
}

export interface AutoResumeMetrics {
  autoResumes: number;
  exhaustions: number;
}

/** Both counts in one call, for a health-page block that wants the pair. */
export async function autoResumeMetrics(
  db: Db,
  companyId: string,
  since: Date,
): Promise<AutoResumeMetrics> {
  const [autoResumes, exhaustions] = await Promise.all([
    countAutoResumesSince(db, companyId, since),
    countAutoResumeExhaustionsSince(db, companyId, since),
  ]);
  return { autoResumes, exhaustions };
}

async function countActivitySince(db: Db, companyId: string, action: string, since: Date): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, action),
        gte(activityLog.createdAt, since),
      ),
    );
  return rows[0]?.count ?? 0;
}