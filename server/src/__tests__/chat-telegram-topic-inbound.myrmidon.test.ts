// myrmidon(TG-NOTIFY-D): integration coverage for inbound from Telegram group
// topics: a topic message becomes a task (no binding) or continues the bound
// conversation, gated by the `telegramNotify.inbound` instance settings.
// Helper functions (the fakes, thread/message builders, company/service
// fixtures) are copied and trimmed from the vendor's
// server/src/__tests__/chat-channels.integration.test.ts via the X8b test
// file (that file is not edited — see docs/myrmidon/CONVENTIONS.md §7).
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  agents,
  agentWakeupRequests,
  authUsers,
  chatConversations,
  chatDeliveries,
  chatEndpoints,
  companies,
  companyMemberships,
  createDb,
  issueComments,
  issues,
  principalPermissionGrants,
} from "@paperclipai/db";
import type { ChatProvider } from "@paperclipai/shared";
import type { Attachment, Author, Message, Thread } from "chat";
import {
  chatChannelService,
  type ChatChannelServiceOptions,
  type ChatChannelService,
} from "../services/chat-channels.js";
import type {
  CreateChatSdkEndpointRuntimeOptions,
  ChatSdkRuntime,
} from "../services/chat-sdk-runtime.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
// myrmidon(TG-NOTIFY-D): the settings writer under test (part D gate).
import { mutateTelegramNotifySettings } from "../myrmidon/telegram-notify/settings.js";
import { isTelegramTopicThread } from "../myrmidon/telegram-notify/topic-inbound.js";

const externalTestDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;
const embeddedPostgresSupport = externalTestDatabaseUrl
  ? { supported: true }
  : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe.sequential
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Telegram topic inbound tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type TestDb = ReturnType<typeof createDb>;

