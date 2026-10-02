// myrmidon(CHAT-FIRST, OPE-3638): the bot owner's external-chat turn never
// waits behind the bot-container reconciler's profile-update window.
//
// Defect (operator, 16:21 UTC 02.10): a per-agent profile window in state
// `entering` holds every queued run of the agent (the admission gate blocks
// all wakes), so the owner's Telegram message parked in the queue until the
// window's drain finished — minutes — and the current background run
// (watchdog) was not interrupted either.
//
// Guard cases below. On the previous revision each fails: the queued-run
// start path returns [] for ANY agent under maintenance, so the chat run
// stays queued; the reconciler also waits the whole drain out.

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  instanceSettings,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { heartbeatService } from "../../services/heartbeat.js";
import {
  BOT_PROFILE_WINDOW_REASON_PREFIX,
  newWindow,
  type MaintenanceWindow,
} from "./domain.js";
import { isChatWakeExemptFromBotProfileWindow } from "./gate.js";
import { resetMaintenanceGateCaches } from "./gate.js";
import { mutateMaintenanceDocument } from "./store.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function botWindow(overrides: Partial<MaintenanceWindow> = {}): MaintenanceWindow {
  return {
    ...newWindow({
      id: randomUUID(),
      scope: { type: "agent", id: "agent-a" },
      companyId: "company-a",
      reason: "bot container profile update (agent-a)",
      drainTimeoutSec: 300,
      onTimeout: "interrupt_and_retry",
      startedBy: null,
      now: new Date(),
    }),
    ...overrides,
  };
}

describe("chat-first: the gate exemption", () => {
  const userChat = { contextSource: "chat:telegram", requestedByActorType: "user" };

  it("admits a user chat wake through an entering bot-profile window", () => {
    expect(isChatWakeExemptFromBotProfileWindow([botWindow()], userChat)).toBe(true);
  });

  it("rejects every other provenance and window shape", () => {
    const window = botWindow();
    // Not a chat source.
    expect(isChatWakeExemptFromBotProfileWindow([window], { ...userChat, contextSource: "issue.comment" })).toBe(false);
    expect(isChatWakeExemptFromBotProfileWindow([window], { ...userChat, contextSource: null })).toBe(false);
    // A system/automation wake is not the owner's message.
    expect(isChatWakeExemptFromBotProfileWindow([window], { ...userChat, requestedByActorType: "system" })).toBe(false);
    expect(isChatWakeExemptFromBotProfileWindow([window], { ...userChat, requestedByActorType: null })).toBe(false);
    // Past the drain (state `on`) the container is being changed: no admission.
    expect(isChatWakeExemptFromBotProfileWindow([botWindow({ state: "on" })], userChat)).toBe(false);
    // A window someone else opened (deploy, operator) still blocks.
    expect(
      isChatWakeExemptFromBotProfileWindow([botWindow({ reason: "deploy" })], userChat),
    ).toBe(false);
    expect(
      isChatWakeExemptFromBotProfileWindow([botWindow({ scope: { type: "instance" } })], userChat),
    ).toBe(false);
    // Two windows (a profile window plus another) is not the single-window case.
    expect(isChatWakeExemptFromBotProfileWindow([botWindow(), botWindow()], userChat)).toBe(false);
  });

  it("recognizes every chat provider source, including recovery replays", () => {
    for (const source of ["chat:slack", "chat:discord", "chat:github", "chat:microsoft-teams", "chat:telegram:recovery", "chat:agentmail"]) {
      expect(isChatWakeExemptFromBotProfileWindow([botWindow()], { contextSource: source, requestedByActorType: "user" })).toBe(true);
    }
  });

  it("the reason prefix matches the reconciler's window reasons", () => {
    for (const reason of [
      `bot container profile update (${randomUUID()})`,
      `bot container template update (${randomUUID()})`,
      `bot container health recovery (${randomUUID()})`,
    ]) {
      expect(reason.startsWith(BOT_PROFILE_WINDOW_REASON_PREFIX)).toBe(true);
    }
    expect("operator maintenance".startsWith(BOT_PROFILE_WINDOW_REASON_PREFIX)).toBe(false);
  });
});

