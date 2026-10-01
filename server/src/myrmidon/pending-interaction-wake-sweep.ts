import { and, asc, eq, inArray, isNull, like, lte, sql } from "drizzle-orm";
import {
  agentWakeupRequests,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
  type Db,
} from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

/**
 * Pending interaction addressee wake sweep (P12).
 *
 * Creating an issue-thread interaction addressed to an agent wakes that agent
 * with `wakeReason: interaction_pending`. When the task already has an active
 * run, the wake is parked in `deferred_issue_execution` instead of queued, and
 * only the release paths of *that task's own runs* promote it again
 * (`releaseIssueExecutionAndPromote` → `runReleaseDrain` → `promoteDeferredWake`).
 * A task with no runs at all therefore never promotes the parked wake: the
 * interaction stays unnoticed for days, expires by its own deadline (or is
 * superseded by a comment), and the receipt keeps starving in the queue.
 *
 * The sweep closes both halves of that gap on the scheduler tick:
 *
 * - The interaction a wake announced is no longer waiting (answered, expired,
 *   superseded, withdrawn) or its task is closed → the receipt is finalized as
 *   `cancelled` with the reason, so the wake's lifecycle follows the
 *   interaction's lifecycle instead of outliving it.
 * - The interaction is still waiting for that agent and no run holds the task →
 *   the receipt is re-admitted through the ordinary wake admission, which
 *   creates the queued run the parked wake never got. Bounded by
 *   `MYRMIDON_PENDING_INTERACTION_WAKE_RE_ADMISSIONS` per receipt, so a wake
 *   cannot storm a task every tick when the addressee never answers.
 *
 * A receipt whose own run is still going, or whose task is held by another live
 * run, is left alone: those paths own the delivery.
 */

export const PENDING_INTERACTION_WAKE_IDEMPOTENCY_PREFIX = "interaction-pending:";
export const PENDING_INTERACTION_WAKE_GRACE_ENV = "MYRMIDON_PENDING_INTERACTION_WAKE_GRACE_MS";
export const DEFAULT_PENDING_INTERACTION_WAKE_GRACE_MS = 10 * 60 * 1000;
export const PENDING_INTERACTION_WAKE_RE_ADMISSIONS_ENV = "MYRMIDON_PENDING_INTERACTION_WAKE_RE_ADMISSIONS";
export const DEFAULT_PENDING_INTERACTION_WAKE_RE_ADMISSIONS = 1;
/** The sweep inspects at most this many receipts per scheduler tick. */
export const PENDING_INTERACTION_WAKE_SWEEP_PAGE_SIZE = 50;
/** Payload key the sweep writes into a receipt it re-admitted, so the bound survives the new row. */
export const PENDING_INTERACTION_WAKE_SWEEP_PAYLOAD_KEY = "pendingInteractionWakeSweep";

export const PENDING_INTERACTION_WAKE_SWEPT_STATUSES = ["deferred_issue_execution", "queued"] as const;
const ACTIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
const TERMINAL_ISSUE_STATUSES = ["done", "cancelled"] as const;

export const PENDING_INTERACTION_WAKE_CANCELLED_INTERACTION_REASON =
  "Cancelled because the interaction this wake announced no longer waits for its addressee";
export const PENDING_INTERACTION_WAKE_CANCELLED_ISSUE_REASON =
  "Cancelled because the task this wake announced the interaction on is closed";
export const PENDING_INTERACTION_WAKE_RE_ADMISSION_LIMIT_REASON =
  "Cancelled because the interaction wake was re-admitted and the interaction is still unanswered";
export const PENDING_INTERACTION_WAKE_RE_ADMITTED_REASON =
  "Re-admitted as a fresh wake for the interaction that is still waiting for its addressee";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Grace window in milliseconds; invalid values fall back to the default. */
export function readPendingInteractionWakeGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  return readCountEnv(env, PENDING_INTERACTION_WAKE_GRACE_ENV, DEFAULT_PENDING_INTERACTION_WAKE_GRACE_MS);
}

