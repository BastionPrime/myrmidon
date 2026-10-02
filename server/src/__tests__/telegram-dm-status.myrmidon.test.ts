// myrmidon(U1): integration coverage for the editable Telegram DM run status
// (release 1.4, item 3). The fixture scaffolding (FakeChatSdkRuntime,
// fakeTelegramFetch, seedCompany, configuredTelegramEndpoint,
// linkTelegramPrincipal, sendTelegramDm) is copied and trimmed from
// server/src/__tests__/chat-telegram-dm-conversation.myrmidon.test.ts the same
// way that file copies it from the vendor's integration suite (CONVENTIONS §7:
// vendor test files are not edited).
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, like } from "drizzle-orm";
import {
  agents,
  authUsers,
  chatActions,
  chatConversations,
  chatEndpoints,
  chatExternalPrincipals,
  chatIdentityLinks,
  chatPublications,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
  principalPermissionGrants,
  toolConnections,
} from "@paperclipai/db";
import type { Author, Message, Thread } from "chat";
import {
  chatChannelService,
  type ChatChannelServiceOptions,
  type ChatChannelService,
} from "../services/chat-channels.js";
import type {
  CreateChatSdkEndpointRuntimeOptions,
  ChatSdkMessageTrigger,
  ChatSdkRuntime,
} from "../services/chat-sdk-runtime.js";
import { enqueueChatRunMilestones } from "../services/chat-run-publications.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { telegramConversationUserId } from "../myrmidon/agent-chat-bridge/identity.js";
import { TELEGRAM_DM_CONVERSATIONS_ENV } from "../myrmidon/agent-chat-bridge/settings.js";
import {
  TELEGRAM_DM_STATUS_ENV,
  TELEGRAM_SPLIT_MAX_PARTS_ENV,
} from "../myrmidon/telegram-dm-status-settings.js";
import {
  splitTelegramPublicationText,
  telegramMarkdownRequiresAttachment,
} from "../services/chat-publication-stream.js";
import { projectSafeChatPublicationText } from "../services/chat-publication-projection.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const externalTestDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;
const embeddedPostgresSupport = externalTestDatabaseUrl
  ? { supported: true }
  : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe.sequential
  : describe.skip;

type TestDb = ReturnType<typeof createDb>;

class FakeEndpointRuntime {
  readonly initialize = vi.fn(async () => undefined);
  readonly shutdown = vi.fn(async () => undefined);
  readonly posts: Array<{ threadId: string; message: unknown }> = [];
  readonly postedIds: string[] = [];
  readonly edits: Array<{ threadId: string; messageId: string; message: unknown }> = [];
  constructor(
    private readonly options: CreateChatSdkEndpointRuntimeOptions,
  ) {}

  thread(threadId: string) {
    const post = vi.fn(async (message: unknown) => {
      const id = `fake-post-${randomUUID()}`;
      this.posts.push({ threadId, message });
      this.postedIds.push(id);
      return { id, threadId };
    });
    const editMessage = vi.fn(
      async (messageId: string, message: unknown) => {
        this.edits.push({ threadId, messageId, message });
        return { id: messageId, threadId };
      },
    );
    const adapterEditMessage = vi.fn(
      async (threadIdForEdit: string, messageId: string, message: unknown) => {
        this.edits.push({ threadId: threadIdForEdit, messageId, message });
        return { id: messageId, threadId: threadIdForEdit };
      },
    );
    return {
      id: threadId,
      post,
      editMessage,
      adapter: {
        editMessage: adapterEditMessage,
        addReaction: vi.fn(async () => undefined),
        removeReaction: vi.fn(async () => undefined),
      },
      startTyping: vi.fn(async () => undefined),
      subscribe: vi.fn(async () => undefined),
      postEphemeral: vi.fn(async () => ({
        id: `fake-ephemeral-${randomUUID()}`,
        threadId,
        usedFallback: false,
      })),
    };
  }
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
    const endpoint = this.endpoints.get(endpointId);
    if (!endpoint) return false;
    this.endpoints.delete(endpointId);
    await endpoint.shutdown();
    return true;
  }

  async shutdown() {
    await Promise.all(
      [...this.endpoints.values()].map(async (endpoint) => endpoint.shutdown()),
    );
    this.endpoints.clear();
  }
}

