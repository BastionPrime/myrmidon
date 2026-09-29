// myrmidon(O1): transactional outbox for accept-continuation wakes — see
// interaction-continuation-outbox.ts and its call points in routes/issues.ts
// and index.ts.
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import {
  continuationPolicyWakesOnResolution,
  interactionContinuationOutboxKey,
  interactionContinuationOutboxMutationOptions,
  interactionContinuationOutboxService,
  recordInteractionContinuationOutbox,
} from "./interaction-continuation-outbox.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describe("continuationPolicyWakesOnResolution", () => {
  it("never wakes for the none policy", () => {
    for (const status of ["accepted", "answered", "rejected", "cancelled"]) {
      expect(continuationPolicyWakesOnResolution("none", status)).toBe(false);
    }
  });

  it("wakes on any resolution for wake_assignee", () => {
    for (const status of ["accepted", "answered", "rejected", "cancelled"]) {
      expect(continuationPolicyWakesOnResolution("wake_assignee", status)).toBe(true);
    }
  });

  it("wakes only on the positive resolution for wake_assignee_on_accept", () => {
    expect(continuationPolicyWakesOnResolution("wake_assignee_on_accept", "accepted")).toBe(true);
    expect(continuationPolicyWakesOnResolution("wake_assignee_on_accept", "answered")).toBe(true);
    expect(continuationPolicyWakesOnResolution("wake_assignee_on_accept", "rejected")).toBe(false);
    expect(continuationPolicyWakesOnResolution("wake_assignee_on_accept", "cancelled")).toBe(false);
  });
});

describe("interactionContinuationOutboxMutationOptions", () => {
  const issue = { id: "issue-a", companyId: "company-a", assigneeAgentId: "agent-a" };
  const interaction = {
    id: "interaction-a",
    kind: "request_confirmation",
    status: "accepted",
    continuationPolicy: "wake_assignee",
    sourceCommentId: "comment-a",
    sourceRunId: "run-a",
  };

  function fakeTransaction() {
    const inserted: Array<Record<string, unknown>> = [];
    const tx = {
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          inserted.push(values);
          return { onConflictDoNothing: async () => undefined };
        },
      }),
    };
    return { tx, inserted };
  }

  it("writes the intent with the canonical wake contract inside the transaction", async () => {
    const options = interactionContinuationOutboxMutationOptions({ issue, interaction });
    expect(options.afterResolveInTransaction).toBeTypeOf("function");
    const { tx, inserted } = fakeTransaction();
    await options.afterResolveInTransaction!(tx as never, { id: "interaction-a", status: "accepted" });

    expect(inserted).toHaveLength(1);
    const row = inserted[0] as {
      companyId: string;
      agentId: string;
      status: string;
      idempotencyKey: string;
      requestedByActorType: string;
      payload: { interactionContinuationOutbox: Record<string, unknown> };
    };
    expect(row.companyId).toBe("company-a");
    expect(row.agentId).toBe("agent-a");
    expect(row.status).toBe("queued");
    expect(row.requestedByActorType).toBe("system");
    expect(row.idempotencyKey).toBe(interactionContinuationOutboxKey("interaction-a", "accepted"));
    const contract = row.payload.interactionContinuationOutbox as {
      wakeIdempotencyKey: string;
      allowRunCoalescing: boolean;
      payload: Record<string, unknown>;
      contextSnapshot: Record<string, unknown>;
    };
    expect(contract.wakeIdempotencyKey).toBe("interaction:interaction-a:accepted");
    expect(contract.allowRunCoalescing).toBe(true);
    expect(contract.payload).toMatchObject({
      issueId: "issue-a",
      interactionId: "interaction-a",
      interactionKind: "request_confirmation",
      interactionStatus: "accepted",
      sourceCommentId: "comment-a",
      sourceRunId: "run-a",
      mutation: "interaction",
    });
    expect(contract.contextSnapshot).toMatchObject({
      issueId: "issue-a",
      taskId: "issue-a",
      wakeReason: "issue_commented",
      source: "issue.interaction.resolve",
    });
  });

  it("uses the caller's canonical wake key when one is given", async () => {
    const options = interactionContinuationOutboxMutationOptions({
      issue,
      interaction,
      idempotencyKey: "custom-key",
    });
    const { tx, inserted } = fakeTransaction();
    await options.afterResolveInTransaction!(tx as never, { id: "interaction-a", status: "accepted" });
    const payload = (inserted[0] as { payload: { interactionContinuationOutbox: { wakeIdempotencyKey: string } } }).payload;
    expect(payload.interactionContinuationOutbox.wakeIdempotencyKey).toBe("custom-key");
  });

  it("returns no hook when the card asked for no continuation", () => {
    expect(
      interactionContinuationOutboxMutationOptions({
        issue,
        interaction: { ...interaction, continuationPolicy: "none" },
      }).afterResolveInTransaction,
    ).toBeUndefined();
  });

  it("returns no hook when an accept-only policy is resolved negatively", () => {
    expect(
      interactionContinuationOutboxMutationOptions({
        issue,
        interaction: { ...interaction, continuationPolicy: "wake_assignee_on_accept", status: "rejected" },
      }).afterResolveInTransaction,
    ).toBeUndefined();
  });

  it("returns no hook when the issue has no assignee", () => {
    expect(
      interactionContinuationOutboxMutationOptions({
        issue: { ...issue, assigneeAgentId: null },
        interaction,
      }).afterResolveInTransaction,
    ).toBeUndefined();
  });
});