/** Re-admission budget per receipt; invalid values fall back to the default. */
export function readPendingInteractionWakeReAdmissionBudget(env: NodeJS.ProcessEnv = process.env): number {
  return readCountEnv(env, PENDING_INTERACTION_WAKE_RE_ADMISSIONS_ENV, DEFAULT_PENDING_INTERACTION_WAKE_RE_ADMISSIONS);
}

function readCountEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : fallback;
}

export type PendingInteractionWakeFacts = {
  /** The receipt's own run is still on the execution path, so that run owns the delivery. */
  ownRunStillActive: boolean;
  /** The interaction the wake announced still exists in this company. */
  interactionExists: boolean;
  /** The interaction is `pending` and addressed to the receipt's own agent. */
  interactionWaitsForAddressee: boolean;
  /** Current task status, or `null` when the task row is gone. */
  issueStatus: string | null;
  /** Another live run already holds the task, so the release drain promotes the parked wake. */
  activeRunHoldsIssue: boolean;
  /** How many times this receipt has already been re-admitted by the sweep. */
  reAdmissionAttempts: number;
};

export type PendingInteractionWakeAction =
  | { kind: "cancel"; reason: string }
  | { kind: "re_admit" }
  | { kind: "skip"; reason: "own_run_active" | "active_run_holds_issue" };

/**
 * Decides what happens to one parked addressee receipt. Pure: the caller reads
 * the database and packs the result into `facts`.
 *
 * Order matters. A live run of the receipt itself is checked first — its own
 * release path promotes or finalizes the receipt, and cancelling under it would
 * race that path. Then the interaction lifecycle decides: a receipt whose
 * interaction no longer waits is finalized whatever the task looks like. Only a
 * receipt whose interaction still waits for this agent, on an open task without
 * a live run, is re-admitted; the re-admission budget bounds that to a fixed
 * number of deliveries per receipt.
 */
export function decidePendingInteractionWakeAction(
  facts: PendingInteractionWakeFacts,
  options: { maxReAdmissions: number },
): PendingInteractionWakeAction {
  if (facts.ownRunStillActive) return { kind: "skip", reason: "own_run_active" };
  if (!facts.interactionExists || !facts.interactionWaitsForAddressee) {
    return { kind: "cancel", reason: PENDING_INTERACTION_WAKE_CANCELLED_INTERACTION_REASON };
  }
  if (facts.issueStatus === null || (TERMINAL_ISSUE_STATUSES as readonly string[]).includes(facts.issueStatus)) {
    return { kind: "cancel", reason: PENDING_INTERACTION_WAKE_CANCELLED_ISSUE_REASON };
  }
  if (facts.activeRunHoldsIssue) return { kind: "skip", reason: "active_run_holds_issue" };
  if (facts.reAdmissionAttempts >= options.maxReAdmissions) {
    return { kind: "cancel", reason: PENDING_INTERACTION_WAKE_RE_ADMISSION_LIMIT_REASON };
  }
  return { kind: "re_admit" };
}

/** The interaction id a parked addressee receipt announced, or `null` when the payload carries none. */
export function readPendingInteractionWakeInteractionId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>).interactionId;
  return typeof value === "string" && UUID_PATTERN.test(value) ? value : null;
}

/** How many times the sweep already re-admitted this receipt. */
export function readPendingInteractionWakeReAdmissions(payload: unknown): number {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return 0;
  const marker = (payload as Record<string, unknown>)[PENDING_INTERACTION_WAKE_SWEEP_PAYLOAD_KEY];
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) return 0;
  const attempt = (marker as Record<string, unknown>).attempt;
  return typeof attempt === "number" && Number.isSafeInteger(attempt) && attempt > 0 ? attempt : 0;
}

