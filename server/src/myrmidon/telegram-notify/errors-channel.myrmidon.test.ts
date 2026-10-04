// myrmidon(1.6-TG-NOTIFY-C): end-to-end coverage of the board errors
// channel on a live test database with a fake Telegram transport: enabling
// settings telegramNotify.errors stages publications to the configured
// chat, the default is silence, severity filters, and the hourly rate
// limit drops (never queues) beyond maxPerHour.
//
// The fixture shape (seedCompany, the fake runtime, fakeTelegramFetch,
// makeThread/makeMessage) is copied and trimmed from the vendor's
// server/src/__tests__/chat-telegram-dm-conversation.myrmidon.test.ts /
// chat-channels.integration.test.ts, which are not edited (conventions §7).
// Neutral ids only.

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray, and } from "drizzle-orm";
import {
  agents,
  authUsers,
  chatConversations,
  chatEndpoints,
  chatPublications,
  companies,
  companyMemberships,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  instanceSettings,
  principalPermissionGrants,
  activityLog,
  companySecrets,
} from "@paperclipai/db";
import type { Thread } from "chat";
import type { AttentionItem } from "@paperclipai/shared";
import {
  chatChannelService,
  type ChatChannelService,
  type ChatChannelServiceOptions,
} from "../../services/chat-channels.js";
import type {
  ChatSdkRuntime,
  CreateChatSdkEndpointRuntimeOptions,
} from "../../services/chat-sdk-runtime.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import {
  ERROR_CHANNEL_PUBLICATION_PREFIX,
  HourlyRateLimiter,
  sweepErrorChannel,
  type ErrorChannelSettings,
} from "./errors.js";
import { readTelegramNotifyErrors, TELEGRAM_NOTIFY_GENERAL_KEY } from "./settings.js";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { attentionService } from "../../services/attention.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe.sequential
  : describe.skip;

const ISSUE_CENTRAL_ERROR: ErrorChannelSettings = {
  enabled: true,
  chatId: "770099",
  topicId: null,
  minSeverity: "error",
  maxPerHour: 10,
};


/**
 * A minimal attention card shaped like the feed projection: only the fields
 * the errors channel reads, with the rest filled to the type's neutral
 * defaults.
 */
function card(input: {
  id: string;
  companyId: string;
  sourceKind: "failed_run" | "agent_error_alert" | "budget_alert";
  severity: "critical" | "high" | "medium" | "low";
  dedupKey: string;
  title: string;
  subjectId: string;
  whyNow: string;
}): AttentionItem {
  return {
    id: input.id,
    companyId: input.companyId,
    sourceKind: input.sourceKind,
    subject: {
      kind: "agent",
      id: input.subjectId,
      companyId: input.companyId,
      title: input.title,
      identifier: null,
      status: null,
      href: null,
    },
    whyNow: input.whyNow,
    decisionVerbs: [],
    inlineResolvable: false,
    entryRule: "test",
    exitRule: "test",
    dedupKey: input.dedupKey,
    dismissalKey: input.dedupKey,
    dismissal: null,
    severity: input.severity,
    rank: 0,
    activityAt: new Date(0).toISOString(),
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    relatedIssue: null,
    project: null,
    workspace: null,
    expiresAt: null,
    ruleKey: null,
    originAgentName: null,
    queues: [],
    shelf: false,
    retentionDays: 30,
    keep: false,
    archivedAt: null,
    retentionVersion: 1,
    decideBy: null,
    decideByAttribution: null,
    snoozedUntil: null,
    detail: null,
    trainingExampleId: null,
  };
}

// ---------------------------------------------------------------------------
// Fakes (trimmed copies — see the file header)
// ---------------------------------------------------------------------------

class FakeEndpointRuntime {
  readonly initialize = vi.fn(async () => undefined);
  readonly posts: Array<{ threadId: string; text: string }> = [];
  readonly shutdown = vi.fn(async () => undefined);

  constructor(
    private readonly options: CreateChatSdkEndpointRuntimeOptions,
  ) {}

