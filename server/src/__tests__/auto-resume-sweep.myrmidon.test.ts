import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

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

import { attentionService } from "../services/attention.js";
import { logActivity } from "../services/activity-log.js";
import {
  AUTO_RESUME_ACTIVITY_ACTION,
  AUTO_RESUME_EXHAUSTED_ACTIVITY_ACTION,
  AUTO_RESUME_INTERVAL_SEC_ENV,
  AUTO_RESUME_METADATA_KEY,
  autoResumeMetrics,
  countAutoResumeExhaustionsSince,
  countAutoResumesSince,
  createAutoResumeSweeper,
  readAutoResumeState,
} from "../myrmidon/auto-resume.js";

// AUTO-RESUME (1.4): the sweep brings an agent left in `error` back with the
// 1/5/15 min backoff and, after the attempt cap, stops and escalates the
// existing `agent_error_alert` card to the operator.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const BASE = Date.parse("2026-10-02T00:00:00.000Z");
const MINUTE = 60_000;

describeEmbeddedPostgres("auto-resume sweep (AUTO-RESUME)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-auto-resume-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(input: {
    status?: string;
    updatedAt?: Date;
    metadata?: Record<string, unknown> | null;
  } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
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
      status: input.status ?? "error",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      errorReason: "gateway 500",
      metadata: input.metadata ?? null,
      ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
    });
    return { companyId, agentId };
  }

  async function agentRow(agentId: string) {
    return (await db.select().from(agents).where(eq(agents.id, agentId)))[0]!;
  }

  async function failAgain(agentId: string, updatedAt: Date) {
    await db.update(agents).set({ status: "error", updatedAt }).where(eq(agents.id, agentId));
  }

  function makeSweeper(deps: {
    resumeWake?: ReturnType<typeof vi.fn>;
    invokable?: boolean;
    maintenance?: boolean;
  } = {}) {
    const resumeWake = deps.resumeWake ?? vi.fn(async () => ({}));
    const sweeper = createAutoResumeSweeper({
      db,
      resumeWake: resumeWake as unknown as (agentId: string) => Promise<unknown>,
      isAgentInvokable: async () => deps.invokable ?? true,
      isAgentUnderMaintenance: async () => deps.maintenance ?? false,
      logActivity: async (input) => {
        await logActivity(db, {
          companyId: input.companyId,
          actorType: input.actorType,
          actorId: input.actorId,
          agentId: input.agentId,
          runId: input.runId,
          action: input.action,
          entityType: input.entityType,
          entityId: input.entityId,
          details: input.details,
        });
      },
      env: { [AUTO_RESUME_INTERVAL_SEC_ENV]: "10" } as NodeJS.ProcessEnv,
    });
    const sweepAt = (offsetMs: number) => {
      // Bypass the per-minute gate so each step is explicit in the test.
      sweeper.resetForTest();
      return sweeper.sweep(new Date(BASE + offsetMs));
    };
    return { sweeper, resumeWake, sweepAt };
  }

  it("resumes an errored agent on the 1/5/15 min backoff, then gives up", async () => {
    const { companyId, agentId } = await seedAgent({ updatedAt: new Date(BASE) });
    const { resumeWake, sweepAt } = makeSweeper();

    // Not due yet: the first step is one minute after the error entry.
    const before = await sweepAt(59_000);
    expect(before.resumed).toBe(0);
    expect(before.agentIds).toEqual([]);
    expect(resumeWake).not.toHaveBeenCalled();
    expect((await agentRow(agentId)).status).toBe("error");

    // First attempt at +1 min: the agent goes idle and the wake chain runs.
    const first = await sweepAt(MINUTE);
    expect(first.resumed).toBe(1);
    expect(first.agentIds).toEqual([agentId]);
    expect(resumeWake).toHaveBeenCalledTimes(1);
    let row = await agentRow(agentId);
    expect(row.status).toBe("idle");
    expect(row.errorReason).toBeNull();
    expect(readAutoResumeState(row.metadata)?.failures).toBe(1);

    // The run fails again: same streak, next step is 5 min after the resume.
    await failAgain(agentId, new Date(BASE + MINUTE));
    const tooSoon = await sweepAt(MINUTE + 4 * MINUTE);
    expect(tooSoon.resumed).toBe(0);
    const second = await sweepAt(MINUTE + 5 * MINUTE);
    expect(second.resumed).toBe(1);
    expect(resumeWake).toHaveBeenCalledTimes(2);

    // Second failure → third attempt 15 min later.
    await failAgain(agentId, new Date(BASE + MINUTE + 5 * MINUTE));
    const thirdAt = MINUTE + 5 * MINUTE + 15 * MINUTE;
    const third = await sweepAt(thirdAt);
    expect(third.resumed).toBe(1);
    expect(resumeWake).toHaveBeenCalledTimes(3);

    // Third failure → the cap is reached: the agent stays in error and the
    // board stops; no fourth resume.
    await failAgain(agentId, new Date(thirdAt));
    const exhausted = await sweepAt(thirdAt + 1_000);
    expect(exhausted.exhausted).toBe(1);
    expect(exhausted.resumed).toBe(0);
    expect(resumeWake).toHaveBeenCalledTimes(3);
    row = await agentRow(agentId);
    expect(row.status).toBe("error");
    expect(readAutoResumeState(row.metadata)?.exhaustedAt).toBeTruthy();

    // Still given up on later ticks.
    const later = await sweepAt(BASE + 24 * 60 * MINUTE);
    expect(later.resumed).toBe(0);
    expect(later.exhausted).toBe(0);
    expect(resumeWake).toHaveBeenCalledTimes(3);

    // Activity log: three resumes and one give-up, and the 24 h metric reads them.
    const since = new Date(0);
    expect(await countAutoResumesSince(db, companyId, since)).toBe(3);
    expect(await countAutoResumeExhaustionsSince(db, companyId, since)).toBe(1);
    expect(await autoResumeMetrics(db, companyId, since)).toEqual({ autoResumes: 3, exhaustions: 1 });

    // The attention card escalates to the operator once the board gave up.
    const feed = await attentionService(db).list(companyId, { userId: "board-user" });
    const card = feed.items.find((item) => item.sourceKind === "agent_error_alert");
    expect(card).toBeTruthy();
    expect(card?.whyNow).toContain("Automatic resume gave up");
    expect(card?.severity).toBe("critical");
    expect(card?.subject.metadata?.autoResumeExhausted).toBe(true);
    expect(card?.subject.metadata?.autoResumeAttempts).toBe(3);
  });

  it("keeps the plain card before the first backoff step", async () => {
    const { companyId } = await seedAgent({ updatedAt: new Date(BASE) });
    const { sweepAt } = makeSweeper();

    // Not due yet: the agent stays in `error`, so the desk still shows the
    // vendor wording until the board gives up.
    const result = await sweepAt(30_000);
    expect(result.resumed).toBe(0);
    const feed = await attentionService(db).list(companyId, { userId: "board-user" });
    const card = feed.items.find((item) => item.sourceKind === "agent_error_alert");
    expect(card).toBeTruthy();
    expect(card?.whyNow).toBe("Agent is in error status and needs operator action or dismissal.");
    expect(card?.severity).toBe("high");
    expect(card?.subject.metadata?.autoResumeExhausted).toBeUndefined();
  });

  it("re-arms after an operator touches the agent following a give-up", async () => {
    const { agentId } = await seedAgent({
      updatedAt: new Date(BASE),
      metadata: {
        [AUTO_RESUME_METADATA_KEY]: {
          failures: 3,
          lastFailureAt: new Date(BASE).toISOString(),
          nextAttemptAt: null,
          exhaustedAt: new Date(BASE + MINUTE).toISOString(),
          lastResumeAt: new Date(BASE).toISOString(),
        },
      },
    });
    const { resumeWake, sweepAt } = makeSweeper();

    // The record changed long after the give-up: a new episode, resume again.
    await failAgain(agentId, new Date(BASE + 60 * MINUTE));
    const result = await sweepAt(61 * MINUTE);
    expect(result.resumed).toBe(1);
    expect(resumeWake).toHaveBeenCalledTimes(1);
    const row = await agentRow(agentId);
    expect(readAutoResumeState(row.metadata)?.failures).toBe(1);
    expect(readAutoResumeState(row.metadata)?.exhaustedAt).toBeNull();
  });

  it("does not resume a non-invokable agent or one under maintenance", async () => {
    await seedAgent({ updatedAt: new Date(BASE) });
    await seedAgent({ updatedAt: new Date(BASE) });
    const resumeWake = vi.fn(async () => ({}));

    const paused = createAutoResumeSweeper({
      db,
      resumeWake: resumeWake as unknown as (agentId: string) => Promise<unknown>,
      isAgentInvokable: async () => false,
      isAgentUnderMaintenance: async () => false,
      env: { [AUTO_RESUME_INTERVAL_SEC_ENV]: "10" } as NodeJS.ProcessEnv,
    });
    paused.resetForTest();
    const pausedResult = await paused.sweep(new Date(BASE + 10 * MINUTE));
    expect(pausedResult.resumed).toBe(0);
    expect(pausedResult.skipped).toBe(2);
    expect(resumeWake).not.toHaveBeenCalled();

    const maintenance = createAutoResumeSweeper({
      db,
      resumeWake: resumeWake as unknown as (agentId: string) => Promise<unknown>,
      isAgentInvokable: async () => true,
      isAgentUnderMaintenance: async () => true,
      env: { [AUTO_RESUME_INTERVAL_SEC_ENV]: "10" } as NodeJS.ProcessEnv,
    });
    maintenance.resetForTest();
    const maintenanceResult = await maintenance.sweep(new Date(BASE + 10 * MINUTE));
    expect(maintenanceResult.resumed).toBe(0);
    expect(maintenanceResult.skipped).toBe(2);
    expect(resumeWake).not.toHaveBeenCalled();
  });

  it("records the automatic action in the activity log", async () => {
    const { companyId } = await seedAgent({ updatedAt: new Date(BASE) });
    const { sweepAt } = makeSweeper();
    await sweepAt(MINUTE);
    const rows = await db.select().from(activityLog);
    expect(rows.map((row) => row.action)).toContain(AUTO_RESUME_ACTIVITY_ACTION);
    expect(rows.some((row) => row.companyId === companyId && row.action === AUTO_RESUME_EXHAUSTED_ACTIVITY_ACTION)).toBe(false);
  });
});