/** The payload a re-admitted receipt carries: the same wake plus the sweep's re-admission marker. */
export function buildReAdmittedWakePayload(
  payload: Record<string, unknown>,
  attempts: number,
  now: Date,
): Record<string, unknown> {
  const next = { ...payload };
  delete next._paperclipWakeContext;
  delete next.queuedCommentInterrupt;
  next[PENDING_INTERACTION_WAKE_SWEEP_PAYLOAD_KEY] = { attempt: attempts, reAdmittedAt: now.toISOString() };
  return next;
}

/** The context the re-admitted wake is delivered with: the parked receipt's own deferred seed. */
export function readPendingInteractionWakeContextSnapshot(payload: Record<string, unknown>): Record<string, unknown> {
  const seed = payload._paperclipWakeContext;
  if (seed && typeof seed === "object" && !Array.isArray(seed)) return { ...(seed as Record<string, unknown>) };
  return {};
}

export type PendingInteractionWakeRow = {
  id: string;
  companyId: string;
  agentId: string;
  source: string;
  triggerDetail: string | null;
  reason: string | null;
  payload: Record<string, unknown>;
  idempotencyKey: string | null;
  requestedByActorType: string | null;
  requestedByActorId: string | null;
  attempts: number;
};

export interface PendingInteractionWakeSweepDeps {
  db: Db;
  /**
   * Re-runs the ordinary wake admission for a parked addressee receipt, so a real
   * queued run is created for the same interaction. The caller supplies the
   * delivery options; the sweep only decides that a delivery is due.
   */
  reAdmit: (wake: PendingInteractionWakeRow) => Promise<void>;
}

export interface PendingInteractionWakeSweepResult {
  inspected: number;
  reAdmitted: number;
  cancelled: number;
  skippedOwnRun: number;
  skippedActiveRun: number;
  failed: number;
}

export function createPendingInteractionWakeSweep(deps: PendingInteractionWakeSweepDeps) {
  return async function sweepPendingInteractionWakes(opts?: {
    graceMs?: number;
    maxReAdmissions?: number;
    now?: Date;
    limit?: number;
  }): Promise<PendingInteractionWakeSweepResult> {
    const graceMs = opts?.graceMs ?? readPendingInteractionWakeGraceMs();
    const maxReAdmissions = opts?.maxReAdmissions ?? readPendingInteractionWakeReAdmissionBudget();
    const now = opts?.now ?? new Date();
    const cutoff = new Date(now.getTime() - graceMs);
    const limit = Math.max(1, Math.min(opts?.limit ?? PENDING_INTERACTION_WAKE_SWEEP_PAGE_SIZE, 500));

    const rows = await deps.db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          like(agentWakeupRequests.idempotencyKey, `${PENDING_INTERACTION_WAKE_IDEMPOTENCY_PREFIX}%`),
          inArray(agentWakeupRequests.status, [...PENDING_INTERACTION_WAKE_SWEPT_STATUSES]),
          lte(agentWakeupRequests.createdAt, cutoff),
        ),
      )
      .orderBy(asc(agentWakeupRequests.createdAt))
      .limit(limit);

    const result: PendingInteractionWakeSweepResult = {
      inspected: 0,
      reAdmitted: 0,
      cancelled: 0,
      skippedOwnRun: 0,
      skippedActiveRun: 0,
      failed: 0,
    };

    for (const row of rows) {
      result.inspected += 1;
      try {
        const payload = (row.payload ?? {}) as Record<string, unknown>;
        const attempts = readPendingInteractionWakeReAdmissions(payload);
        const decision = await decideForRow(deps.db, row, payload, attempts, maxReAdmissions);
        if (decision.kind === "skip") {
          if (decision.reason === "own_run_active") result.skippedOwnRun += 1;
          else result.skippedActiveRun += 1;
          continue;
        }
        const finalized = await finalizeReceipt(deps.db, row, decision.kind === "re_admit"
          ? PENDING_INTERACTION_WAKE_RE_ADMITTED_REASON
          : decision.reason, now);
        if (!finalized) {
          // Another writer moved the receipt off the swept status first; its own path owns it now.
          continue;
        }
        if (decision.kind === "cancel") {
          result.cancelled += 1;
          logger.warn(
            { wakeId: row.id, agentId: row.agentId, wakeStatus: row.status },
            "finalized a parked interaction wake whose interaction no longer waits",
          );
          continue;
        }
        await deps.reAdmit({
          id: row.id,
          companyId: row.companyId,
          agentId: row.agentId,
          source: row.source,
          triggerDetail: row.triggerDetail,
          reason: row.reason,
          payload: buildReAdmittedWakePayload(payload, attempts + 1, now),
          idempotencyKey: row.idempotencyKey,
          requestedByActorType: row.requestedByActorType,
          requestedByActorId: row.requestedByActorId,
          attempts: attempts + 1,
        });
        result.reAdmitted += 1;
      } catch {
        // Log a constant errorKind only: the exception can carry a credential in
        // its message, code, cause or stack. The receipt stays for a later tick.
        result.failed += 1;
        logger.warn(
          { errorKind: "sweep_failed", wakeId: row.id },
          "parked interaction wake sweep failed for one receipt",
        );
      }
    }

    return result;
  };
}