  get provider() {
    return this.options.providerConfig.provider;
  }

  async post(threadId: string, message: unknown) {
    const text =
      message && typeof message === "object" && "markdown" in message
        ? String((message as { markdown: unknown }).markdown)
        : typeof message === "string"
          ? message
          : JSON.stringify(message);
    this.posts.push({ threadId, text });
    return { id: `thread-post-${randomUUID()}`, threadId };
  }

  thread(threadId: string) {
    return { post: (message: unknown) => this.post(threadId, message) };
  }
}

class FakeChatSdkRuntime {
  readonly endpoints = new Map<string, FakeEndpointRuntime>();
  readonly configurations = new Map<string, CreateChatSdkEndpointRuntimeOptions>();

  get(endpointId: string) {
    return this.endpoints.get(endpointId) ?? null;
  }

  async replaceEndpoint(options: CreateChatSdkEndpointRuntimeOptions) {
    const endpoint = new FakeEndpointRuntime(options);
    this.endpoints.set(options.endpointId, endpoint);
    this.configurations.set(options.endpointId, options);
    return endpoint;
  }

  async removeEndpoint(endpointId: string) {
    this.endpoints.delete(endpointId);
    return true;
  }

  async shutdown() {
    this.endpoints.clear();
  }
}


function fakeTelegramFetch() {
  return async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/getMe")) {
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            id: 12345,
            username: "myrmidon_test_bot",
            first_name: "Myrmidon Test",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/getWebhookInfo")) {
      return new Response(JSON.stringify({ ok: true, result: { url: "" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (
      url.endsWith("/setWebhook") ||
      url.endsWith("/setMyCommands") ||
      url.endsWith("/deleteWebhook") ||
      url.endsWith("/deleteMyCommands") ||
      url.endsWith("/sendMessage")
    ) {
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { "content-type": "application/json" } as Record<string, string>,
      });
    }
    throw new Error(`Unexpected provider request: ${url}`);
  };
}

function makeThread(input: { channelId: string; isDM?: boolean }) {
  return {
    id: `telegram:${input.channelId}`,
    channelId: input.channelId,
    isDM: input.isDM ?? false,
    channel: { id: input.channelId, name: input.channelId },
  } as unknown as Thread;
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

describeEmbeddedPostgres("telegram-notify errors channel (TG-NOTIFY-C)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const fixtureCompanies = new Set<string>();
  const fixtureServices = new Set<ChatChannelService>();
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `myrmidon-tg-notify-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-tg-notify-errors-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await Promise.all([...fixtureServices].map((service) => service.shutdown()));
    fixtureServices.clear();
    if (fixtureCompanies.size > 0) {
      await db
        .update(chatConversations)
        .set({ state: "completed" })
        .where(inArray(chatConversations.companyId, [...fixtureCompanies]));
      await db.delete(chatPublications).where(inArray(chatPublications.companyId, [...fixtureCompanies]));
      await db.delete(heartbeatRunEvents).where(inArray(heartbeatRunEvents.companyId, [...fixtureCompanies]));
      await db.delete(heartbeatRuns).where(inArray(heartbeatRuns.companyId, [...fixtureCompanies]));
      await db.delete(chatConversations).where(inArray(chatConversations.companyId, [...fixtureCompanies]));
      await db.delete(chatEndpoints).where(inArray(chatEndpoints.companyId, [...fixtureCompanies]));
      await db.delete(issues).where(inArray(issues.companyId, [...fixtureCompanies]));
      await db.delete(agents).where(inArray(agents.companyId, [...fixtureCompanies]));
      await db.delete(principalPermissionGrants).where(inArray(principalPermissionGrants.companyId, [...fixtureCompanies]));
      await db.delete(companyMemberships).where(inArray(companyMemberships.companyId, [...fixtureCompanies]));
      await db.delete(activityLog).where(inArray(activityLog.companyId, [...fixtureCompanies]));
      await db.delete(companySecrets).where(inArray(companySecrets.companyId, [...fixtureCompanies]));
      await db.delete(companies).where(inArray(companies.id, [...fixtureCompanies]));
    }
    fixtureCompanies.clear();
    // Reset the stored settings area between cases so "default" really means absent.
    const stored = await db.select().from(instanceSettings).where(eq(instanceSettings.singletonKey, "default"));
    for (const row of stored) {
      const general = { ...(row.general as Record<string, unknown>) };
      delete general[TELEGRAM_NOTIFY_GENERAL_KEY];
      await db.update(instanceSettings).set({ general }).where(eq(instanceSettings.id, row.id));
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    if (previousKeyFile === undefined)
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function seedCompany() {
    const companyId = randomUUID();
    fixtureCompanies.add(companyId);
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `notify test ${companyId.slice(0, 8)}`,
      issuePrefix: `N${companyId.replaceAll("-", "").slice(0, 7).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db
      .insert(authUsers)
      .values({
        id: "owner-user",
        name: "Owner User",
        email: "owner-user@example.com",
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoNothing();
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "owner-user",
      status: "active",
      membershipRole: "operator",
    });
    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType: "user",
      principalId: "owner-user",
      permissionKey: "tools:manage_connections",
      scope: null,
      grantedByUserId: "owner-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "agent-a",
      role: "engineer",
      status: "error",
      adapterType: "paperclip_runner",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      errorReason: "gateway 500",
    });
    return { companyId, agentId };
  }

  async function configuredTelegramEndpoint(companyId: string, agentId: string, channelId: string) {
    const runtime = new FakeChatSdkRuntime();
    const service = chatChannelService(db, {
      runtime: runtime as unknown as ChatSdkRuntime,
      publicBaseUrl: "https://paperclip.example",
      fetch: fakeTelegramFetch(),
      heartbeat: { cancelRun: async () => ({ status: "cancelled" }), wakeup: async () => ({ accepted: true }) },
    } as unknown as ChatChannelServiceOptions);
    fixtureServices.add(service);
    const endpoint = await service.create(
      companyId,
      { provider: "telegram", assignedAgentId: agentId, name: "agent-a in Telegram" },
      "owner-user",
    );
    await service.configure(
      endpoint.id,
      { action: "configure", credentials: { botToken: "123456:telegram-notify-test" } },
      "owner-user",
    );
    const runtimeEndpoint = runtime.endpoints.get(endpoint.id);
    if (!runtimeEndpoint) throw new Error("fake runtime missing endpoint");
    const thread = makeThread({ channelId, isDM: true });
    return { runtime, service, endpoint, thread, runtimeEndpoint };
  }

  async function seedDmConversation(companyId: string, agentId: string, channelId: string) {
    const { runtime, service, endpoint, thread } = await configuredTelegramEndpoint(companyId, agentId, channelId);
    // The vendor service needs the onMessage callback path to bind a
    // conversation; a direct DB row is enough for the sweep (it only reads
    // chat_conversations), so create the row the same way the vendor does.
    const [issue] = await db
      .insert(issues)
      .values({
        companyId,
        title: "notify binding task",
        status: "in_progress",
        assigneeAgentId: agentId,
        originKind: "chat_channel",
      })
      .returning();
    const [conversation] = await db
      .insert(chatConversations)
      .values({
        companyId,
        endpointId: endpoint.id,
        issueId: issue.id,
        externalConversationId: channelId,
        externalThreadId: "",
        externalLabel: "Telegram direct message",
        isDirectMessage: true,
        state: "active",
      })
      .returning();
    return { runtime, service, endpoint, conversation, thread };
  }

  async function seedFailedRun(companyId: string, agentId: string) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "failed",
      error: "gateway 500 after retries",
      contextSnapshot: { issueId: null },
      finishedAt: new Date(),
    });
    await db.insert(heartbeatRunEvents).values({
      companyId,
      runId,
      agentId,
      seq: 1,
      eventType: "lifecycle",
      message: "Bounded retry exhausted (attempt 3)",
      createdAt: new Date(),
    });
    return runId;
  }

  async function storedSettings(): Promise<ErrorChannelSettings> {
    return readTelegramNotifyErrors(db);
  }

  async function writeSettings(errors: ErrorChannelSettings) {
    // The same write path part A will own; here the raw row write keeps the
    // test independent of part A's routes (not merged yet).
    const [row] = await db.select().from(instanceSettings).where(eq(instanceSettings.singletonKey, "default"));
    if (!row) {
      await db.insert(instanceSettings).values({
        singletonKey: "default",
        general: { [TELEGRAM_NOTIFY_GENERAL_KEY]: { errors } },
        experimental: {},
      });
      return;
    }
    const general = { ...(row.general as Record<string, unknown>) };
    general[TELEGRAM_NOTIFY_GENERAL_KEY] = { errors };
    await db.update(instanceSettings).set({ general }).where(eq(instanceSettings.id, row.id));
  }

  const settingsSource = { read: async (_companyId: string) => storedSettings() };

  function feedFromDb() {
    return {
      list: async (companyId: string) => {
        const feed = await attentionService(db).list(companyId, { all: true, allowUnscopedAll: true });
        return feed.items;
      },
    };
  }

  it("is silent by default: no settings row, no publications, nothing read beyond the settings", async () => {
    const { companyId, agentId } = await seedCompany();
    await seedDmConversation(companyId, agentId, "770099");
    await seedFailedRun(companyId, agentId);
    expect(await storedSettings()).toEqual({
      enabled: false,
      chatId: null,
      topicId: null,
      minSeverity: "error",
      maxPerHour: 10,
    });
    const result = await sweepErrorChannel(companyId, {
      db,
      settings: settingsSource,
      feed: feedFromDb(),
    });
    expect(result).toEqual({ checked: 0, sent: 0, droppedRateLimited: 0, skipped: 0 });
    const rows = await db
      .select()
      .from(chatPublications)
      .where(eq(chatPublications.companyId, companyId));
    expect(rows).toEqual([]);
  });

  it("enabled settings stage one publication per admitted error card into the configured chat", async () => {
    const { companyId, agentId } = await seedCompany();
    const { conversation } = await seedDmConversation(companyId, agentId, "770099");
    // One agent in error (agent_error_alert, high) and one failed run (failed_run, high).
    await seedFailedRun(companyId, agentId);
    await writeSettings(ISSUE_CENTRAL_ERROR);

    const result = await sweepErrorChannel(companyId, {
      db,
      settings: settingsSource,
      feed: feedFromDb(),
    });
    expect(result.checked).toBeGreaterThanOrEqual(2);
    expect(result.sent).toBe(result.checked);
    const rows = await db
      .select()
      .from(chatPublications)
      .where(
        and(
          eq(chatPublications.companyId, companyId),
          eq(chatPublications.conversationId, conversation.id),
        ),
      );
    const errorRows = rows.filter((row) => row.idempotencyKey.startsWith(ERROR_CHANNEL_PUBLICATION_PREFIX));
    expect(errorRows).toHaveLength(result.sent);
    for (const row of errorRows) {
      expect(row.state).toBe("pending");
      expect(row.payload.text).toMatch(/^\[(high|critical)\] /);
    }
    // A repeated sweep is idempotent: the same cards stage nothing new.
    const again = await sweepErrorChannel(companyId, {
      db,
      settings: settingsSource,
      feed: feedFromDb(),
    });
    expect(again.sent).toBe(0);
  });

  it("minSeverity warning admits medium budget alerts that the error threshold drops", async () => {
    const { companyId, agentId } = await seedCompany();
    await seedDmConversation(companyId, agentId, "770099");
    await writeSettings(ISSUE_CENTRAL_ERROR);
    // Only the agent error card exists; severity high. Lower it to medium is
    // not possible for agent_error_alert, so use the filter directly for the
    // threshold boundary and keep the sweep assertion on the real feed.
    const feed = {
      list: async () => [
        card({
          id: "budget-alert-medium",
          companyId,
          sourceKind: "budget_alert",
          severity: "medium",
          dedupKey: "budget:p1:w:soft",
          title: "team-a budget warning",
          subjectId: "b1",
          whyNow: "Budget warning threshold reached.",
        }),
      ],
    };
    const strict = await sweepErrorChannel(companyId, {
      db,
      settings: settingsSource,
      feed,
    });
    expect(strict.checked).toBe(0);
    expect(strict.skipped).toBe(1);

    await writeSettings({ ...ISSUE_CENTRAL_ERROR, minSeverity: "warning" });
    const relaxed = await sweepErrorChannel(companyId, {
      db,
      settings: settingsSource,
      feed,
    });
    expect(relaxed.checked).toBe(1);
    expect(relaxed.sent).toBe(1);
  });

  it("maxPerHour drops cards beyond the limit; the drop is not queued anywhere", async () => {
    const { companyId, agentId } = await seedCompany();
    await seedDmConversation(companyId, agentId, "770099");
    await writeSettings({ ...ISSUE_CENTRAL_ERROR, maxPerHour: 3 });
    const cards = Array.from({ length: 7 }, (_, index) =>
      card({
        id: `failed-run-${index}`,
        companyId,
        sourceKind: "failed_run",
        severity: "high",
        dedupKey: `failed:run-${index}`,
        title: "agent-a run failed",
        subjectId: `run-${index}`,
        whyNow: "Run failed after automatic retries were exhausted.",
      }),
    );
    const feed = { list: async () => cards };
    const limiter = new HourlyRateLimiter();
    const result = await sweepErrorChannel(companyId, {
      db,
      settings: settingsSource,
      feed,
      limiter,
    });
    expect(result.sent).toBe(3);
    expect(result.droppedRateLimited).toBe(4);
    const rows = await db
      .select()
      .from(chatPublications)
      .where(eq(chatPublications.companyId, companyId));
    expect(rows.filter((row) => row.idempotencyKey.startsWith(ERROR_CHANNEL_PUBLICATION_PREFIX))).toHaveLength(3);
  });

  it("targets the topicId conversation when the setting names a topic thread", async () => {
    const { companyId, agentId } = await seedCompany();
    const { endpoint, conversation } = await seedDmConversation(companyId, agentId, "-1001234567890");
    // A second conversation of the same chat id bound to a topic thread.
    const [topicIssue] = await db
      .insert(issues)
      .values({ companyId, title: "topic task", status: "in_progress", assigneeAgentId: agentId })
      .returning();
    await db.insert(chatConversations).values({
      companyId,
      endpointId: endpoint.id,
      issueId: topicIssue.id,
      externalConversationId: "-1001234567890",
      externalThreadId: "7",
      externalLabel: "Topic thread",
      isDirectMessage: false,
      state: "active",
    });
    await writeSettings({ ...ISSUE_CENTRAL_ERROR, chatId: "-1001234567890", topicId: "7" });
    const feed = {
      list: async () => [
        card({
          id: "agent-error-1",
          companyId,
          sourceKind: "agent_error_alert",
          severity: "critical",
          dedupKey: "agent_error:a1",
          title: "agent-a",
          subjectId: agentId,
          whyNow: "Agent is in error status.",
        }),
      ],
    };
    const result = await sweepErrorChannel(companyId, { db, settings: settingsSource, feed });
    expect(result.sent).toBe(1);
    const [row] = await db
      .select()
      .from(chatPublications)
      .where(eq(chatPublications.companyId, companyId));
    expect(row.conversationId).not.toBe(conversation.id);
    const [topicConversation] = await db
      .select()
      .from(chatConversations)
      .where(and(eq(chatConversations.companyId, companyId), eq(chatConversations.externalThreadId, "7")));
    expect(row.conversationId).toBe(topicConversation.id);
  });

  it("keeps the telegramNotify key across a vendor general-settings write", async () => {
    await writeSettings(ISSUE_CENTRAL_ERROR);
    await instanceSettingsService(db).updateGeneral({ censorUsernameInLogs: true });
    expect(await storedSettings()).toEqual(ISSUE_CENTRAL_ERROR);
  });
});