function fakeTelegramFetch(
  botId = Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 12), 16),
) {
  return async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/getMe")) {
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            id: botId,
            username: `paperclip_${botId}_bot`,
            first_name: "Paperclip Test",
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
      url.endsWith("/deleteMyCommands")
    ) {
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected provider request: ${url}`);
  };
}

function makeThread(input: {
  channelId: string;
  id: string;
  isDM?: boolean;
  name?: string;
}) {
  const subscribe = vi.fn(async () => undefined);
  const startTyping = vi.fn(async () => undefined);
  const post = vi.fn(async () => ({
    id: `thread-post-${randomUUID()}`,
    threadId: input.id,
  }));
  const thread = {
    id: input.id,
    channelId: input.channelId,
    isDM: input.isDM ?? false,
    channel: { id: input.channelId, name: input.name ?? input.channelId },
    adapter: { addReaction: vi.fn(async () => undefined) },
    startTyping,
    subscribe,
    post,
    postEphemeral: vi.fn(async () => ({
      id: `thread-ephemeral-${randomUUID()}`,
      threadId: input.id,
      usedFallback: false,
    })),
  } as unknown as Thread;
  return { thread, subscribe, startTyping, post };
}

function makeMessage(input: {
  attachments?: Attachment[];
  id: string;
  raw?: unknown;
  text: string;
  mentioned?: boolean;
  userId?: string;
  userName?: string;
}) {
  return {
    id: input.id,
    raw: input.raw,
    text: input.text,
    isMention: input.mentioned ?? false,
    attachments: input.attachments ?? [],
    metadata: { dateSent: new Date(), edited: false },
    author: {
      userId: input.userId ?? "U-EXTERNAL",
      userName: input.userName ?? "alex",
      fullName: "Alex External",
      isBot: false,
      isMe: false,
      isSystem: false,
    } satisfies Author,
  } as unknown as Message;
}

class FakeEndpointRuntime {
  constructor(
    private readonly options: CreateChatSdkEndpointRuntimeOptions,
  ) {}
  get provider() {
    return this.options.providerConfig.provider;
  }
  async initialize() {}
  async shutdown() {}
}

class FakeChatSdkRuntime {
  readonly endpoints = new Map<string, FakeEndpointRuntime>();
  readonly configurations = new Map<
    string,
    CreateChatSdkEndpointRuntimeOptions
  >();
  get(endpointId: string) {
    return this.endpoints.get(endpointId) ?? null;
  }
  async replaceEndpoint(options: CreateChatSdkEndpointRuntimeOptions) {
    this.configurations.set(options.endpointId, options);
    const endpoint = new FakeEndpointRuntime(options);
    this.endpoints.set(options.endpointId, endpoint);
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

describeEmbeddedPostgres(
  "Telegram group topic inbound becomes task work (TG-NOTIFY part D)",
  () => {
    let db!: TestDb;
    let tempDb: Awaited<
      ReturnType<typeof startEmbeddedPostgresTestDatabase>
    > | null = null;
    const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    const secretsTmpDir = path.join(
      os.tmpdir(),
      `paperclip-topic-inbound-${randomUUID()}`,
    );

    beforeAll(async () => {
      mkdirSync(secretsTmpDir, { recursive: true });
      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(
        secretsTmpDir,
        "master.key",
      );
      if (externalTestDatabaseUrl) {
        db = createDb(externalTestDatabaseUrl);
      } else {
        tempDb = await startEmbeddedPostgresTestDatabase(
          "paperclip-topic-inbound-",
        );
        db = createDb(tempDb.connectionString);
      }
    }, 30_000);

    afterAll(async () => {
      await tempDb?.cleanup();
      if (previousKeyFile === undefined)
        delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
      else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
      rmSync(secretsTmpDir, { recursive: true, force: true });
    });

    const fixtureCompanies = new Set<string>();
    const fixtureServices = new Set<ChatChannelService>();
    afterEach(async () => {
      try {
        await Promise.all(
          [...fixtureServices].map((service) => service.shutdown()),
        );
      } finally {
        if (fixtureCompanies.size > 0) {
          await db
            .update(chatEndpoints)
            .set({ status: "paused" })
            .where(
              and(
                inArray(chatEndpoints.companyId, [...fixtureCompanies]),
                eq(chatEndpoints.status, "active"),
              ),
            );
          await db
            .update(chatConversations)
            .set({ state: "completed" })
            .where(
              and(
                inArray(chatConversations.companyId, [...fixtureCompanies]),
                inArray(chatConversations.state, ["active", "waiting"]),
              ),
            );
        }
        fixtureServices.clear();
        fixtureCompanies.clear();
      }
    });

    async function seedCompany() {
      const companyId = randomUUID();
      fixtureCompanies.add(companyId);
      const assignedAgentId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name: `Chat Test ${companyId.slice(0, 8)}`,
        issuePrefix: `C${companyId.replaceAll("-", "").slice(0, 7).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      });
      const now = new Date();
      await db
        .insert(authUsers)
        .values({
          id: "owner-user",
          name: "Owner User",
          email: "owner-user@example.com",
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
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
        id: assignedAgentId,
        companyId,
        name: "agent-a",
        role: "engineer",
        status: "idle",
        adapterType: "paperclip_runner",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      return { companyId, assignedAgentId };
    }

    async function configuredTelegramEndpoint(
      fixture: Awaited<ReturnType<typeof seedCompany>>,
    ) {
      const runtime = new FakeChatSdkRuntime();
      const wakeup = vi.fn(async () => ({ accepted: true }));
      const service = chatChannelService(db, {
        fetch: fakeTelegramFetch() as typeof globalThis.fetch,
        heartbeat: {
          cancelRun: vi.fn(async () => ({ status: "cancelled" })),
          wakeup,
        },
        publicBaseUrl: "https://paperclip.example",
        runtime: runtime as unknown as ChatSdkRuntime,
      });
      fixtureServices.add(service);
      const endpoint = await service.create(
        fixture.companyId,
        {
          provider: "telegram",
          assignedAgentId: fixture.assignedAgentId,
          name: "agent-a in Telegram",
        },
        "owner-user",
      );
      await service.configure(
        endpoint.id,
        {
          action: "configure",
          credentials: { botToken: "123456:telegram-interaction-test" },
        },
        "owner-user",
      );
      const callbacks = runtime.configurations.get(endpoint.id)?.callbacks;
      if (!callbacks)
        throw new Error("Fake runtime did not receive Telegram callbacks");
      return { runtime, service, wakeup, endpoint, callbacks };
    }

    async function deliverTopicMessage(input: {
      callbacks: CreateChatSdkEndpointRuntimeOptions["callbacks"];
      endpointId: string;
      chatId: string;
      topicId: number;
      text: string;
      userId: string;
      messageId: number;
      trigger?: "message" | "mention";
      mentioned?: boolean;
    }) {
      const threadId = `telegram:${input.chatId}:${input.topicId}`;
      const { thread, subscribe } = makeThread({
        channelId: input.chatId,
        id: threadId,
        isDM: false,
        name: "Telegram group",
      });
      await input.callbacks.onMessage({
        endpointId: input.endpointId,
        provider: "telegram" as ChatProvider,
        providerUpdateId: input.messageId,
        thread,
        message: makeMessage({
          id: String(input.messageId),
          text: input.text,
          userId: input.userId,
          mentioned: input.mentioned ?? false,
          raw: {
            message_id: input.messageId,
            date: 1_800_000_000 + input.messageId,
            chat: { id: Number(input.chatId), type: "supergroup" },
            from: { id: Number(input.userId), is_bot: false },
            text: input.text,
          },
        }),
        trigger: (input.trigger ?? "message") as never,
      });
      return { thread, subscribe };
    }

    async function enableTopicInbound(patch: {
      enabled: boolean;
      requireMention: boolean;
    }) {
      await mutateTelegramNotifySettings(db, (current) => ({
        next: {
          ...current,
          inbound: {
            enabled: patch.enabled,
            requireMention: patch.requireMention,
          },
        },
        result: null,
      }));
    }

    async function clearTopicInbound() {
      await mutateTelegramNotifySettings(db, (current) => ({
        next: {
          ...current,
          inbound: { enabled: false, requireMention: true },
        },
        result: null,
      }));
    }

    beforeEach(async () => {
      await clearTopicInbound();
    });

    it("off by default: an unaddressed topic message creates no task and no conversation", async () => {
      const fixture = await seedCompany();
      const { callbacks, endpoint } = await configuredTelegramEndpoint(fixture);
      await deliverTopicMessage({
        callbacks,
        endpointId: endpoint.id,
        chatId: "-700100",
        topicId: 77,
        text: "Fix the login page tonight",
        userId: "700100",
        messageId: 1,
      });
      const chatChannelTasks = await db
        .select()
        .from(issues)
        .where(
          and(
            eq(issues.companyId, fixture.companyId),
            eq(issues.originKind, "chat_channel"),
          ),
        );
      expect(chatChannelTasks).toHaveLength(0);
      const conversations = await db
        .select()
        .from(chatConversations)
        .where(eq(chatConversations.endpointId, endpoint.id));
      expect(conversations).toHaveLength(0);
      const deliveries = await db
        .select()
        .from(chatDeliveries)
        .where(eq(chatDeliveries.endpointId, endpoint.id));
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0].state).toBe("filtered");
    });

    it("on with requireMention=false: an unaddressed topic message creates a task with the message body", async () => {
      const fixture = await seedCompany();
      const { callbacks, endpoint } = await configuredTelegramEndpoint(fixture);
      await enableTopicInbound({ enabled: true, requireMention: false });
      await deliverTopicMessage({
        callbacks,
        endpointId: endpoint.id,
        chatId: "-700200",
        topicId: 5,
        text: "Fix the deploy pipeline before Friday please",
        userId: "700200",
        messageId: 2,
      });
      const [task] = await db
        .select()
        .from(issues)
        .where(
          and(
            eq(issues.companyId, fixture.companyId),
            eq(issues.originKind, "chat_channel"),
          ),
        );
      expect(task).toBeDefined();
      expect(task.title).toBe("Fix the deploy pipeline before Friday please");
      expect(task.description).toContain(
        "Fix the deploy pipeline before Friday please",
      );
      // the body references the thread the task came from
      expect(task.description).toContain("Telegram topic");
      const [comment] = await db
        .select()
        .from(issueComments)
        .where(eq(issueComments.issueId, task.id));
      expect(comment).toBeDefined();
      expect(comment.body).toBe(
        "Fix the deploy pipeline before Friday please",
      );
      const conversation = await db
        .select()
        .from(chatConversations)
        .where(eq(chatConversations.issueId, task.id));
      expect(conversation).toHaveLength(1);
      expect(conversation[0].externalThreadId).toBe("telegram:-700200:5");
    });

    it("on with requireMention=true: an unaddressed topic message is still ignored", async () => {
      const fixture = await seedCompany();
      const { callbacks, endpoint } = await configuredTelegramEndpoint(fixture);
      await enableTopicInbound({ enabled: true, requireMention: true });
      await deliverTopicMessage({
        callbacks,
        endpointId: endpoint.id,
        chatId: "-700300",
        topicId: 9,
        text: "Fix the login page tonight",
        userId: "700300",
        messageId: 3,
      });
      const chatChannelTasks = await db
        .select()
        .from(issues)
        .where(
          and(
            eq(issues.companyId, fixture.companyId),
            eq(issues.originKind, "chat_channel"),
          ),
        );
      expect(chatChannelTasks).toHaveLength(0);
      const deliveries = await db
        .select()
        .from(chatDeliveries)
        .where(eq(chatDeliveries.endpointId, endpoint.id));
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0].state).toBe("filtered");
      expect(deliveries[0].redactedError).toBe(
        "Message did not address the agent",
      );
    });

    it("on with requireMention=true: an addressed (mentioned) topic message still creates the task (vendor path kept)", async () => {
      const fixture = await seedCompany();
      const { callbacks, endpoint } = await configuredTelegramEndpoint(fixture);
      await enableTopicInbound({ enabled: true, requireMention: true });
      await deliverTopicMessage({
        callbacks,
        endpointId: endpoint.id,
        chatId: "-700400",
        topicId: 11,
        text: "@bot fix the staging build",
        userId: "700400",
        messageId: 4,
        trigger: "mention",
        mentioned: true,
      });
      const [task] = await db
        .select()
        .from(issues)
        .where(
          and(
            eq(issues.companyId, fixture.companyId),
            eq(issues.originKind, "chat_channel"),
          ),
        );
      expect(task).toBeDefined();
      expect(task.title).toBe("fix the staging build");
    });

    it("a follow-up message in the same topic continues the bound conversation instead of creating a second task", async () => {
      const fixture = await seedCompany();
      const { callbacks, endpoint } = await configuredTelegramEndpoint(fixture);
      await enableTopicInbound({ enabled: true, requireMention: false });
      await deliverTopicMessage({
        callbacks,
        endpointId: endpoint.id,
        chatId: "-700500",
        topicId: 21,
        text: "First message creates the task",
        userId: "700500",
        messageId: 5,
      });
      await deliverTopicMessage({
        callbacks,
        endpointId: endpoint.id,
        chatId: "-700500",
        topicId: 21,
        text: "Second message continues it",
        userId: "700500",
        messageId: 6,
      });
      const chatChannelTasks = await db
        .select()
        .from(issues)
        .where(
          and(
            eq(issues.companyId, fixture.companyId),
            eq(issues.originKind, "chat_channel"),
          ),
        );
      expect(chatChannelTasks).toHaveLength(1);
      const comments = await db
        .select()
        .from(issueComments)
        .where(eq(issueComments.issueId, chatChannelTasks[0].id));
      expect(comments).toHaveLength(2);
      expect(comments.map((c) => c.body)).toEqual([
        "First message creates the task",
        "Second message continues it",
      ]);
    });

    it("recognizes the topic thread identity used by routing", () => {
      expect(isTelegramTopicThread("telegram:-700500:21")).toBe(true);
      expect(isTelegramTopicThread("telegram:-700500")).toBe(false);
    });
  },
);