async function decideForRow(
  db: Db,
  row: typeof agentWakeupRequests.$inferSelect,
  payload: Record<string, unknown>,
  attempts: number,
  maxReAdmissions: number,
): Promise<PendingInteractionWakeAction> {
  const ownRunStillActive = row.runId
    ? await hasStatus(db, row.runId, row.companyId, [...ACTIVE_RUN_STATUSES])
    : false;
  const interactionId = readPendingInteractionWakeInteractionId(payload);
  const interaction = interactionId
    ? await db
        .select({
          id: issueThreadInteractions.id,
          status: issueThreadInteractions.status,
          addresseeAgentId: issueThreadInteractions.addresseeAgentId,
          issueId: issueThreadInteractions.issueId,
        })
        .from(issueThreadInteractions)
        .where(
          and(
            eq(issueThreadInteractions.id, interactionId),
            eq(issueThreadInteractions.companyId, row.companyId),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null)
    : null;

  const issue = interaction
    ? await db
        .select({ status: issues.status })
        .from(issues)
        .where(and(eq(issues.id, interaction.issueId), eq(issues.companyId, row.companyId)))
        .limit(1)
        .then((rows) => rows[0] ?? null)
    : null;

  const activeRunHoldsIssue =
    interaction && issue
      ? (await db
          .select({ id: heartbeatRuns.id })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.companyId, row.companyId),
              inArray(heartbeatRuns.status, [...ACTIVE_RUN_STATUSES]),
              isNull(heartbeatRuns.finishedAt),
              sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${interaction.issueId}`,
            ),
          )
          .limit(1)).length > 0
      : false;

  return decidePendingInteractionWakeAction(
    {
      ownRunStillActive,
      interactionExists: interaction !== null,
      interactionWaitsForAddressee:
        interaction !== null && interaction.status === "pending" && interaction.addresseeAgentId === row.agentId,
      issueStatus: issue?.status ?? null,
      activeRunHoldsIssue,
      reAdmissionAttempts: attempts,
    },
    { maxReAdmissions },
  );
}

async function hasStatus(
  db: Db,
  runId: string,
  companyId: string,
  statuses: readonly string[],
): Promise<boolean> {
  const rows = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.id, runId),
        eq(heartbeatRuns.companyId, companyId),
        inArray(heartbeatRuns.status, [...statuses]),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Finalizes one swept receipt with a compare-and-set on the status the sweep
 * read, so a receipt another writer already moved is never overwritten.
 */
async function finalizeReceipt(
  db: Db,
  row: typeof agentWakeupRequests.$inferSelect,
  reason: string,
  now: Date,
): Promise<boolean> {
  const updated = await db
    .update(agentWakeupRequests)
    .set({ status: "cancelled", error: reason, finishedAt: now, updatedAt: now })
    .where(and(eq(agentWakeupRequests.id, row.id), eq(agentWakeupRequests.status, row.status)))
    .returning({ id: agentWakeupRequests.id });
  return updated.length > 0;
}