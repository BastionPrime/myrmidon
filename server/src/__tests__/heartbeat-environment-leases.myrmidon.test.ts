import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  environmentLeases,
  environments,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: vi.fn(function child() {
      return this;
    }),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
  httpLogger: vi.fn(),
}));

// Observe the lease state at the moment the issue execution is released and queued wakes promote.
const promotionProbe = vi.hoisted(() => ({
  onRelease: null as null | ((runId: string) => Promise<void>),
}));
vi.mock("../modules/wake-queue/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../modules/wake-queue/index.js")>();
  return {
    ...actual,
    createWakeQueue: (...args: Parameters<typeof actual.createWakeQueue>) => {
      const queue = actual.createWakeQueue(...args);
      const releaseIssueExecution = queue.releaseIssueExecution.bind(queue);
      queue.releaseIssueExecution = async (input) => {
        await promotionProbe.onRelease?.(input.runId);
        return releaseIssueExecution(input);
      };
      return queue;
    },
  };
});

import { logger } from "../middleware/logger.ts";
import { heartbeatService, type HeartbeatEnvironmentRuntime } from "../services/heartbeat.ts";

// P1: cancel and pause release environment leases; stale active leases are swept.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const MINUTE = 60 * 1000;
// A process id that cannot exist on Linux (above pid_max), so it always reads as dead.
const DEAD_PID = 4_194_304 + 7;

type Heartbeat = ReturnType<typeof heartbeatService> & {
  sweepStaleActiveEnvironmentLeases?: (opts?: { graceMs?: number; now?: Date }) => Promise<{
    inspected: number;
    released: number;
    skippedAlive: number;
    failed: number;
  }>;
};