describeEmbeddedPostgres("chat-first: the queued-run start path", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-maintenance-chat-first-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await heartbeatService(db).drainActiveRunExecutions();
    // FK-safe order (mirrors interrupt.test.ts): issues first, then activity
    // and run events, detach retry chains, then runs, then wakeups.
    await db.delete(issues);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(activityLog);
      await db.delete(heartbeatRunEvents);
      await db.update(heartbeatRuns).set({ retryOfRunId: null });
      try {
        await db.delete(heartbeatRuns);
        break;
      } catch {
        if (attempt === 4) throw new Error("could not delete heartbeat runs");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(companySkills);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
    resetMaintenanceGateCaches();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  /** A bot-container profile window for one agent, in state `entering`. */
  async function openBotProfileWindow(agentId: string, state: "entering" | "on" = "entering") {
    await mutateMaintenanceDocument(db, (doc) => ({
      next: {
        ...doc,
        windows: [
          ...doc.windows,
          {
            ...newWindow({
              id: randomUUID(),
              scope: { type: "agent", id: agentId },
              companyId: null,
              reason: `bot container profile update (${agentId})`,
              drainTimeoutSec: 300,
              onTimeout: "interrupt_and_retry",
              startedBy: null,
              now: new Date(),
            }),
            state,
          },
        ],
      },
      result: null,
    }));
    resetMaintenanceGateCaches();
  }

  async function seedAgent(companyId: string, script = "setTimeout(() => process.exit(0), 20000)") {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `agent-${agentId.slice(0, 6)}`,
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", script] },
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true } },
      permissions: {},
    });
    return agentId;
  }

  /** A queued run shaped like a chat turn: chat context source, user actor. */
  async function seedQueuedRun(
    companyId: string,
    agentId: string,
    provenance: { source: string | null; actorType: "user" | "system" | null },
  ) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "owner chat",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "user-a",
    });
    const [wakeup] = await db
      .insert(agentWakeupRequests)
      .values({
        companyId,
        agentId,
        source: "assignment",
        triggerDetail: "system",
        reason: "External chat message received",
        status: "queued",
        requestedByActorType: provenance.actorType,
        requestedByActorId: provenance.actorType === "user" ? "user-a" : null,
      })
      .returning();
    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: wakeup!.id,
        contextSnapshot: {
          issueId,
          source: provenance.source,
          wakeReason: "External chat message received",
        },
      })
      .returning();
    return run!;
  }

  async function runStatus(runId: string) {
    return (await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]?.status;
  }

  it(
    "the owner's chat turn starts inside an entering bot-profile window (≤10s)",
    async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      await openBotProfileWindow(agentId);
      const chatRun = await seedQueuedRun(companyId, agentId, { source: "chat:telegram", actorType: "user" });

      const heartbeat = heartbeatService(db);
      const startedAt = Date.now();
      await heartbeat.resumeQueuedRuns();
      // The admission path must not park the owner: the run claims and starts.
      await vi.waitFor(
        async () => {
          expect(await runStatus(chatRun.id)).toBe("running");
        },
        { timeout: 10_000, interval: 100 },
      );
      expect(Date.now() - startedAt).toBeLessThanOrEqual(10_000);
      await heartbeatService(db).drainActiveRunExecutions();
    },
    30_000,
  );

  it(
    "a system wake still waits: the exemption is the owner's message alone",
    async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      await openBotProfileWindow(agentId);
      const systemRun = await seedQueuedRun(companyId, agentId, { source: "chat:telegram", actorType: "system" });
      const boardRun = await seedQueuedRun(companyId, agentId, { source: "issue.comment", actorType: "user" });

      await heartbeatService(db).resumeQueuedRuns();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(await runStatus(systemRun.id)).toBe("queued");
      expect(await runStatus(boardRun.id)).toBe("queued");
    },
    30_000,
  );

  it(
    "nothing is admitted when the window is past the drain (state `on`)",
    async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      await openBotProfileWindow(agentId, "on");
      const chatRun = await seedQueuedRun(companyId, agentId, { source: "chat:telegram", actorType: "user" });

      await heartbeatService(db).resumeQueuedRuns();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(await runStatus(chatRun.id)).toBe("queued");
    },
    30_000,
  );

  it(
    "a deploy window (not bot-container) still blocks the owner's chat turn",
    async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      await mutateMaintenanceDocument(db, (doc) => ({
        next: {
          ...doc,
          windows: [
            ...doc.windows,
            {
              ...newWindow({
                id: randomUUID(),
                scope: { type: "agent", id: agentId },
                companyId: null,
                reason: "deploy maintenance",
                drainTimeoutSec: 300,
                onTimeout: "interrupt_and_retry",
                startedBy: null,
                now: new Date(),
              }),
              state: "entering",
            },
          ],
        },
        result: null,
      }));
      resetMaintenanceGateCaches();
      const chatRun = await seedQueuedRun(companyId, agentId, { source: "chat:telegram", actorType: "user" });

      await heartbeatService(db).resumeQueuedRuns();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(await runStatus(chatRun.id)).toBe("queued");
    },
    30_000,
  );
});
