// myrmidon(X9e): end-to-end acceptance coverage for TG-MULTI-AGENT — the
// "done when" scenario from the parent task, driven through the real
// `chatChannelService` against a fake Telegram runtime:
//
//   (a) DM `@гип …` -> the GIP's own standing conversation, reply from the
//       GIP published back into the same chat with the `[ГИП] ` prefix;
//   (b) DM `@дизайнер …` -> the designer's conversation, `[Дизайнер] ` prefix;
//   (c) plain DM -> the endpoint's assigned agent, no prefix;
//   (d) a group topic `@гип …` mention -> the turn assigned to the GIP and
//       woken for them (the vendor's requireMention gate stays satisfied);
//   (e) `/to unknown` -> the bridged command hint naming no agent.
//
// Structure mirrors chat-telegram-dm-conversation.myrmidon.test.ts (X8b) and
// bridge-addressing.myrmidon.test.ts (X9b): embedded postgres, fake chat SDK
// runtime, real bridge modules (addressing.ts / links.ts / chat-channels.ts
// X9b hooks from merged main). These tests red on main without X9a/X9b: the
// addressed conversation would be the assigned agent's, the wakeup would
// target the assigned agent, and the reply prefix would be absent.
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  agentWakeupRequests,
  authUsers,
  chatConversations,
  chatDeliveries,
  chatEndpoints,
  chatExternalPrincipals,
  chatIdentityLinks,
  chatPublications,
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
  principalPermissionGrants,
  type Db,
} from "@paperclipai/db";
import type { Attachment, Author, Message, Thread } from "chat";
import {
  chatChannelService,
  type ChatChannelService,
  type ChatChannelServiceOptions,
} from "../services/chat-channels.js";
import type {
  ChatSdkMessageTrigger,
  CreateChatSdkEndpointRuntimeOptions,
} from "../services/chat-sdk-runtime.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueService } from "../services/issues.js";
import { CHAT_RUN_PRESENTATION_AUTHORIZATION_REASON } from "../services/heartbeat-run-summary.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { telegramConversationUserId } from "../myrmidon/agent-chat-bridge/identity.js";
import { TELEGRAM_DM_CONVERSATIONS_ENV } from "../myrmidon/agent-chat-bridge/settings.js";

const externalTestDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;
const embeddedPostgresSupport = externalTestDatabaseUrl
  ? { supported: true }
  : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

// ---------------------------------------------------------------------------
// Fakes (same shapes as the X8b/X9b test files; test doubles, not vendor code).

type PostedMessage = { threadId: string; text: string };

class FakeEndpointRuntime {
  /** Posts delivered by publication transport, keyed by threadId. */
  readonly posted: PostedMessage[] = [];
  readonly threads = new Map<string, { post: (message: unknown) => Promise<unknown> }>();
  constructor(
    readonly options: CreateChatSdkEndpointRuntimeOptions,
  ) {}
  get provider() {
    return this.options.providerConfig.provider;
  }
  thread(threadId: string) {
    const existing = this.threads.get(threadId);
    if (existing) return existing;
    const entry = {
      post: async (message: unknown) => {
        const text =
          typeof message === "string"
            ? message
            : message && typeof message === "object" && "markdown" in (message as Record<string, unknown>)
              ? String((message as { markdown: unknown }).markdown)
              : message && typeof message === "object" && "text" in (message as Record<string, unknown>)
                ? String((message as { text: unknown }).text)
                : JSON.stringify(message);
        this.posted.push({ threadId, text });
        return { id: `post-${randomUUID()}`, threadId };
      },
    };
    this.threads.set(threadId, entry);
    return entry;
  }
  async initialize() {}
  async shutdown() {}
}

class FakeChatSdkRuntime {
  readonly endpoints = new Map<string, FakeEndpointRuntime>();
  readonly configurations = new Map<string, CreateChatSdkEndpointRuntimeOptions>();
  replaceCount = 0;
  constructor() {}
  get(endpointId: string) {
    return this.endpoints.get(endpointId) ?? null;
  }
  async replaceEndpoint(options: CreateChatSdkEndpointRuntimeOptions) {
    this.replaceCount += 1;
    this.configurations.set(options.endpointId, options);
    const endpoint = new FakeEndpointRuntime(options);
    this.endpoints.set(options.endpointId, endpoint);
    return endpoint;
  }
  async removeEndpoint(endpointId: string) {
    const endpoint = this.endpoints.get(endpointId);
    if (!endpoint) return false;
    this.endpoints.delete(endpointId);
    await endpoint.shutdown();
    return true;
  }
  async shutdown() {
    await Promise.all([...this.endpoints.values()].map((endpoint) => endpoint.shutdown()));
    this.endpoints.clear();
  }
}