function fakeTelegramFetch(
  botId = Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 12), 16),
) {
  return async (input: string | URL | Request) => {
    const url = String(input);
    if (
      url.endsWith("/getMe") ||
      url.endsWith("/getWebhookInfo") ||
      url.endsWith("/setWebhook") ||
      url.endsWith("/setMyCommands") ||
      url.endsWith("/deleteWebhook") ||
      url.endsWith("/deleteMyCommands")
    ) {
      const result = url.endsWith("/getWebhookInfo")
        ? { url: "" }
        : url.endsWith("/getMe")
          ? {
              id: botId,
              username: `paperclip_${botId}_bot`,
              first_name: "Paperclip Test",
            }
          : true;
      return new Response(JSON.stringify({ ok: true, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected provider request: ${url}`);
  };
}

function makeThread(input: { channelId: string; id?: string }) {
  const startTyping = vi.fn(async () => undefined);
  const subscribe = vi.fn(async () => undefined);
  const post = vi.fn(async () => ({
    id: `thread-post-${randomUUID()}`,
    threadId: input.id ?? `telegram:${input.channelId}`,
  }));
  const thread = {
    id: input.id ?? `telegram:${input.channelId}`,
    channelId: input.channelId,
    isDM: true,
    channel: { id: input.channelId, name: input.channelId },
    adapter: { addReaction: vi.fn(async () => undefined) },
    startTyping,
    subscribe,
    post,
    postEphemeral: vi.fn(async () => ({
      id: `thread-ephemeral-${randomUUID()}`,
      threadId: input.id ?? `telegram:${input.channelId}`,
      usedFallback: false,
    })),
  } as unknown as Thread;
  return { thread, post };
}

function makeMessage(input: {
  id: string;
  raw?: unknown;
  text: string;
  userId?: string;
}) {
  return {
    id: input.id,
    raw: input.raw,
    text: input.text,
    isMention: false,
    attachments: [],
    metadata: { dateSent: new Date(), edited: false },
    author: {
      userId: input.userId ?? "U-EXTERNAL",
      userName: "alex",
      fullName: "Alex External",
      isBot: false,
      isMe: false,
      isSystem: false,
    } satisfies Author,
  } as unknown as Message;
}

describeEmbeddedPostgres("Telegram DM run status (U1)", () => {
  let db!: TestDb;
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(
    os.tmpdir(),
    `paperclip-dm-status-${randomUUID()}`,
  );
  const fixtureCompanies = new Set<string>();
  const fixtureServices = new Set<ChatChannelService>();

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
        "paperclip-dm-status-",
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

  const previousDmEnv = process.env[TELEGRAM_DM_CONVERSATIONS_ENV];
  const previousStatusEnv = process.env[TELEGRAM_DM_STATUS_ENV];
  const previousSplitEnv = process.env[TELEGRAM_SPLIT_MAX_PARTS_ENV];

  beforeEach(async () => {
    process.env[TELEGRAM_DM_CONVERSATIONS_ENV] = "*";
    delete process.env[TELEGRAM_DM_STATUS_ENV];
    await instanceSettingsService(db).updateExperimental({
      enableAgentChat: true,
    });
  });

  afterEach(async () => {
    if (previousDmEnv === undefined)
      delete process.env[TELEGRAM_DM_CONVERSATIONS_ENV];
    else process.env[TELEGRAM_DM_CONVERSATIONS_ENV] = previousDmEnv;
    if (previousStatusEnv === undefined)
      delete process.env[TELEGRAM_DM_STATUS_ENV];
    else process.env[TELEGRAM_DM_STATUS_ENV] = previousStatusEnv;
    if (previousSplitEnv === undefined)
      delete process.env[TELEGRAM_SPLIT_MAX_PARTS_ENV];
    else process.env[TELEGRAM_SPLIT_MAX_PARTS_ENV] = previousSplitEnv;
    vi.unstubAllEnvs();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    fixtureCompanies.add(companyId);
    const assignedAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `DM Status Test ${companyId.slice(0, 8)}`,
      issuePrefix: `D${companyId.replaceAll("-", "").slice(0, 7).toUpperCase()}`,
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
    ]);
    return { companyId, assignedAgentId };
  }

  function createService(
    runtime = new FakeChatSdkRuntime(),
    providerFetch: typeof globalThis.fetch = fakeTelegramFetch() as typeof globalThis.fetch,
  ) {
    const service = chatChannelService(db, {
      fetch: providerFetch,
      heartbeat: {
        cancelRun: async () => ({ status: "cancelled" }),
        wakeup: async (
          agentId: string,
          opts: Parameters<
            ChatChannelServiceOptions["heartbeat"]["wakeup"]
          >[1],
        ) => {
          const request = opts?.durableChatRequest;
          if (request) {
            const { agentWakeupRequests } = await import("@paperclipai/db");
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
          return { accepted: true };
        },
      },
      publicBaseUrl: "https://paperclip.example",
      runtime: runtime as unknown as ChatSdkRuntime,
    } as ChatChannelServiceOptions);
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
        credentials: { botToken: "123456:dm-status-test" },
      },
      "owner-user",
    );
    const callbacks = context.runtime.configurations.get(endpoint.id)?.callbacks;
    if (!callbacks)
      throw new Error("Fake runtime did not receive Telegram callbacks");
    return { ...context, endpoint, callbacks };
  }

  async function linkTelegramPrincipal(input: {
    companyId: string;
    endpointId: string;
    userId: string;
    boardUserId: string;
  }) {
    const [endpoint] = await db
      .select()
      .from(chatEndpoints)
      .where(eq(chatEndpoints.id, input.endpointId));
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

  async function sendTelegramDm(input: {
    callbacks: CreateChatSdkEndpointRuntimeOptions["callbacks"];
    endpointId: string;
    channelId: string;
    text: string;
    userId: string;
    messageId: number;
  }) {
    const { thread } = makeThread({ channelId: input.channelId });
    await input.callbacks.onMessage({
      endpointId: input.endpointId,
      provider: "telegram",
      providerUpdateId: input.messageId,
      thread,
      message: makeMessage({
        id: String(input.messageId),
        text: input.text,
        userId: input.userId,
        raw: {
          message_id: input.messageId,
          date: 1_800_000_000 + input.messageId,
          chat: { id: Number(input.channelId), type: "private" },
          from: { id: Number(input.userId), is_bot: false },
          text: input.text,
        },
      }),
      trigger: "direct_message" as ChatSdkMessageTrigger,
    });
  }

  async function seedBridgedConversation() {
    const fixture = await seedCompany();
    const { callbacks, endpoint } = await configuredTelegramEndpoint(fixture);
    await linkTelegramPrincipal({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      userId: "700077",
      boardUserId: "owner-user",
    });
    await sendTelegramDm({
      callbacks,
      endpointId: endpoint.id,
      channelId: "700077",
      text: "Привет",
      userId: "700077",
      messageId: 901,
    });
    const [conversationIssue] = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, fixture.companyId),
          eq(
            issues.conversationUserId,
            telegramConversationUserId("owner-user"),
          ),
        ),
      );
    const [comment] = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(eq(issueComments.issueId, conversationIssue!.id));
    const [conversation] = await db
      .select({ id: chatConversations.id })
      .from(chatConversations)
      .where(eq(chatConversations.endpointId, endpoint.id));
    return {
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      conversationId: conversation!.id,
      issueId: conversationIssue!.id,
      agentId: fixture.assignedAgentId,
      commentId: comment!.id,
    };
  }

  async function insertRun(
    fixture: Awaited<ReturnType<typeof seedBridgedConversation>>,
    values: Partial<typeof heartbeatRuns.$inferInsert>,
  ) {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({
      id,
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      contextSnapshot: {
        issueId: fixture.issueId,
        source: "chat:telegram",
        wakeCommentId: fixture.commentId,
        wakeCommentIds: [fixture.commentId],
      },
      ...values,
    });
    return id;
  }

  const dmStatusRows = (
    fixture: Awaited<ReturnType<typeof seedBridgedConversation>>,
  ) =>
    db
      .select()
      .from(chatPublications)
      .where(
        and(
          eq(chatPublications.companyId, fixture.companyId),
          eq(chatPublications.endpointId, fixture.endpointId),
          like(chatPublications.idempotencyKey, "run:%:dmstatus:%"),
        ),
      );

  const milestoneRows = (
    fixture: Awaited<ReturnType<typeof seedBridgedConversation>>,
  ) =>
    db
      .select()
      .from(chatPublications)
      .where(
        and(
          eq(chatPublications.companyId, fixture.companyId),
          eq(chatPublications.endpointId, fixture.endpointId),
          like(chatPublications.idempotencyKey, "run:%"),
        ),
      );

  it("keeps suppressing milestones when the setting is off (X8h default)", async () => {
    const fixture = await seedBridgedConversation();
    await insertRun(fixture, { status: "running", startedAt: new Date() });
    await enqueueChatRunMilestones(db);
    expect(await dmStatusRows(fixture)).toHaveLength(0);
    expect(
      (await milestoneRows(fixture)).filter(
        (row) => !row.idempotencyKey.includes(":dmstatus:"),
      ),
    ).toHaveLength(0);
  });

  it("publishes one editable status row per run when the setting is on", async () => {
    process.env[TELEGRAM_DM_STATUS_ENV] = "true";
    const fixture = await seedBridgedConversation();
    const runId = await insertRun(fixture, {
      status: "running",
      startedAt: new Date(),
    });
    await enqueueChatRunMilestones(db);

    const rows = await dmStatusRows(fixture);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload.progressState).toBe("working");
    expect(rows[0]!.idempotencyKey).toBe(
      `run:${runId}:dmstatus:${fixture.endpointId}`,
    );
    expect(rows[0]!.payload.text).toContain("working");
  });

  it("updates the same row from queued to working instead of stacking", async () => {
    process.env[TELEGRAM_DM_STATUS_ENV] = "true";
    const fixture = await seedBridgedConversation();
    const runId = await insertRun(fixture, { status: "queued" });
    await enqueueChatRunMilestones(db);
    const queuedRows = await dmStatusRows(fixture);
    expect(queuedRows).toHaveLength(1);
    expect(queuedRows[0]!.payload.progressState).toBe("queued");
    expect(queuedRows[0]!.payload.text).toContain("queued");

    await db
      .update(heartbeatRuns)
      .set({ status: "running", startedAt: new Date() })
      .where(eq(heartbeatRuns.id, runId));
    await enqueueChatRunMilestones(db);

    const rows = await dmStatusRows(fixture);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload.progressState).toBe("working");
    expect(rows[0]!.payload.text).toContain("working");
  });

  it("still suppresses the /stop terminal milestone with the setting on", async () => {
    process.env[TELEGRAM_DM_STATUS_ENV] = "true";
    const fixture = await seedBridgedConversation();
    await insertRun(fixture, {
      status: "cancelled",
      errorCode: "chat_session_stopped",
    });
    await enqueueChatRunMilestones(db);
    expect(await dmStatusRows(fixture)).toHaveLength(0);
    expect(await milestoneRows(fixture)).toHaveLength(0);
  });

  it("still publishes the failure milestone with the setting on", async () => {
    process.env[TELEGRAM_DM_STATUS_ENV] = "true";
    const fixture = await seedBridgedConversation();
    await insertRun(fixture, { status: "failed", errorCode: "some_other_error" });
    expect(await enqueueChatRunMilestones(db)).toBeGreaterThan(0);
    const rows = await milestoneRows(fixture);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload.progressState).toBe("failed");
  });

  // The vendor's delivery lane reserves a Telegram streaming draft for long
  // DM text unless the endpoint has a confirmed /stop subscription receipt
  // (chat-channels.ts hasTelegramStopSubscription). The status milestones are
  // short single-line texts that skip streaming anyway, but the receipt keeps
  // the working milestone on the plain replace lane (edit-in-place).
  async function seedTelegramStopSubscriptionReceipt(fixture: {
    companyId: string;
    endpointId: string;
  }) {
    const [endpoint] = await db
      .select()
      .from(chatEndpoints)
      .where(eq(chatEndpoints.id, fixture.endpointId));
    if (!endpoint) throw new Error("Expected Telegram endpoint row");
    const [connection] = await db
      .select()
      .from(toolConnections)
      .where(eq(toolConnections.id, endpoint.connectionId));
    const refs = connection?.credentialSecretRefs ?? [];
    const stable = refs
      .map((ref: Record<string, unknown>) => ({
        configPath: ref.configPath,
        secretId: ref.secretId,
        versionSelector: ref.versionSelector ?? "latest",
      }))
      .sort((left: Record<string, unknown>, right: Record<string, unknown>) =>
        `${left.configPath}:${left.secretId}:${left.versionSelector}`.localeCompare(
          `${right.configPath}:${right.secretId}:${right.versionSelector}`,
        ),
      );
    const credentialFingerprint = createHash("sha256")
      .update(JSON.stringify(stable))
      .digest("hex");
    const webhookUrlSha256 = createHash("sha256")
      .update(
        `https://paperclip.example/api/chat-webhooks/${endpoint.publicId}/telegram`,
      )
      .digest("hex");
    const generation = Number(
      (endpoint.setup as Record<string, unknown>).runtimeGeneration ?? 0,
    );
    await db
      .insert(chatActions)
      .values({
        companyId: fixture.companyId,
        endpointId: fixture.endpointId,
        kind: "telegram_stop_subscription",
        providerActionId: `telegram-stop-subscription:${generation}:${credentialFingerprint}:${webhookUrlSha256}`,
        payload: {
          version: 1,
          botUserId: endpoint.botExternalId,
          runtimeGeneration: generation,
          credentialFingerprint,
          webhookUrlSha256,
        },
        status: "processed",
        result: { code: "telegram_stop_subscription_confirmed" },
      })
      .onConflictDoNothing({
        target: [
          chatActions.endpointId,
          chatActions.providerActionId,
        ],
      });
  }

  it("delivers the status via the provider runtime and edits it in place from queued to working (U1 delivery)", async () => {
    process.env[TELEGRAM_DM_STATUS_ENV] = "true";
    const fixture = await seedBridgedConversation();
    await seedTelegramStopSubscriptionReceipt(fixture);
    // seedBridgedConversation built the service through createService(); the
    // endpoint runtime it registered is the FakeChatSdkRuntime of that call.
    const service = [...fixtureServices].at(-1);
    if (!service) throw new Error("Expected a fixture chat channel service");
    const serviceRuntime = service.runtime as unknown as FakeChatSdkRuntime;
    const providerRuntime = serviceRuntime.endpoints.get(fixture.endpointId);
    if (!providerRuntime) throw new Error("Expected Telegram provider runtime");
    // The seeding DM leaves one delivered-inbound notice behind; drop it so
    // the counts below observe only the status lane's provider traffic.
    providerRuntime.posts.length = 0;
    providerRuntime.edits.length = 0;
    providerRuntime.postedIds.length = 0;

    const runId = await insertRun(fixture, { status: "queued" });
    await enqueueChatRunMilestones(db);
    await service.processPendingPublications(1_000);

    // One provider message for the whole status lane, not a stack.
    expect(providerRuntime.posts).toHaveLength(1);
    expect(providerRuntime.posts[0]!.message).toMatchObject({
      markdown: expect.stringContaining("queued"),
    });
    const postedThreadId = providerRuntime.posts[0]!.threadId;
    const postedMessageId = providerRuntime.postedIds[0]!;

    await db
      .update(heartbeatRuns)
      .set({ status: "running", startedAt: new Date() })
      .where(eq(heartbeatRuns.id, runId));
    await enqueueChatRunMilestones(db);
    await service.processPendingPublications(1_000);

    // The working milestone edits the same provider message in place: the
    // fake runtime's thread objects are recreated per runtime.thread() call,
    // so the edit lands on a fresh thread double with the SAME thread id and
    // the message id of the earlier post.
    expect(providerRuntime.posts).toHaveLength(1);
    expect(providerRuntime.edits).toHaveLength(1);
    expect(providerRuntime.edits[0]!.threadId).toBe(postedThreadId);
    expect(providerRuntime.edits[0]!.messageId).toBe(postedMessageId);
    expect(
      String((providerRuntime.edits[0]!.message as { markdown?: unknown }).markdown),
    ).toContain("working");
  });

  it("splits a long structured answer inline when MYRMIDON_TELEGRAM_SPLIT_MAX_PARTS admits it (U1 delivery)", async () => {
    process.env[TELEGRAM_DM_STATUS_ENV] = "true";
    process.env[TELEGRAM_SPLIT_MAX_PARTS_ENV] = "6";
    const fixture = await seedBridgedConversation();
    const service = [...fixtureServices].at(-1);
    if (!service) throw new Error("Expected a fixture chat channel service");
    const serviceRuntime = service.runtime as unknown as FakeChatSdkRuntime;
    const providerRuntime = serviceRuntime.endpoints.get(fixture.endpointId);
    if (!providerRuntime) throw new Error("Expected Telegram provider runtime");

    // The same shape the vendor's integration suite uses for its attachment
    // case: heading + link + fenced code + long list.
    const source = [
      "## Complete result",
      "[Open the evidence](https://example.test/evidence?case=telegram)",
      "```ts",
      ...Array.from({ length: 250 }, () => "const value = 1;"),
      "```",
      ...Array.from({ length: 100 }, (_v, index) => `- Finding ${index}`),
    ].join("\n\n");
    const providerSafeSource = projectSafeChatPublicationText(source);
    // The vendor would send this as one attachment file.
    expect(telegramMarkdownRequiresAttachment(providerSafeSource)).toBe(true);
    const parts = splitTelegramPublicationText(providerSafeSource);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.length).toBeLessThanOrEqual(6);
    expect(parts.join("")).toBe(providerSafeSource);

    await db.insert(chatPublications).values({
      companyId: fixture.companyId,
      endpointId: fixture.endpointId,
      conversationId: fixture.conversationId,
      issueId: fixture.issueId,
      commentId: null,
      idempotencyKey: `test-split:${randomUUID()}`,
      payload: { text: providerSafeSource },
      state: "pending",
    });
    await service.processPendingPublications(1_000);

    // Inline parts, not one attachment file: every post is text-only and the
    // parts concatenate back to the source without losses.
    expect(providerRuntime.posts.length).toBe(parts.length);
    for (const post of providerRuntime.posts) {
      const message = post.message as { markdown?: unknown; attachments?: unknown };
      expect(message.attachments).toBeUndefined();
    }
    const delivered = providerRuntime.posts
      .map((post) => String((post.message as { markdown?: unknown }).markdown))
      .join("");
    expect(delivered).toBe(providerSafeSource);
  });
});
