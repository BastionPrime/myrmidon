import { and, asc, desc, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import {
  agentWakeupRequests,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { isUniqueViolation } from "../db-errors.js";

/**
 * Transactional outbox for interaction-continuation wakes (O1).
 *
 * `queueResolvedInteractionContinuationWakeup` (routes/issues.ts) dispatches
 * the assignee wake fire-and-forget after the accept transaction commits. An
 * admission failure (issue-row lock contention, process restart, connection
 * reset) vanishes between the HTTP response and the async insert: no wake
 * row, no deferred row, no skipped row, so the assignee's continuation is
 * simply lost. Measured on a busy installation this dropped about 7% of the
 * accepted cards whose creator is also the assignee. The one-shot
 * "review path lost" fallback does not retry after its two transient
 * attempts.
 *
 * This outbox closes the gap on the table that already exists
 * (`agent_wakeup_requests`), with no schema migration:
 *
 * 1. `recordInteractionContinuationOutbox` inserts an intent row in the SAME
 *    transaction as the card resolution (via `afterResolveInTransaction`),
 *    with a dedicated `interaction-continuation-outbox:{interactionId}:{status}`
 *    idempotency key. That key prefix sits outside the canonical
 *    `interaction:%` namespace, so the partial unique index
 *    `agent_wakeup_requests_question_response_delivery_idempotency_uq`
 *    (migration 0260) stays a property of the delivered wake alone and never
 *    conflicts with an intent row.
 * 2. The dispatch contract (canonical wake idempotency key, coalescing flag,
 *    wake payload and context snapshot) is stored inside the intent row's
 *    `payload` under `interactionContinuationOutbox`.
 * 3. `tryDeliver` runs post-commit: it calls `heartbeat.wakeup` with the
 *    canonical `interaction:{id}:{status}` key and marks the intent terminal
 *    (coalesced, run-linked) once a durable wake row exists. A wake also
 *    counts as delivered (O1-DIRECT-SETTLED) when `wakeup` returned a run,
 *    or when the same agent already holds a delivery-status wake for the
 *    same interaction (e.g. folded into a `deferred_issue_execution` row):
 *    the vendor accepted the continuation, so only an admission refusal is
 *    left to the sweep.
 * 4. `sweepPending` re-runs delivery for intents that still have no durable
 *    wake. It is driven from the heartbeat scheduler (~30 s), so a dead
 *    post-commit path cannot lose the wake. Intent rows are system-actor rows
 *    (`requestedByActorId` = `interaction-continuation-outbox`). The sweep
 *    only picks up intents older than the sweep-age threshold
 *    (`readOutboxSweepAgeMs`, default 45 s): a just-resolved card belongs to
 *    the direct post-commit dispatch, and an early sweep could otherwise
 *    deliver its trimmed envelope before the direct wake's richer one.
 *
 * Bounds that keep the outbox from becoming a second, noisier scheduler:
 * - an intent is only written when the card's continuation policy would wake
 *   the assignee on this resolution (`continuationPolicyWakesOnResolution`)
 *   and is re-checked against the live card at delivery;
 * - a claim is a lease (`STALE_CLAIM_MS`): a worker that already holds a
 *   fresh claim is never double-dispatched;
 * - an intent that never produced a durable wake within `MAX_INTENT_AGE_MS`
 *   (the wake is being refused on purpose: scheduling suppression, held
 *   tree, inactive company) is retired instead of retried forever.
 */

const OUTBOX_ACTOR_TYPE = "system" as const;
const OUTBOX_ACTOR_ID = "interaction-continuation-outbox";
const OUTBOX_KEY_PREFIX = "interaction-continuation-outbox:";
const OUTBOX_CONTRACT_KEY = "interactionContinuationOutbox";
const STALE_CLAIM_MS = 60_000;
const MAX_INTENT_AGE_MS = 15 * 60_000;

/**
 * Sweep-age threshold (O1-SWEEP-AGE). The post-commit direct dispatch
 * (`tryDeliver`) runs within milliseconds of the resolution transaction, but
 * the scheduler sweep can land in the same window and would otherwise take
 * the just-written intent first: the sweep delivers the trimmed outbox
 * envelope (only the interaction ids and `mutation: interaction`) while the
 * direct path's richer envelope (plan review details, checkbox selection,
 * tool action, fresh-session flags) is still in flight. The sweep therefore
 * only backs off intents older than this threshold, giving the direct path
 * the whole window to settle the intent on its own. 45 s sits inside the
 * 30–60 s band from the plan and is several scheduler ticks (~30 s) wide.
 * Only the sweep applies it; `tryDeliver` is not throttled because it is the
 * direct post-commit path.
 *
 * Configurable via `MYRMIDON_OUTBOX_SWEEP_AGE_MS`; non-numeric, negative,
 * or non-integer values fall back to the default. 0 is a valid override
 * (restores the immediate sweep) but is not the default.
 */
export const OUTBOX_SWEEP_AGE_ENV = "MYRMIDON_OUTBOX_SWEEP_AGE_MS";
export const OUTBOX_SWEEP_AGE_DEFAULT_MS = 45_000;

/** Sweep-age threshold in ms from `MYRMIDON_OUTBOX_SWEEP_AGE_MS` (default 45 000). */
export function readOutboxSweepAgeMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[OUTBOX_SWEEP_AGE_ENV]?.trim();
  if (!raw) return OUTBOX_SWEEP_AGE_DEFAULT_MS;
  if (!/^\d+$/.test(raw)) return OUTBOX_SWEEP_AGE_DEFAULT_MS;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : OUTBOX_SWEEP_AGE_DEFAULT_MS;
}

const DURABLE_WAKE_STATUSES = [
  "queued",
  "claimed",
  "running",
  "succeeded",
  "completed",
  "coalesced",
  "deferred_issue_execution",
  "retrying",
  "scheduled_retry",
] as const;

type HeartbeatWakeup = (
  agentId: string,
  options: {
    source: "automation";
    triggerDetail: "system";
    reason: string;
    payload: Record<string, unknown>;
    idempotencyKey: string;
    allowRunCoalescing?: boolean;
    requestedByActorType?: "user" | "agent" | "system";
    requestedByActorId?: string | null;
    contextSnapshot?: Record<string, unknown>;
  },
) => Promise<unknown>;

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

type OutboxContract = {
  wakeIdempotencyKey: string;
  allowRunCoalescing: boolean;
  payload: Record<string, unknown>;
  contextSnapshot: Record<string, unknown>;
};

export function interactionContinuationOutboxKey(
  interactionId: string,
  status: string,
) {
  return `${OUTBOX_KEY_PREFIX}${interactionId}:${status}`;
}

/**
 * Mirrors the continuation-policy gate of the vendor wake path: `none` never
 * wakes, `wake_assignee` wakes on any resolution, `wake_assignee_on_accept`
 * only on the positive resolution (accepted / answered).
 */
export function continuationPolicyWakesOnResolution(
  policy: string,
  status: string,
): boolean {
  return (
    policy === "wake_assignee" ||
    (policy === "wake_assignee_on_accept" &&
      (status === "accepted" || status === "answered"))
  );
}

/**
 * Persist the continuation intent inside the resolution transaction.
 *
 * The intent carries only the dispatch contract; the authoritative
 * resolution lives on the interaction row itself.
 */
export async function recordInteractionContinuationOutbox(
  tx: Db,
  input: {
    companyId: string;
    agentId: string;
    interactionId: string;
    interactionStatus: string;
    reason: string;
    contract: OutboxContract;
  },
): Promise<void> {
  await tx
    .insert(agentWakeupRequests)
    .values({
      companyId: input.companyId,
      agentId: input.agentId,
      source: "automation",
      triggerDetail: "system",
      reason: input.reason,
      payload: {
        issueId: input.contract.payload.issueId ?? null,
        interactionId: input.interactionId,
        interactionStatus: input.interactionStatus,
        [OUTBOX_CONTRACT_KEY]: input.contract,
      },
      status: "queued",
      requestedByActorType: OUTBOX_ACTOR_TYPE,
      requestedByActorId: OUTBOX_ACTOR_ID,
      idempotencyKey: interactionContinuationOutboxKey(
        input.interactionId,
        input.interactionStatus,
      ),
    })
    .onConflictDoNothing();
}

/**
 * Builds the `mutationOptions` that `acceptInteraction` / `rejectInteraction`
 * accept, so the intent commits atomically with the card's own verdict write.
 * Returns no hook when the card's continuation policy would not wake the
 * assignee on this resolution (nothing to deliver, so nothing to persist).
 */
export function interactionContinuationOutboxMutationOptions(input: {
  issue: { id: string; companyId: string; assigneeAgentId: string | null };
  interaction: {
    id: string;
    kind: string;
    status: string;
    continuationPolicy: string;
    sourceCommentId?: string | null;
    sourceRunId?: string | null;
  };
  idempotencyKey?: string | null;
}): {
  afterResolveInTransaction?: (
    tx: DbTransaction,
    resolved: { id: string; status: string },
  ) => Promise<void>;
} {
  if (
    !input.issue.assigneeAgentId ||
    !continuationPolicyWakesOnResolution(
      input.interaction.continuationPolicy,
      input.interaction.status,
    )
  ) {
    return {};
  }
  const assigneeAgentId = input.issue.assigneeAgentId;
  return {
    afterResolveInTransaction: async (tx, resolved) => {
      await recordInteractionContinuationOutbox(tx as unknown as Db, {
        companyId: input.issue.companyId,
        agentId: assigneeAgentId,
        interactionId: resolved.id,
        interactionStatus: resolved.status,
        reason: "issue_commented",
        contract: {
          wakeIdempotencyKey:
            input.idempotencyKey ?? `interaction:${resolved.id}:${resolved.status}`,
          allowRunCoalescing: true,
          payload: {
            issueId: input.issue.id,
            interactionId: resolved.id,
            interactionKind: input.interaction.kind,
            interactionStatus: resolved.status,
            sourceCommentId: input.interaction.sourceCommentId ?? null,
            sourceRunId: input.interaction.sourceRunId ?? null,
            mutation: "interaction",
          },
          contextSnapshot: {
            issueId: input.issue.id,
            taskId: input.issue.id,
            interactionId: resolved.id,
            interactionKind: input.interaction.kind,
            interactionStatus: resolved.status,
            sourceCommentId: input.interaction.sourceCommentId ?? null,
            sourceRunId: input.interaction.sourceRunId ?? null,
            wakeReason: "issue_commented",
            source: "issue.interaction.resolve",
          },
        },
      });
    },
  };
}

async function findDurableWake(
  db: Db,
  input: {
    companyId: string;
    idempotencyKey: string;
    /**
     * Fallback match: same agent, same interaction, same resolution status,
     * delivery statuses.
     */
    agentId?: string;
    interactionId?: string;
    interactionStatus?: string;
    /** Excluded from the fallback match (the outbox intent row itself). */
    intentId?: string;
  },
) {
  const canonical = await db
    .select({
      id: agentWakeupRequests.id,
      runId: agentWakeupRequests.runId,
      status: agentWakeupRequests.status,
    })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.idempotencyKey, input.idempotencyKey),
        inArray(agentWakeupRequests.status, [...DURABLE_WAKE_STATUSES]),
      ),
    )
    .orderBy(asc(agentWakeupRequests.requestedAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (canonical) return canonical;

  // O1-DIRECT-SETTLED (b2): the vendor accepted the wake without creating a
  // canonical-keyed row — `admitWakeBehindIssueExecution` folds the incoming
  // wake into the assignee's existing `deferred_issue_execution` row (whose
  // idempotencyKey is NOT the canonical key), and `recordExecutionWait`
  // writes delivery receipts under a digest key. A delivery-status wake of
  // the same agent for the same interaction means the continuation is
  // already in flight; re-dispatching would start a second one. `skipped`
  // (an explicit refusal) is never a delivery and never matches. The
  // outbox's own intent rows are excluded: they are the work item, not the
  // delivered wake.
  //
  // The match is pinned to the resolution status of the intent: every direct
  // continuation wake carries `payload.interactionStatus` (and a merge into a
  // deferred row keeps it), while the vendor's card-creation wake
  // (`interaction-pending:{id}`, sent to an addressee agent who may well be
  // the assignee) carries no status. Without the pin, that old, long
  // finished pending wake would settle the intent and drop the continuation.
  if (!input.agentId || !input.interactionId || !input.interactionStatus) {
    return null;
  }
  return db
    .select({
      id: agentWakeupRequests.id,
      runId: agentWakeupRequests.runId,
      status: agentWakeupRequests.status,
    })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.agentId, input.agentId),
        inArray(agentWakeupRequests.status, [...DURABLE_WAKE_STATUSES]),
        sql`${agentWakeupRequests.payload}->>'interactionId' = ${input.interactionId}`,
        sql`${agentWakeupRequests.payload}->>'interactionStatus' = ${input.interactionStatus}`,
        input.intentId ? ne(agentWakeupRequests.id, input.intentId) : undefined,
        or(
          isNull(agentWakeupRequests.requestedByActorId),
          ne(agentWakeupRequests.requestedByActorId, OUTBOX_ACTOR_ID),
        ),
      ),
    )
    .orderBy(desc(agentWakeupRequests.requestedAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

async function markIntentTerminal(
  db: Db,
  input: {
    intentId: string;
    status: string;
    runId: string | null;
    error?: string | null;
  },
) {
  await db
    .update(agentWakeupRequests)
    .set({
      status: input.status,
      runId: input.runId,
      error: input.error ?? null,
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(agentWakeupRequests.id, input.intentId));
}

async function releaseIntentClaim(db: Db, intentId: string) {
  // The intent status stays "queued" through the claim (the claim is the
  // `claimedAt` lease, not a status transition), so match by id alone.
  await db
    .update(agentWakeupRequests)
    .set({ claimedAt: null, updatedAt: new Date() })
    .where(eq(agentWakeupRequests.id, intentId));
}

export function interactionContinuationOutboxService(
  db: Db,
  heartbeat: { wakeup: HeartbeatWakeup },
) {
  /**
   * Post-commit delivery. Never throws: the persisted intent stays due and
   * sweepPending retries it.
   */
  async function tryDeliver(
    interactionId: string,
    interactionStatus: string,
  ): Promise<void> {
    try {
      await deliver(interactionContinuationOutboxKey(interactionId, interactionStatus));
    } catch (error) {
      logger.warn(
        { err: error, interactionId },
        "interaction continuation outbox delivery failed; sweep will retry",
      );
    }
  }

  async function deliver(
    intentKey: string,
    staleClaimMs: number = STALE_CLAIM_MS,
  ): Promise<void> {
    const now = new Date();
    // Claim the due intent: the post-commit path and the sweep must not
    // double-dispatch. A claim is a lease; only an unclaimed intent or one
    // whose lease went stale (crashed worker) can be claimed again.
    const claimedRows = await db
      .update(agentWakeupRequests)
      .set({ claimedAt: now, updatedAt: now, error: null })
      .where(
        and(
          eq(agentWakeupRequests.idempotencyKey, intentKey),
          eq(agentWakeupRequests.requestedByActorType, OUTBOX_ACTOR_TYPE),
          eq(agentWakeupRequests.requestedByActorId, OUTBOX_ACTOR_ID),
          inArray(agentWakeupRequests.status, ["queued", "claimed"]),
          isNull(agentWakeupRequests.runId),
          or(
            isNull(agentWakeupRequests.claimedAt),
            lt(agentWakeupRequests.claimedAt, new Date(now.getTime() - staleClaimMs)),
          ),
        ),
      )
      .returning();
    const claimed = claimedRows[0];
    if (!claimed) return;

    const interactionId = claimed.payload?.interactionId;
    if (typeof interactionId !== "string" || interactionId.length === 0) {
      await markIntentTerminal(db, {
        intentId: claimed.id,
        status: "skipped",
        runId: null,
        error: "interaction_continuation_outbox_invalid_contract",
      });
      return;
    }

    // Re-resolve the live wake target: the resolution transaction may have
    // reassigned the issue (accepted plan start, creator return) after the
    // intent was written, and a closed issue no longer needs a wake.
    const resolvedRows = await db
      .select({
        assigneeAgentId: issues.assigneeAgentId,
        issueStatus: issues.status,
        interactionStatus: issueThreadInteractions.status,
        continuationPolicy: issueThreadInteractions.continuationPolicy,
      })
      .from(issueThreadInteractions)
      .innerJoin(
        issues,
        and(
          eq(issues.companyId, claimed.companyId),
          eq(issues.id, issueThreadInteractions.issueId),
        ),
      )
      .where(
        and(
          eq(issueThreadInteractions.id, interactionId),
          eq(issueThreadInteractions.companyId, claimed.companyId),
        ),
      )
      .limit(1);
    const resolved = resolvedRows[0];
    let retireReason: string | null = null;
    if (!resolved) {
      retireReason = "interaction_continuation_outbox_target_missing";
    } else if (
      resolved.interactionStatus === "pending" ||
      ["done", "cancelled"].includes(resolved.issueStatus)
    ) {
      retireReason = "interaction_continuation_outbox_target_terminal";
    } else if (
      !resolved.assigneeAgentId ||
      resolved.assigneeAgentId !== claimed.agentId
    ) {
      retireReason = "interaction_continuation_outbox_assignee_changed";
    } else if (
      !continuationPolicyWakesOnResolution(
        resolved.continuationPolicy,
        resolved.interactionStatus,
      )
    ) {
      retireReason = "interaction_continuation_outbox_policy_no_wake";
    }
    if (retireReason || !resolved || !resolved.assigneeAgentId) {
      // The card was re-opened, the issue closed, the assignee moved on or
      // the card never asked for a continuation: the wake path is owned
      // elsewhere now. Retire the intent.
      await markIntentTerminal(db, {
        intentId: claimed.id,
        status: "skipped",
        runId: null,
        error: retireReason ?? "interaction_continuation_outbox_target_missing",
      });
      return;
    }
    const assigneeAgentId = resolved.assigneeAgentId;

    const payload = (claimed.payload ?? {}) as Record<string, unknown>;
    const contract = payload[OUTBOX_CONTRACT_KEY] as
      | Partial<OutboxContract>
      | undefined;
    const wakeIdempotencyKey =
      typeof contract?.wakeIdempotencyKey === "string" &&
      contract.wakeIdempotencyKey.length > 0
        ? contract.wakeIdempotencyKey
        : null;
    if (
      !wakeIdempotencyKey ||
      !contract ||
      typeof contract.payload !== "object" ||
      contract.payload === null ||
      typeof contract.contextSnapshot !== "object" ||
      contract.contextSnapshot === null
    ) {
      // Unknown intent shape: retire instead of looping forever.
      await markIntentTerminal(db, {
        intentId: claimed.id,
        status: "skipped",
        runId: null,
        error: "interaction_continuation_outbox_invalid_contract",
      });
      return;
    }
    const allowRunCoalescing = contract.allowRunCoalescing !== false;

    // Check before dispatch: a previous worker may have crashed right after
    // the canonical wake was enqueued (the canonical key is uq-protected), or
    // the direct path's wake was already folded into one of the assignee's
    // delivery rows for this interaction (O1-DIRECT-SETTLED).
    const durableMatch = {
      companyId: claimed.companyId,
      idempotencyKey: wakeIdempotencyKey,
      agentId: assigneeAgentId,
      interactionId,
      // The resolution status the intent was written for (the canonical key
      // carries the same one); the live card status is the fallback.
      interactionStatus:
        typeof payload.interactionStatus === "string" &&
        payload.interactionStatus.length > 0
          ? payload.interactionStatus
          : resolved.interactionStatus,
      intentId: claimed.id,
    };
    const durable = await findDurableWake(db, durableMatch);
    if (durable) {
      await markIntentTerminal(db, {
        intentId: claimed.id,
        status: "coalesced",
        runId: durable.runId ?? null,
      });
      return;
    }

    // The wake is refused on purpose (scheduling suppression, held tree,
    // inactive company, ...) and has been for the whole retry window: stop
    // instead of writing a skipped row on every pass.
    if (now.getTime() - claimed.requestedAt.getTime() > MAX_INTENT_AGE_MS) {
      logger.warn(
        { intentId: claimed.id, interactionId },
        "interaction continuation outbox intent expired without a durable wake",
      );
      await markIntentTerminal(db, {
        intentId: claimed.id,
        status: "skipped",
        runId: null,
        error: "interaction_continuation_outbox_expired",
      });
      return;
    }

    try {
      const wakeRun = (await heartbeat.wakeup(assigneeAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: claimed.reason ?? "issue_commented",
        payload: { ...contract.payload },
        idempotencyKey: wakeIdempotencyKey,
        allowRunCoalescing,
        requestedByActorType: claimed.requestedByActorType as
          | "user"
          | "agent"
          | "system",
        requestedByActorId: claimed.requestedByActorId,
        contextSnapshot: { ...contract.contextSnapshot },
      })) as { id?: string } | null;
      const settled = await findDurableWake(db, durableMatch);
      if (settled) {
        await markIntentTerminal(db, {
          intentId: claimed.id,
          status: "coalesced",
          runId: settled.runId ?? wakeRun?.id ?? null,
        });
        return;
      }
      if (wakeRun?.id) {
        // O1-DIRECT-SETTLED (b1): wakeup() returned a run — the vendor
        // admitted the wake and dispatched it. No row with the canonical key
        // may be visible yet (the wake can land in an unrelated receipt
        // shape, e.g. merged into a deferred wake without a canonical-keyed
        // row), but a returned run is the vendor's own admission result:
        // the continuation is in flight, so the intent is settled now. The
        // sweep must not re-dispatch it into a second continuation.
        await markIntentTerminal(db, {
          intentId: claimed.id,
          status: "coalesced",
          runId: wakeRun.id,
        });
        return;
      }
      // wakeup() admitted nothing durable (returned null / wrote a skipped
      // row). Release the claim; the sweep retries on its next pass.
      await releaseIntentClaim(db, claimed.id);
    } catch (error) {
      if (isUniqueViolation(error)) {
        // A racing worker inserted the canonical wake first.
        const raced = await findDurableWake(db, durableMatch);
        if (raced) {
          await markIntentTerminal(db, {
            intentId: claimed.id,
            status: "coalesced",
            runId: raced.runId ?? null,
          });
          return;
        }
      }
      // Release the claim so the lease does not hold a just-failed attempt
      // hostage for a full STALE_CLAIM_MS cycle.
      await releaseIntentClaim(db, claimed.id);
      throw error;
    }
  }

  async function sweepPending(
    input: {
      limit?: number;
      staleClaimMs?: number;
      /** Test seam: overrides the sweep-age threshold (defaults to the env setting). */
      sweepAgeMs?: number;
    } = {},
  ): Promise<{ scanned: number; delivered: number; failed: number }> {
    const now = new Date();
    const staleClaimMs = Math.max(1_000, input.staleClaimMs ?? STALE_CLAIM_MS);
    // O1-SWEEP-AGE: only back off intents the direct post-commit path has had
    // a whole window to settle. A just-written intent belongs to tryDeliver;
    // an early sweep would deliver the trimmed envelope before the direct
    // wake's richer one (and can race a direct dispatch still in flight).
    // The threshold never applies to the direct path itself.
    const sweepAgeMs = input.sweepAgeMs ?? readOutboxSweepAgeMs();
    const candidates = await db
      .select({
        id: agentWakeupRequests.id,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.requestedByActorType, OUTBOX_ACTOR_TYPE),
          eq(agentWakeupRequests.requestedByActorId, OUTBOX_ACTOR_ID),
          inArray(agentWakeupRequests.status, ["queued", "claimed"]),
          isNull(agentWakeupRequests.runId),
          lt(
            agentWakeupRequests.requestedAt,
            new Date(now.getTime() - sweepAgeMs),
          ),
          or(
            isNull(agentWakeupRequests.claimedAt),
            lt(agentWakeupRequests.claimedAt, new Date(now.getTime() - staleClaimMs)),
          ),
        ),
      )
      .orderBy(asc(agentWakeupRequests.requestedAt))
      .limit(Math.max(1, Math.min(input.limit ?? 100, 500)));
    let delivered = 0;
    let failed = 0;
    for (const candidate of candidates) {
      if (!candidate.idempotencyKey?.startsWith(OUTBOX_KEY_PREFIX)) continue;
      try {
        await deliver(candidate.idempotencyKey, staleClaimMs);
        delivered += 1;
      } catch (error) {
        failed += 1;
        logger.warn(
          { err: error, intentId: candidate.id },
          "failed to dispatch persisted interaction continuation outbox intent",
        );
      }
    }
    return { scanned: candidates.length, delivered, failed };
  }

  return { tryDeliver, sweepPending };
}