function fakeTelegramFetch(
  botId = Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 12), 16),
) {
  return async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/getMe")) {
      return new Response(
        JSON.stringify({
          ok: true,
          result: { id: botId, username: `paperclip_${botId}_bot`, first_name: "Paperclip Test" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/getWebhookInfo")) {
      return new Response(JSON.stringify({ ok: true, result: { url: "" } }), {
        status: 200,
        headers: { "content-type": "application/json" } },
      );
    }
    if (
      url.endsWith("/setWebhook") ||
      url.endsWith("/setMyCommands") ||
      url.endsWith("/deleteWebhook") ||
      url.endsWith("/deleteMyCommands")
    ) {
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`Unexpected provider request: ${url}`);
  };
}

function makeThread(input: { channelId: string; id: string; isDM?: boolean; name?: string }) {
  const addReaction = vi.fn(async () => undefined);
  const startTyping = vi.fn(async () => undefined);
  const subscribe = vi.fn(async () => undefined);
  const postEphemeral = vi.fn(async () => ({
    id: `thread-ephemeral-${randomUUID()}`,
    threadId: input.id,
    usedFallback: false,
  }));
  const post = vi.fn(async () => ({ id: `thread-post-${randomUUID()}`, threadId: input.id }));
  const thread = {
    id: input.id,
    channelId: input.channelId,
    isDM: input.isDM ?? false,
    channel: { id: input.channelId, name: input.name ?? input.channelId },
    adapter: { addReaction },
    startTyping,
    subscribe,
    post,
    postEphemeral,
  } as unknown as Thread;
  return { thread, post };
}

function makeMessage(input: {
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
    attachments: [] as Attachment[],
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

// ---------------------------------------------------------------------------
// Suite

describeEmbeddedPostgres(
  "TG-MULTI-AGENT end-to-end: any company agent from one Telegram chat (X9e)",
  () => {
    let db!: Db;
    let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
    const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    const secretsTmpDir = path.join(os.tmpdir(), `paperclip-x9e-e2e-${randomUUID()}`);
    const fixtureCompanies = new Set<string>();
    const fixtureServices = new Set<ChatChannelService>();
    const previousDmEnv = process.env[TELEGRAM_DM_CONVERSATIONS_ENV];

    beforeAll(async () => {
      mkdirSync(secretsTmpDir, { recursive: true });
      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
      if (externalTestDatabaseUrl) {
        db = createDb(externalTestDatabaseUrl);
      } else {
        tempDb = await startEmbeddedPostgresTestDatabase("paperclip-x9e-e2e-");
        db = createDb(tempDb.connectionString);
      }
    }, 90_000);

    afterAll(async () => {
      await Promise.all([...fixtureServices].map((service) => service.shutdown())).catch(() => {});
      await db?.$client.end({ timeout: 0 });
      await tempDb?.cleanup();
      if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
      else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
      rmSync(secretsTmpDir, { recursive: true, force: true });
    });

    beforeEach(async () => {
      process.env[TELEGRAM_DM_CONVERSATIONS_ENV] = "*";
      await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
    });

    afterEach(async () => {
      if (previousDmEnv === undefined) delete process.env[TELEGRAM_DM_CONVERSATIONS_ENV];
      else process.env[TELEGRAM_DM_CONVERSATIONS_ENV] = previousDmEnv;
      try {
        await Promise.all([...fixtureServices].map((service) => service.shutdown()));
      } finally {
        if (fixtureCompanies.size > 0) {
          await db.update(chatEndpoints).set({ status: "paused" })
            .where(and(inArray(chatEndpoints.companyId, [...fixtureCompanies]), eq(chatEndpoints.status, "active")));
          await db.update(chatConversations).set({ state: "completed" })
            .where(and(inArray(chatConversations.companyId, [...fixtureCompanies]), inArray(chatConversations.state, ["active", "waiting"])));
        }
        fixtureServices.clear();
        fixtureCompanies.clear();
      }
    });

    async function seedCompany() {
      const companyId = randomUUID();
      fixtureCompanies.add(companyId);
      const assignedAgentId = randomUUID();
      const gipAgentId = randomUUID();
      const designerAgentId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name: `Chat Test ${companyId.slice(0, 8)}`,
        issuePrefix: `E${companyId.replaceAll("-", "").slice(0, 7).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      });
      const now = new Date();
      await db.insert(authUsers).values({
        id: "owner-user",
        name: "Owner User",
        email: "owner-user@example.com",
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      }).onConflictDoNothing();
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "user",
        principalId: "owner-user",
        status: "active",
        membershipRole: "operator",
      }).onConflictDoNothing();
      await db.insert(principalPermissionGrants).values({
        companyId,
        principalType: "user",
        principalId: "owner-user",
        permissionKey: "tools:manage_connections",
        scope: null,
        grantedByUserId: "owner-user",
      }).onConflictDoNothing();
      await db.insert(agents).values([
        {
          id: assignedAgentId,
          companyId,
          name: "Maya",
          role: "engineer",
          status: "idle",
          adapterType: "paperclip_runner",
          adapterConfig: {},
          runtimeConfig: {},
          permissions: {},
        },
        {
          id: gipAgentId,
          companyId,
          name: "ГИП",
          role: "supervisor",
          status: "idle",
          adapterType: "paperclip_runner",
          // Part A's contract: the agent card's telegramAliases in JSON.
          adapterConfig: { telegramAliases: ["гип"] },
          runtimeConfig: {},
          permissions: {},
        },
        {
          id: designerAgentId,
          companyId,
          name: "Дизайнер",
          role: "designer",
          status: "idle",
          adapterType: "paperclip_runner",
          adapterConfig: { telegramAliases: ["дизайнер"] },
          runtimeConfig: {},
          permissions: {},
        },
      ]);
      return { companyId, assignedAgentId, gipAgentId, designerAgentId };
    }

    // Same receipt-recording wrapper as the X9b tests: a truthy return is
    // not a durable scheduler receipt, so the durable chat request's own
    // agent_wakeup_requests row is inserted (that is how a test asserts which
    // agent the turn woke).
    function receiptBackedWakeup(): NonNullable<ChatChannelServiceOptions["heartbeat"]>["wakeup"] {
      return async (agentId, opts) => {
        const request = opts.durableChatRequest;
        if (request) {
          const [existing] = await db
            .select({ id: agentWakeupRequests.id })
            .from(agentWakeupRequests)
            .where(eq(agentWakeupRequests.id, request.id));
          if (!existing) {
            await db.transaction(async (tx) => {
              await request.authorize(
                tx as unknown as Parameters<typeof request.authorize>[0],
              );
              await tx
                .insert(agentWakeupRequests)
                .values({
                  id: request.id,
                  companyId: request.companyId,
                  agentId,
                  source: opts.source ?? "assignment",
                  triggerDetail: opts.triggerDetail,
                  reason: opts.reason,
                  payload: opts.payload,
                  requestedByActorType: opts.requestedByActorType,
                  requestedByActorId: opts.requestedByActorId,
                  idempotencyKey: request.idempotencyKey,
                  requestedAt: request.requestedAt,
                  status: "queued",
                })
                .onConflictDoNothing();
            });
          }
        }
        return { accepted: true } as unknown as Awaited<
          ReturnType<NonNullable<ChatChannelServiceOptions["heartbeat"]>["wakeup"]>
        >;
      };
    }

    function createService() {
      const runtime = new FakeChatSdkRuntime();
      const service = chatChannelService(db, {
        fetch: fakeTelegramFetch() as typeof globalThis.fetch,
        heartbeat: { wakeup: receiptBackedWakeup() },
        publicBaseUrl: "https://paperclip.example",
        runtime: runtime as unknown as ChatChannelServiceOptions["runtime"],
      });
      fixtureServices.add(service);
      return { runtime, service };
    }

    async function configuredTelegramEndpoint(
      fixture: Awaited<ReturnType<typeof seedCompany>>,
    ) {
      const context = createService();
      const endpoint = await context.service.create(
        fixture.companyId,
        {
          provider: "telegram",
          assignedAgentId: fixture.assignedAgentId,
          name: "Maya in Telegram",
        },
        "owner-user",
      );
      await context.service.configure(
        endpoint.id,
        {
          action: "configure",
          credentials: { botToken: "123456:x9e-interaction-test" },
        },
        "owner-user",
      );
      const callbacks = context.runtime.configurations.get(endpoint.id)?.callbacks;
      if (!callbacks) throw new Error("Fake runtime did not receive Telegram callbacks");
      return { ...context, endpoint, callbacks };
    }

    async function linkTelegramPrincipal(input: {
      companyId: string;
      endpointId: string;
      userId: string;
      boardUserId: string;
    }) {
      const [endpoint] = await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, input.endpointId));
      const [principal] = await db
        .insert(chatExternalPrincipals)
        .values({
          companyId: input.companyId,
          provider: "telegram",
          providerAccountId: endpoint?.providerAccountId ?? "unknown",
          externalId: input.userId,
          kind: "user",
          displayName: "Telegram User",
          handle: "telegram-user",
          isBot: false,
          lastSeenAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            chatExternalPrincipals.companyId,
            chatExternalPrincipals.provider,
            chatExternalPrincipals.providerAccountId,
            chatExternalPrincipals.externalId,
          ],
          set: { lastSeenAt: new Date() },
        })
        .returning();
      await db
        .insert(chatIdentityLinks)
        .values({
          companyId: input.companyId,
          endpointId: input.endpointId,
          principalId: principal.id,
          paperclipUserId: input.boardUserId,
          status: "linked",
        })
        .onConflictDoNothing();
      return principal;
    }

    async function sendMessage(input: {
      callbacks: CreateChatSdkEndpointRuntimeOptions["callbacks"];
      endpointId: string;
      channelId: string;
      threadId: string;
      text: string;
      userId: string;
      messageId: number;
      isDM: boolean;
      mentioned?: boolean;
      name?: string;
    }) {
      const { thread, post } = makeThread({
        channelId: input.channelId,
        id: input.threadId,
        isDM: input.isDM,
        name: input.name ?? input.channelId,
      });
      await input.callbacks.onMessage({
        endpointId: input.endpointId,
        provider: "telegram",
        providerUpdateId: input.messageId,
        thread,
        message: makeMessage({
          id: String(input.messageId),
          text: input.text,
          userId: input.userId,
          mentioned: input.mentioned,
          raw: {
            message_id: input.messageId,
            date: 1_800_000_000 + input.messageId,
            chat: { id: Number(input.channelId.replace(/[^-\d]/g, "")) || input.messageId, type: input.isDM ? "private" : "group" },
            from: { id: Number(input.userId), is_bot: false },
            text: input.text,
          },
        }),
        trigger: (input.isDM ? "direct_message" : "channel_message") as ChatSdkMessageTrigger,
      });
      return { post };
    }

    async function sendTelegramDm(input: {
      callbacks: CreateChatSdkEndpointRuntimeOptions["callbacks"];
      endpointId: string;
      channelId: string;
      text: string;
      userId: string;
      messageId: number;
    }) {
      return sendMessage({
        ...input,
        threadId: `telegram:${input.channelId}`,
        isDM: true,
        name: "Telegram direct message",
      });
    }

    async function conversationRow(endpointId: string, channelId: string) {
      return db
        .select()
        .from(chatConversations)
        .where(
          and(
            eq(chatConversations.endpointId, endpointId),
            eq(chatConversations.externalConversationId, channelId),
          ),
        )
        .orderBy(desc(chatConversations.sessionGeneration))
        .then((rows) => rows[0] ?? null);
    }

    async function conversationIssue(input: {
      companyId: string;
      conversationAgentId: string;
      conversationUserId: string;
    }) {
      return db
        .select()
        .from(issues)
        .where(
          and(
            eq(issues.companyId, input.companyId),
            eq(issues.conversationAgentId, input.conversationAgentId),
            eq(issues.conversationUserId, input.conversationUserId),
          ),
        )
        .then((rows) => rows[0] ?? null);
    }

    /**
     * The agent's reply: exactly what a heartbeat run of the woken agent does
     * (the X8g pattern) — a comment on the conversation issue authorized by a
     * run bound to the chat origin, then the publication lane delivers it
     * back into the same Telegram chat.
     */
    async function agentReply(input: {
      fixture: Awaited<ReturnType<typeof seedCompany>>;
      agentId: string;
      conversationIssueId: string;
      inboundCommentId: string;
      conversationSessionGeneration: number | null;
      text: string;
    }) {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId: input.fixture.companyId,
        agentId: input.agentId,
        status: "succeeded",
        contextSnapshot: {
          issueId: input.conversationIssueId,
          source: "chat:telegram",
          commentId: input.inboundCommentId,
          wakeCommentId: input.inboundCommentId,
          wakeCommentIds: [input.inboundCommentId],
          // A standing conversation only accepts a reply from a run that
          // belongs to the conversation's current session.
          conversationSessionGeneration: input.conversationSessionGeneration,
        },
      });
      const reply = await issueService(db).addComment(
        input.conversationIssueId,
        input.text,
        { agentId: input.agentId, runId },
        {
          authorType: "agent",
          authorizationReason: CHAT_RUN_PRESENTATION_AUTHORIZATION_REASON,
        },
      );
      return { runId, replyId: reply.id };
    }

    // -------------------------------------------------------------------------
    // (a) DM `@гип …` -> GIP's conversation, `[ГИП] ` prefixed reply in the
    // same chat.

    it("routes a DM '@гип …' turn to the GIP and publishes the GIP's reply back into the same chat with the [ГИП] prefix", async () => {
      const fixture = await seedCompany();
      const { callbacks, endpoint, runtime, service } = await configuredTelegramEndpoint(fixture);
      await linkTelegramPrincipal({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        userId: "700101",
        boardUserId: "owner-user",
      });

      await sendTelegramDm({
        callbacks,
        endpointId: endpoint.id,
        channelId: "700101",
        text: "@гип когда сдача проекта?",
        userId: "700101",
        messageId: 1,
      });

      const conversationUserId = telegramConversationUserId("owner-user");
      const gipIssue = await conversationIssue({
        companyId: fixture.companyId,
        conversationAgentId: fixture.gipAgentId,
        conversationUserId,
      });
      expect(gipIssue).not.toBeNull();
      const conversation = await conversationRow(endpoint.id, "700101");
      expect(conversation).toMatchObject({ issueId: gipIssue!.id, isDirectMessage: true, state: "active" });

      const [inboundComment] = await db
        .select()
        .from(issueComments)
        .where(eq(issueComments.issueId, gipIssue!.id));
      expect(inboundComment).toBeDefined();
      expect(inboundComment!.body).toBe("когда сдача проекта?");

      // The inbound wakeup targets the GIP.
      const [wakeup] = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, fixture.gipAgentId));
      expect(wakeup).toBeDefined();

      // The GIP's reply — published back into the same Telegram chat.
      await agentReply({
        fixture,
        agentId: fixture.gipAgentId,
        conversationIssueId: gipIssue!.id,
        inboundCommentId: inboundComment!.id,
        conversationSessionGeneration: gipIssue!.conversationSessionGeneration,
        text: "Сдача в пятницу.",
      });

      const [publication] = await db
        .select()
        .from(chatPublications)
        .where(
          and(
            eq(chatPublications.endpointId, endpoint.id),
            eq(chatPublications.conversationId, conversation!.id),
          ),
        )
        .orderBy(desc(chatPublications.createdAt))
        .then((rows) => rows.filter((row) => row.idempotencyKey.startsWith("comment:")));
      expect(publication).toBeDefined();
      expect((publication!.payload as { text?: string }).text).toBe("[ГИП] Сдача в пятницу.");

      // Delivery: the publication lane posts it into the same chat's thread.
      await service.processPendingPublications();
      const endpointRuntime = runtime.get(endpoint.id)!;
      expect(
        endpointRuntime.posted.some(
          (entry) => entry.threadId === conversation!.externalThreadId && entry.text === "[ГИП] Сдача в пятницу.",
        ),
      ).toBe(true);
    }, 30_000);

    // -------------------------------------------------------------------------
    // (b) DM `@дизайнер …` -> the designer's conversation, `[Дизайнер] `.

    it("routes a DM '@дизайнер …' turn to the designer and prefixes its reply with [Дизайнер]", async () => {
      const fixture = await seedCompany();
      const { callbacks, endpoint, runtime, service } = await configuredTelegramEndpoint(fixture);
      await linkTelegramPrincipal({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        userId: "700102",
        boardUserId: "owner-user",
      });

      await sendTelegramDm({
        callbacks,
        endpointId: endpoint.id,
        channelId: "700102",
        text: "@дизайнер покажи макет",
        userId: "700102",
        messageId: 1,
      });

      const conversationUserId = telegramConversationUserId("owner-user");
      const designerIssue = await conversationIssue({
        companyId: fixture.companyId,
        conversationAgentId: fixture.designerAgentId,
        conversationUserId,
      });
      expect(designerIssue).not.toBeNull();
      const conversation = await conversationRow(endpoint.id, "700102");
      expect(conversation!.issueId).toBe(designerIssue!.id);

      const [inboundComment] = await db
        .select()
        .from(issueComments)
        .where(eq(issueComments.issueId, designerIssue!.id));
      const [wakeup] = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, fixture.designerAgentId));
      expect(wakeup).toBeDefined();

      await agentReply({
        fixture,
        agentId: fixture.designerAgentId,
        conversationIssueId: designerIssue!.id,
        inboundCommentId: inboundComment!.id,
        conversationSessionGeneration: designerIssue!.conversationSessionGeneration,
        text: "Макет готов.",
      });

      const [publication] = await db
        .select()
        .from(chatPublications)
        .where(
          and(
            eq(chatPublications.endpointId, endpoint.id),
            eq(chatPublications.conversationId, conversation!.id),
          ),
        )
        .orderBy(desc(chatPublications.createdAt))
        .then((rows) => rows.filter((row) => row.idempotencyKey.startsWith("comment:")));
      expect(publication).toBeDefined();
      expect((publication!.payload as { text?: string }).text).toBe("[Дизайнер] Макет готов.");

      await service.processPendingPublications();
      const endpointRuntime = runtime.get(endpoint.id)!;
      expect(
        endpointRuntime.posted.some(
          (entry) => entry.threadId === conversation!.externalThreadId && entry.text === "[Дизайнер] Макет готов.",
        ),
      ).toBe(true);
    }, 30_000);

    // -------------------------------------------------------------------------
    // (c) plain DM -> the endpoint's assigned agent, no prefix.

    it("routes a plain DM to the assigned agent and publishes its reply without a prefix", async () => {
      const fixture = await seedCompany();
      const { callbacks, endpoint, runtime, service } = await configuredTelegramEndpoint(fixture);
      await linkTelegramPrincipal({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        userId: "700103",
        boardUserId: "owner-user",
      });

      await sendTelegramDm({
        callbacks,
        endpointId: endpoint.id,
        channelId: "700103",
        text: "просто вопрос",
        userId: "700103",
        messageId: 1,
      });

      const conversationUserId = telegramConversationUserId("owner-user");
      const assignedIssue = await conversationIssue({
        companyId: fixture.companyId,
        conversationAgentId: fixture.assignedAgentId,
        conversationUserId,
      });
      expect(assignedIssue).not.toBeNull();
      const conversation = await conversationRow(endpoint.id, "700103");
      expect(conversation!.issueId).toBe(assignedIssue!.id);

      const [inboundComment] = await db
        .select()
        .from(issueComments)
        .where(eq(issueComments.issueId, assignedIssue!.id));
      const [wakeup] = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, fixture.assignedAgentId));
      expect(wakeup).toBeDefined();

      await agentReply({
        fixture,
        agentId: fixture.assignedAgentId,
        conversationIssueId: assignedIssue!.id,
        inboundCommentId: inboundComment!.id,
        conversationSessionGeneration: assignedIssue!.conversationSessionGeneration,
        text: "Отвечаю.",
      });

      const [publication] = await db
        .select()
        .from(chatPublications)
        .where(
          and(
            eq(chatPublications.endpointId, endpoint.id),
            eq(chatPublications.conversationId, conversation!.id),
          ),
        )
        .orderBy(desc(chatPublications.createdAt))
        .then((rows) => rows.filter((row) => row.idempotencyKey.startsWith("comment:")));
      expect(publication).toBeDefined();
      // The assigned agent's replies are the chat's own voice: no prefix.
      expect((publication!.payload as { text?: string }).text).toBe("Отвечаю.");

      await service.processPendingPublications();
      const endpointRuntime = runtime.get(endpoint.id)!;
      expect(
        endpointRuntime.posted.some(
          (entry) => entry.threadId === conversation!.externalThreadId && entry.text === "Отвечаю.",
        ),
      ).toBe(true);
    }, 30_000);

    // -------------------------------------------------------------------------
    // (d) group topic: `@гип …` -> the turn is the GIP's; requireMention is
    // satisfied by the mention.

    it("routes a group topic '@гип …' mention to the GIP while the mention requirement stays satisfied", async () => {
      const fixture = await seedCompany();
      const { callbacks, endpoint } = await configuredTelegramEndpoint(fixture);
      await linkTelegramPrincipal({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        userId: "700104",
        boardUserId: "owner-user",
      });

      // A Telegram forum topic: native thread id telegram:<group>:<topic>.
      const { post } = await sendMessage({
        callbacks,
        endpointId: endpoint.id,
        channelId: "-100104",
        threadId: "telegram:-100104:42",
        text: "@гип отчёт готов?",
        userId: "700104",
        messageId: 1,
        isDM: false,
        mentioned: true,
        name: "Group topic",
      });

      // The vendor's native-thread task model: a chat_channel task whose
      // assignee is the addressed agent (X9b group twin), not the endpoint's.
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
      expect(task!.assigneeAgentId).toBe(fixture.gipAgentId);

      // The comment body drops the leading @-token.
      const [comment] = await db
        .select()
        .from(issueComments)
        .where(eq(issueComments.issueId, task!.id));
      expect(comment!.body).toBe("отчёт готов?");

      // The addressed agent is the one woken for the turn.
      const [wakeup] = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, fixture.gipAgentId));
      expect(wakeup).toBeDefined();
      const assignedWakeup = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, fixture.assignedAgentId));
      expect(assignedWakeup).toHaveLength(0);

      // requireMention honored: the delivery was admitted (processed), not
      // filtered as "Message did not address the agent".
      const deliveries = await db
        .select()
        .from(chatDeliveries)
        .where(eq(chatDeliveries.endpointId, endpoint.id));
      expect(deliveries.length).toBeGreaterThan(0);
      expect(deliveries.every((row) => row.state === "processed")).toBe(true);
      expect(post).toBeDefined();
    }, 30_000);

    // -------------------------------------------------------------------------
    // (e) `/to unknown` -> the bridged command hint.

    it("answers '/to unknown' with the bridged command hint instead of routing a turn", async () => {
      const fixture = await seedCompany();
      const { callbacks, endpoint } = await configuredTelegramEndpoint(fixture);
      await linkTelegramPrincipal({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        userId: "700105",
        boardUserId: "owner-user",
      });

      const { post } = await sendTelegramDm({
        callbacks,
        endpointId: endpoint.id,
        channelId: "700105",
        text: "/to unknown",
        userId: "700105",
        messageId: 1,
      });

      // A reply-kind command still ensures the standing conversation binding
      // (handleTelegramDmCommand binds before dispatching), but no comment
      // and no wakeup: the turn finishes inside the command handler.
      const conversationUserId = telegramConversationUserId("owner-user");
      const [commandIssue] = await db
        .select()
        .from(issues)
        .where(
          and(
            eq(issues.companyId, fixture.companyId),
            eq(issues.conversationUserId, conversationUserId),
          ),
        );
      expect(commandIssue).toBeDefined();
      const commandComments = await db
        .select({ id: issueComments.id })
        .from(issueComments)
        .where(eq(issueComments.issueId, commandIssue!.id));
      expect(commandComments).toHaveLength(0);
      const wakeups = await db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.companyId, fixture.companyId));
      expect(wakeups).toHaveLength(0);

      // The control reply landed in the same chat's conversation: the X8b
      // command vocabulary answers unknown addressees with the hint (until
      // part B's /to handler lands, the unknown-command reply is the hint).
      const conversation = await conversationRow(endpoint.id, "700105");
      expect(conversation).not.toBeNull();
      const publications = conversation
        ? await db
            .select()
            .from(chatPublications)
            .where(eq(chatPublications.conversationId, conversation.id))
        : [];
      const hintReplies = publications.filter((row) =>
        row.idempotencyKey.startsWith("control:"),
      );
      expect(hintReplies.length).toBeGreaterThan(0);
      const hintText = hintReplies
        .map((row) => String((row.payload as { text?: string }).text ?? ""))
        .join("\n");
      expect(hintText.length).toBeGreaterThan(0);
      expect(post).toBeDefined();
    }, 30_000);
  },
);