// The wake used to be fire-and-forget after the accept transaction and got
// lost when its admission failed. The outbox must keep the intent across a
// simulated enqueue failure and materialize the wake on retry.
describeEmbeddedPostgres("interaction continuation outbox", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-interaction-outbox-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(agentWakeupRequests);
    await db.delete(issueThreadInteractions);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    if (tempDb) await tempDb.cleanup();
  });

  async function seed(input: {
    interactionStatus?: string;
    continuationPolicy?: "none" | "wake_assignee" | "wake_assignee_on_accept";
    issueStatus?: string;
    assigneeAgentId?: string | null;
  } = {}) {
    const [company] = await db.insert(companies).values({ name: "Company A" }).returning();
    const [agent] = await db
      .insert(agents)
      .values({ companyId: company!.id, name: "agent-a", adapterType: "claude" })
      .returning();
    const [issue] = await db
      .insert(issues)
      .values({
        companyId: company!.id,
        identifier: "OBX-1",
        title: "Outbox wake",
        status: input.issueStatus ?? "in_progress",
        assigneeAgentId: input.assigneeAgentId === undefined ? agent!.id : input.assigneeAgentId,
      })
      .returning();
    const [interaction] = await db
      .insert(issueThreadInteractions)
      .values({
        companyId: company!.id,
        issueId: issue!.id,
        kind: "request_confirmation",
        status: input.interactionStatus ?? "accepted",
        continuationPolicy: input.continuationPolicy ?? "wake_assignee",
        payload: { version: 1, prompt: "Proceed?" },
        createdByAgentId: agent!.id,
      })
      .returning();
    return { company: company!, agent: agent!, issue: issue!, interaction: interaction! };
  }

  type Seeded = Awaited<ReturnType<typeof seed>>;

  async function recordIntent(seeded: Seeded) {
    const { company, agent, issue, interaction } = seeded;
    await db.transaction(async (tx) => {
      await recordInteractionContinuationOutbox(tx as never, {
        companyId: company.id,
        agentId: agent.id,
        interactionId: interaction.id,
        interactionStatus: "accepted",
        reason: "issue_commented",
        contract: {
          wakeIdempotencyKey: `interaction:${interaction.id}:accepted`,
          allowRunCoalescing: true,
          payload: {
            issueId: issue.id,
            interactionId: interaction.id,
            interactionKind: "request_confirmation",
            interactionStatus: "accepted",
            mutation: "interaction",
          },
          contextSnapshot: {
            issueId: issue.id,
            taskId: issue.id,
            interactionId: interaction.id,
            wakeReason: "issue_commented",
            source: "issue.interaction.resolve",
          },
        },
      });
    });
  }

  async function readIntent(seeded: Seeded) {
    const [intent] = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, seeded.company.id),
          eq(
            agentWakeupRequests.idempotencyKey,
            interactionContinuationOutboxKey(seeded.interaction.id, "accepted"),
          ),
        ),
      );
    return intent;
  }

  // Emulates the durable wake row the real enqueueWakeup would write.
  function healthyHeartbeat(seeded: Seeded, runId: string | null = null) {
    return {
      wakeup: vi.fn(async (agentId: string, opts: { idempotencyKey?: string | null }) => {
        await db.insert(agentWakeupRequests).values({
          companyId: seeded.company.id,
          agentId,
          source: "automation",
          triggerDetail: "system",
          reason: "issue_commented",
          status: "queued",
          idempotencyKey: opts.idempotencyKey ?? null,
          runId,
        });
        return runId ? { id: runId } : null;
      }),
    };
  }

  it("keeps the intent when the direct wake enqueue fails, then materializes the wake on retry", async () => {
    const seeded = await seed();
    const { company, agent, interaction } = seeded;
    // 1. The accept transaction persists the intent atomically.
    await recordIntent(seeded);

    // 2. The post-commit dispatch dies: the enqueue transaction never lands.
    const failingHeartbeat = {
      wakeup: vi.fn(async () => {
        throw new Error("admission lock contention");
      }),
    };
    await interactionContinuationOutboxService(db, failingHeartbeat).tryDeliver(
      interaction.id,
      "accepted",
    );
    expect(failingHeartbeat.wakeup).toHaveBeenCalledTimes(1);
    // The intent row is still there, released and due for the sweep.
    const afterFailure = await readIntent(seeded);
    expect(afterFailure?.status).toBe("queued");
    expect(afterFailure?.claimedAt).toBeNull();

    // 3. The sweep (a later scheduler pass with a healthy heartbeat)
    //    materializes the durable wake with the canonical key.
    const canonical = `interaction:${interaction.id}:accepted`;
    const emulatedRunId = "11111111-2222-4333-8444-555555555555";
    const heartbeat = healthyHeartbeat(seeded, emulatedRunId);
    const outbox = interactionContinuationOutboxService(db, heartbeat);
    const result = await outbox.sweepPending();
    expect(result.scanned).toBe(1);
    expect(heartbeat.wakeup).toHaveBeenCalledTimes(1);
    expect(heartbeat.wakeup.mock.calls[0]?.[0]).toBe(agent.id);
    expect(heartbeat.wakeup.mock.calls[0]?.[1]).toMatchObject({
      reason: "issue_commented",
      idempotencyKey: canonical,
      allowRunCoalescing: true,
      payload: { interactionId: interaction.id, mutation: "interaction" },
      contextSnapshot: { wakeReason: "issue_commented", source: "issue.interaction.resolve" },
    });

    // 4. The canonical wake row exists; the intent is retired as coalesced.
    const [durable] = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, company.id),
          eq(agentWakeupRequests.idempotencyKey, canonical),
        ),
      );
    expect(durable?.agentId).toBe(agent.id);
    const retired = await readIntent(seeded);
    expect(retired?.status).toBe("coalesced");
    expect(retired?.runId).toBe(emulatedRunId);

    // 5. Idempotency: a second sweep does not wake again.
    const second = await outbox.sweepPending();
    expect(second.scanned).toBe(0);
    expect(heartbeat.wakeup).toHaveBeenCalledTimes(1);
  });

  it("does not persist the intent when the resolution transaction rolls back", async () => {
    const seeded = await seed();
    await expect(
      db.transaction(async (tx) => {
        await recordInteractionContinuationOutbox(tx as never, {
          companyId: seeded.company.id,
          agentId: seeded.agent.id,
          interactionId: seeded.interaction.id,
          interactionStatus: "accepted",
          reason: "issue_commented",
          contract: {
            wakeIdempotencyKey: `interaction:${seeded.interaction.id}:accepted`,
            allowRunCoalescing: true,
            payload: { issueId: seeded.issue.id },
            contextSnapshot: { issueId: seeded.issue.id },
          },
        });
        throw new Error("verdict write failed");
      }),
    ).rejects.toThrow("verdict write failed");
    expect(await readIntent(seeded)).toBeUndefined();
  });

  it("retires the intent when the issue went terminal before delivery", async () => {
    const seeded = await seed({ issueStatus: "done" });
    await recordIntent(seeded);
    const heartbeat = { wakeup: vi.fn(async () => null) };
    await interactionContinuationOutboxService(db, heartbeat).tryDeliver(
      seeded.interaction.id,
      "accepted",
    );
    expect(heartbeat.wakeup).not.toHaveBeenCalled();
    const intent = await readIntent(seeded);
    expect(intent?.status).toBe("skipped");
    expect(intent?.error).toBe("interaction_continuation_outbox_target_terminal");
  });

  it("retires the intent when the card asks for no continuation", async () => {
    const seeded = await seed({ continuationPolicy: "none" });
    await recordIntent(seeded);
    const heartbeat = { wakeup: vi.fn(async () => null) };
    const outbox = interactionContinuationOutboxService(db, heartbeat);
    const result = await outbox.sweepPending();
    expect(result.scanned).toBe(1);
    expect(heartbeat.wakeup).not.toHaveBeenCalled();
    const intent = await readIntent(seeded);
    expect(intent?.status).toBe("skipped");
    expect(intent?.error).toBe("interaction_continuation_outbox_policy_no_wake");
  });

  it("retires the intent when the assignee changed after the intent was written", async () => {
    const seeded = await seed();
    await recordIntent(seeded);
    const [other] = await db
      .insert(agents)
      .values({ companyId: seeded.company.id, name: "agent-b", adapterType: "claude" })
      .returning();
    await db.update(issues).set({ assigneeAgentId: other!.id }).where(eq(issues.id, seeded.issue.id));
    const heartbeat = { wakeup: vi.fn(async () => null) };
    await interactionContinuationOutboxService(db, heartbeat).tryDeliver(
      seeded.interaction.id,
      "accepted",
    );
    expect(heartbeat.wakeup).not.toHaveBeenCalled();
    const intent = await readIntent(seeded);
    expect(intent?.status).toBe("skipped");
    expect(intent?.error).toBe("interaction_continuation_outbox_assignee_changed");
  });

  it("never dispatches an intent whose claim lease is still fresh", async () => {
    const seeded = await seed();
    await recordIntent(seeded);
    const intent = await readIntent(seeded);
    await db
      .update(agentWakeupRequests)
      .set({ status: "claimed", claimedAt: new Date() })
      .where(eq(agentWakeupRequests.id, intent!.id));
    const heartbeat = healthyHeartbeat(seeded, "22222222-3333-4444-8555-666666666666");
    const outbox = interactionContinuationOutboxService(db, heartbeat);

    await outbox.tryDeliver(seeded.interaction.id, "accepted");
    expect((await outbox.sweepPending()).scanned).toBe(0);
    expect(heartbeat.wakeup).not.toHaveBeenCalled();

    // A crashed worker's lease goes stale and the sweep takes the intent over.
    await db
      .update(agentWakeupRequests)
      .set({ claimedAt: new Date(Date.now() - 5 * 60_000) })
      .where(eq(agentWakeupRequests.id, intent!.id));
    expect((await outbox.sweepPending()).scanned).toBe(1);
    expect(heartbeat.wakeup).toHaveBeenCalledTimes(1);
    expect((await readIntent(seeded))?.status).toBe("coalesced");
  });

  it("releases the claim and retries while the wake is refused, then expires the intent", async () => {
    const seeded = await seed();
    await recordIntent(seeded);
    // wakeup() admits nothing durable: returns null without writing a row.
    const heartbeat = { wakeup: vi.fn(async () => null) };
    const outbox = interactionContinuationOutboxService(db, heartbeat);

    await outbox.tryDeliver(seeded.interaction.id, "accepted");
    const released = await readIntent(seeded);
    expect(released?.status).toBe("queued");
    expect(released?.claimedAt).toBeNull();
    await outbox.sweepPending();
    expect(heartbeat.wakeup).toHaveBeenCalledTimes(2);

    // Past the retry window the intent is retired instead of retried forever.
    await db
      .update(agentWakeupRequests)
      .set({ requestedAt: new Date(Date.now() - 20 * 60_000) })
      .where(eq(agentWakeupRequests.id, released!.id));
    await outbox.sweepPending();
    expect(heartbeat.wakeup).toHaveBeenCalledTimes(2);
    const expired = await readIntent(seeded);
    expect(expired?.status).toBe("skipped");
    expect(expired?.error).toBe("interaction_continuation_outbox_expired");
    expect((await outbox.sweepPending()).scanned).toBe(0);
  });

  it("coalesces onto a wake the direct path already made durable", async () => {
    const seeded = await seed();
    await recordIntent(seeded);
    const runId = "33333333-4444-4555-8666-777777777777";
    await db.insert(agentWakeupRequests).values({
      companyId: seeded.company.id,
      agentId: seeded.agent.id,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      status: "queued",
      idempotencyKey: `interaction:${seeded.interaction.id}:accepted`,
      runId,
    });
    const heartbeat = { wakeup: vi.fn(async () => null) };
    await interactionContinuationOutboxService(db, heartbeat).tryDeliver(
      seeded.interaction.id,
      "accepted",
    );
    expect(heartbeat.wakeup).not.toHaveBeenCalled();
    const intent = await readIntent(seeded);
    expect(intent?.status).toBe("coalesced");
    expect(intent?.runId).toBe(runId);
  });
});