describeEmbeddedPostgres("environment leases on cancel, pause and sweep (P1)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousGrace = process.env.MYRMIDON_STALE_LEASE_GRACE_MS;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-myrmidon-leases-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  const leaseStatusAtPromotion: Array<{ runId: string; statuses: string[] }> = [];

  beforeEach(() => {
    vi.mocked(logger.warn).mockClear();
    leaseStatusAtPromotion.length = 0;
    promotionProbe.onRelease = async (runId) => {
      const rows = await db
        .select({ status: environmentLeases.status })
        .from(environmentLeases)
        .where(eq(environmentLeases.heartbeatRunId, runId));
      leaseStatusAtPromotion.push({ runId, statuses: rows.map((row) => row.status) });
    };
  });

  afterEach(async () => {
    if (previousGrace === undefined) delete process.env.MYRMIDON_STALE_LEASE_GRACE_MS;
    else process.env.MYRMIDON_STALE_LEASE_GRACE_MS = previousGrace;
    await db.delete(environmentLeases);
    await db.delete(environments);
    await db.update(issues).set({ executionRunId: null, checkoutRunId: null });
    await db.delete(heartbeatRunEvents);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const environmentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "agent-a",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(environments).values({
      id: environmentId,
      name: "sandbox-a",
      driver: "sandbox",
      status: "active",
      config: { provider: "fake" },
    });
    return { companyId, agentId, environmentId };
  }

  async function seedRun(input: {
    companyId: string;
    agentId: string;
    status: string;
    finishedAt?: Date | null;
    processPid?: number | null;
    withIssue?: boolean;
  }) {
    const runId = randomUUID();
    const issueId = input.withIssue ? randomUUID() : null;
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      status: input.status,
      invocationSource: "manual",
      startedAt: new Date(),
      finishedAt: input.finishedAt ?? null,
      processPid: input.processPid ?? null,
      contextSnapshot: issueId ? { issueId } : {},
    });
    if (issueId) {
      await db.insert(issues).values({
        id: issueId,
        companyId: input.companyId,
        title: "Task with a lease",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: input.agentId,
        executionRunId: runId,
      });
    }
    return { runId, issueId };
  }

  async function seedActiveLease(input: {
    companyId: string;
    environmentId: string;
    runId: string;
    provider: string | null;
    updatedAt?: Date;
  }) {
    const id = randomUUID();
    const at = input.updatedAt ?? new Date();
    await db.insert(environmentLeases).values({
      id,
      companyId: input.companyId,
      environmentId: input.environmentId,
      heartbeatRunId: input.runId,
      status: "active",
      leasePolicy: "ephemeral",
      provider: input.provider,
      providerLeaseId: input.provider ? `sandbox://${input.provider}/${id}` : null,
      metadata: { driver: input.provider && input.provider !== "local" ? "sandbox" : "local" },
      acquiredAt: at,
      lastUsedAt: at,
      createdAt: at,
      updatedAt: at,
    });
    return id;
  }

  async function leaseRow(id: string) {
    return db
      .select()
      .from(environmentLeases)
      .where(eq(environmentLeases.id, id))
      .then((rows) => rows[0]!);
  }

  /**
   * Runtime fake. releaseRunLeases marks the run's active leases released and
   * records whether the issue still pointed at the run at that moment.
   */
  function fakeRuntime(opts: { teardownFails?: boolean } = {}) {
    const releaseCalls: string[] = [];
    const teardownCalls: string[] = [];
    const runtime = {
      releaseRunLeases: vi.fn(async (runId: string, status: "released" | "expired" | "failed") => {
        releaseCalls.push(runId);
        await db
          .update(environmentLeases)
          .set({ status, releasedAt: new Date(), updatedAt: new Date() })
          .where(eq(environmentLeases.heartbeatRunId, runId));
        return [];
      }),
      retryPendingSandboxTeardown: vi.fn(async ({ lease }: { lease: { id: string; providerLeaseId: string | null } }) => {
        teardownCalls.push(lease.id);
        if (opts.teardownFails) throw new Error("provider token sk-example leaked in message");
        return { providerLeaseId: lease.providerLeaseId, state: "destroyed" };
      }),
    };
    return {
      runtime: runtime as unknown as HeartbeatEnvironmentRuntime,
      releaseCalls,
      teardownCalls,
    };
  }

  it("cancelRun releases the run's environment lease before the issue execution is released", async () => {
    const { companyId, agentId, environmentId } = await seedAgent();
    const { runId, issueId } = await seedRun({ companyId, agentId, status: "queued", withIssue: true });
    const leaseId = await seedActiveLease({ companyId, environmentId, runId, provider: "local" });
    const fake = fakeRuntime();
    const heartbeat = heartbeatService(db, { environmentRuntime: fake.runtime });

    await heartbeat.cancelRun(runId, "Cancelled by board");

    expect(fake.releaseCalls).toEqual([runId]);
    expect((await leaseRow(leaseId)).status).not.toBe("active");
    // Queued wakes for the issue are promoted only after the lease is gone.
    expect(leaseStatusAtPromotion).toEqual([{ runId, statuses: [expect.not.stringMatching(/^active$/)] }]);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId!));
    expect(issue?.executionRunId).toBeNull();
  });

  it("pausing an agent releases the environment lease of its cancelled run", async () => {
    const { companyId, agentId, environmentId } = await seedAgent();
    const { runId } = await seedRun({ companyId, agentId, status: "queued", withIssue: true });
    const leaseId = await seedActiveLease({ companyId, environmentId, runId, provider: "local" });
    const fake = fakeRuntime();
    const heartbeat = heartbeatService(db, { environmentRuntime: fake.runtime });

    await heartbeat.cancelActiveForAgent(agentId, "Agent paused");

    expect(fake.releaseCalls).toEqual([runId]);
    expect(leaseStatusAtPromotion).toEqual([{ runId, statuses: [expect.not.stringMatching(/^active$/)] }]);
    expect((await leaseRow(leaseId)).status).not.toBe("active");
  });

  describe("stale active lease sweep", () => {
    it("tears down and expires an active lease on a long-finished run with a dead process", async () => {
      const { companyId, agentId, environmentId } = await seedAgent();
      const { runId } = await seedRun({
        companyId,
        agentId,
        status: "cancelled",
        finishedAt: new Date(Date.now() - 90 * MINUTE),
        processPid: DEAD_PID,
      });
      const leaseId = await seedActiveLease({ companyId, environmentId, runId, provider: "fake" });
      const fake = fakeRuntime();
      const heartbeat = heartbeatService(db, { environmentRuntime: fake.runtime }) as Heartbeat;

      const result = await heartbeat.sweepStaleActiveEnvironmentLeases!();

      expect(result).toEqual({ inspected: 1, released: 1, skippedAlive: 0, failed: 0 });
      expect(fake.teardownCalls).toEqual([leaseId]);
      const lease = await leaseRow(leaseId);
      expect(lease.status).toBe("expired");
      expect(lease.failureReason).toBe("stale_active_lease_sweep");
      expect(lease.cleanupStatus).toBe("success");
    });

    it("leaves a lease alone inside the grace window (default 10 minutes)", async () => {
      const { companyId, agentId, environmentId } = await seedAgent();
      const { runId } = await seedRun({
        companyId,
        agentId,
        status: "failed",
        finishedAt: new Date(Date.now() - 5 * MINUTE),
      });
      const leaseId = await seedActiveLease({ companyId, environmentId, runId, provider: "fake" });
      const heartbeat = heartbeatService(db, { environmentRuntime: fakeRuntime().runtime }) as Heartbeat;

      const result = await heartbeat.sweepStaleActiveEnvironmentLeases!();

      expect(result.inspected).toBe(0);
      expect((await leaseRow(leaseId)).status).toBe("active");
    });

    it("reads the grace window from MYRMIDON_STALE_LEASE_GRACE_MS", async () => {
      const { companyId, agentId, environmentId } = await seedAgent();
      const { runId } = await seedRun({
        companyId,
        agentId,
        status: "failed",
        finishedAt: new Date(Date.now() - 5 * MINUTE),
      });
      const leaseId = await seedActiveLease({ companyId, environmentId, runId, provider: "local" });
      process.env.MYRMIDON_STALE_LEASE_GRACE_MS = String(MINUTE);
      const heartbeat = heartbeatService(db, { environmentRuntime: fakeRuntime().runtime }) as Heartbeat;

      const result = await heartbeat.sweepStaleActiveEnvironmentLeases!();

      expect(result.released).toBe(1);
      expect((await leaseRow(leaseId)).status).toBe("expired");
    });

    it("skips a terminal run whose process is still alive", async () => {
      const { companyId, agentId, environmentId } = await seedAgent();
      const { runId } = await seedRun({
        companyId,
        agentId,
        status: "cancelled",
        finishedAt: new Date(Date.now() - 90 * MINUTE),
        processPid: process.pid,
      });
      const leaseId = await seedActiveLease({ companyId, environmentId, runId, provider: "fake" });
      const fake = fakeRuntime();
      const heartbeat = heartbeatService(db, { environmentRuntime: fake.runtime }) as Heartbeat;

      const result = await heartbeat.sweepStaleActiveEnvironmentLeases!();

      expect(result).toMatchObject({ inspected: 1, released: 0, skippedAlive: 1 });
      expect(fake.teardownCalls).toEqual([]);
      expect((await leaseRow(leaseId)).status).toBe("active");
    });

    it("skips a lease whose run is not terminal", async () => {
      const { companyId, agentId, environmentId } = await seedAgent();
      const { runId } = await seedRun({
        companyId,
        agentId,
        status: "running",
        finishedAt: new Date(Date.now() - 90 * MINUTE),
      });
      const leaseId = await seedActiveLease({ companyId, environmentId, runId, provider: "fake" });
      const heartbeat = heartbeatService(db, { environmentRuntime: fakeRuntime().runtime }) as Heartbeat;

      const result = await heartbeat.sweepStaleActiveEnvironmentLeases!();

      expect(result.inspected).toBe(0);
      expect((await leaseRow(leaseId)).status).toBe("active");
    });

    it("releases a local lease without a provider teardown", async () => {
      const { companyId, agentId, environmentId } = await seedAgent();
      const { runId } = await seedRun({
        companyId,
        agentId,
        status: "failed",
        finishedAt: new Date(Date.now() - 60 * MINUTE),
      });
      const leaseId = await seedActiveLease({ companyId, environmentId, runId, provider: "local" });
      const fake = fakeRuntime();
      const heartbeat = heartbeatService(db, { environmentRuntime: fake.runtime }) as Heartbeat;

      const result = await heartbeat.sweepStaleActiveEnvironmentLeases!();

      expect(result.released).toBe(1);
      expect(fake.teardownCalls).toEqual([]);
      expect((await leaseRow(leaseId)).status).toBe("expired");
    });

    it("keeps the lease active when the teardown fails and logs only the error kind", async () => {
      const { companyId, agentId, environmentId } = await seedAgent();
      const { runId } = await seedRun({
        companyId,
        agentId,
        status: "cancelled",
        finishedAt: new Date(Date.now() - 60 * MINUTE),
      });
      const leaseId = await seedActiveLease({ companyId, environmentId, runId, provider: "fake" });
      const fake = fakeRuntime({ teardownFails: true });
      const heartbeat = heartbeatService(db, { environmentRuntime: fake.runtime }) as Heartbeat;

      const result = await heartbeat.sweepStaleActiveEnvironmentLeases!();

      expect(result).toMatchObject({ inspected: 1, released: 0, failed: 1 });
      expect((await leaseRow(leaseId)).status).toBe("active");
      const logged = JSON.stringify(vi.mocked(logger.warn).mock.calls);
      expect(logged).toContain("destroy_failed");
      expect(logged).not.toContain("sk-example");
    });

    it("handles at most 50 leases per tick", async () => {
      const { companyId, agentId, environmentId } = await seedAgent();
      for (let i = 0; i < 55; i += 1) {
        const { runId } = await seedRun({
          companyId,
          agentId,
          status: "failed",
          finishedAt: new Date(Date.now() - 60 * MINUTE),
        });
        await seedActiveLease({ companyId, environmentId, runId, provider: "local" });
      }
      const heartbeat = heartbeatService(db, { environmentRuntime: fakeRuntime().runtime }) as Heartbeat;

      const first = await heartbeat.sweepStaleActiveEnvironmentLeases!();
      const second = await heartbeat.sweepStaleActiveEnvironmentLeases!();

      expect(first.released).toBe(50);
      expect(second.released).toBe(5);
    });

    it("runs from the orphaned-run reaper on every scheduler tick", async () => {
      const { companyId, agentId, environmentId } = await seedAgent();
      const { runId } = await seedRun({
        companyId,
        agentId,
        status: "cancelled",
        finishedAt: new Date(Date.now() - 60 * MINUTE),
      });
      const leaseId = await seedActiveLease({ companyId, environmentId, runId, provider: "local" });
      const heartbeat = heartbeatService(db, { environmentRuntime: fakeRuntime().runtime });

      await heartbeat.reapOrphanedRuns();

      const lease = await leaseRow(leaseId);
      expect(lease.status).toBe("expired");
      expect(lease.failureReason).toBe("stale_active_lease_sweep");
    });
  });
});
