import { and, asc, eq, inArray, isNull, lt, or } from "drizzle-orm";
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
 *    (coalesced, run-linked) once a durable wake row exists.
 * 4. `sweepPending` re-runs delivery for intents that still have no durable
 *    wake. It is driven from the heartbeat scheduler (~30 s), so a dead
 *    post-commit path cannot lose the wake. Intent rows are system-actor rows
 *    (`requestedByActorId` = `interaction-continuation-outbox`).
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
  input: { companyId: string; idempotencyKey: string },
) {
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
        eq(agentWakeupRequests.idempotencyKey, input.idempotencyKey),
        inArray(agentWakeupRequests.status, [...DURABLE_WAKE_STATUSES]),
      ),
    )
    .orderBy(asc(agentWakeupRequests.requestedAt))
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
    // the canonical wake was enqueued (the canonical key is uq-protected).
    const durable = await findDurableWake(db, {
      companyId: claimed.companyId,
      idempotencyKey: wakeIdempotencyKey,
    });
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
      const settled = await findDurableWake(db, {
        companyId: claimed.companyId,
        idempotencyKey: wakeIdempotencyKey,
      });
      if (settled) {
        await markIntentTerminal(db, {
          intentId: claimed.id,
          status: "coalesced",
          runId: settled.runId ?? wakeRun?.id ?? null,
        });
        return;
      }
      // wakeup() admitted nothing durable (returned null / wrote a skipped
      // row). Release the claim; the sweep retries on its next pass.
      await releaseIntentClaim(db, claimed.id);
    } catch (error) {
      if (isUniqueViolation(error)) {
        // A racing worker inserted the canonical wake first.
        const raced = await findDurableWake(db, {
          companyId: claimed.companyId,
          idempotencyKey: wakeIdempotencyKey,
        });
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
    input: { limit?: number; staleClaimMs?: number } = {},
  ): Promise<{ scanned: number; delivered: number; failed: number }> {
    const now = new Date();
    const staleClaimMs = Math.max(1_000, input.staleClaimMs ?? STALE_CLAIM_MS);
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
