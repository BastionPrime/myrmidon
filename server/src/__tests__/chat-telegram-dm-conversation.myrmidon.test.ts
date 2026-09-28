// myrmidon(X8b): integration coverage for the Telegram-DM-as-Agent-Chat
// bridge. Helper functions in the first half of this file (the fakes, thread/
// message builders, company/service fixtures) are copied and trimmed from
// the vendor's server/src/__tests__/chat-channels.integration.test.ts (that
// file is not edited — see docs/myrmidon/CONVENTIONS.md §7). The bridge's own
// logic (decideTelegramDmBinding and the identity helpers) has pure-function
// coverage in server/src/myrmidon/agent-chat-bridge/bridge.myrmidon.test.ts.
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  agents,
  agentWakeupRequests,
  authUsers,
  chatActions,
  chatConversations,
  chatDeliveries,
  chatEndpoints,
  chatExternalPrincipals,
  chatIdentityLinks,
  chatPublications,
  companies,
  companyMemberships,
  createDb,
  issueComments,
  issueTreeHolds,
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
  ChatSdkEndpointRuntime,
  CreateChatSdkEndpointRuntimeOptions,
  ChatSdkMessageTrigger,
  ChatSdkRuntime,
} from "../services/chat-sdk-runtime.js";
import type { TelegramDraftControl } from "../services/chat-telegram-draft-stop.js";
import {
  githubAttachmentLocator,
  rehydrateGitHubPublicAttachment,
} from "../services/chat-github-attachments.js";
import { issueService } from "../services/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { telegramConversationUserId } from "../myrmidon/agent-chat-bridge/identity.js";
import { TELEGRAM_DM_CONVERSATIONS_ENV } from "../myrmidon/agent-chat-bridge/settings.js";

// The bridge only depends on the command module's contract (parseBridgedCommand
// stays real); this spies on the dispatcher so a couple of scenarios can drive
// its reply/message result kinds without needing X8c's command bodies.
vi.mock("../myrmidon/agent-chat-bridge/commands/index.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../myrmidon/agent-chat-bridge/commands/index.js")>();
  return {
    ...actual,
    runBridgedDirectMessageCommand: vi.fn(actual.runBridgedDirectMessageCommand),
  };
});

import { runBridgedDirectMessageCommand } from "../myrmidon/agent-chat-bridge/commands/index.js";
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

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Telegram DM conversation bridge tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type TestDb = ReturnType<typeof createDb>;

class FakeEndpointRuntime {
  readonly initialize = vi.fn(async () => {
    await this.initializeHook?.(this.options.endpointId);
  });
  readonly shutdown = vi.fn(async () => undefined);
  readonly posts: Array<{
    threadId: string;
    text: string;
    attachments?: unknown[];
    chunks?: string[];
    files?: unknown[];
  }> = [];
  readonly edits: Array<{
    threadId: string;
    messageId: string;
    text: string;
  }> = [];
  readonly editAttempts: Array<{
    threadId: string;
    messageId: string;
  }> = [];
  readonly reactions: Array<{
    threadId: string;
    messageId: string;
    emoji: string;
  }> = [];
  readonly reactionErrors: Error[] = [];
  readonly removedReactions: Array<{
    threadId: string;
    messageId: string;
    emoji: string;
  }> = [];
  readonly removeReactionErrors: Error[] = [];
  readonly rehydratedAttachmentDescriptors: unknown[] = [];
  readonly postResultIds: string[] = [];
  readonly slackFileReceiptLookups: Array<{
    fileIds: string[];
    threadId: string;
  }> = [];
  readonly slackFileReceiptResultIds: Array<string | null> = [];
  slackFileReceiptCaptureRepeats = 1;
  slackFilePublicationAttempts = 0;
  slackFilePostAcceptanceError: Error | null = null;
  slackFilePostAcceptanceHook: (() => Promise<void>) | undefined;
  slackFileReceiptHook: (() => Promise<void>) | undefined;
  readonly ensuredDiscordRootThreads: Array<{
    channelId: string;
    content: string;
    messageId: string;
  }> = [];
  readonly recordedMicrosoftTeamsRoutes: Array<{
    threadId: string;
    serviceUrl: unknown;
  }> = [];
  private nextPostId = 0;
  postError: Error | null = null;
  editError: Error | null = null;
  postHook: (() => Promise<void>) | undefined;
  webhookHook: ((request: Request) => Promise<void>) | undefined;
  webhookRequest: Request | null = null;
  webhookResponse = new Response("accepted", {
    status: 202,
    headers: { "x-chat-test": "accepted" },
  });

  constructor(
    private readonly options: CreateChatSdkEndpointRuntimeOptions,
    private readonly attachmentBodies: Map<string, Buffer>,
    private readonly initializeHook?: (endpointId: string) => Promise<void>,
  ) {}

  get provider() {
    return this.options.providerConfig.provider;
  }

  async handleWebhook(request: Request) {
    this.webhookRequest = request;
    await this.webhookHook?.(request);
    return this.webhookResponse;
  }

  async ensureDiscordRootThread(input: {
    channelId: string;
    content: string;
    messageId: string;
  }) {
    this.ensuredDiscordRootThreads.push(input);
  }

  async recordMicrosoftTeamsRoute(threadId: string, serviceUrl: unknown) {
    this.recordedMicrosoftTeamsRoutes.push({ threadId, serviceUrl });
  }

  async postSlackFilePublication(
    threadId: string,
    message: unknown,
    onUploadAccepted: (receipt: {
      version: 1;
      channelId: string;
      fileIds: string[];
      threadTs: string | null;
    }) => Promise<void>,
  ) {
    this.slackFilePublicationAttempts += 1;
    await this.postHook?.();
    if (this.postError) throw this.postError;
    const parts = threadId.split(":");
    const files =
      message &&
      typeof message === "object" &&
      "files" in message &&
      Array.isArray((message as { files?: unknown }).files)
        ? (message as { files: unknown[] }).files
        : [];
    for (
      let attempt = 0;
      attempt < this.slackFileReceiptCaptureRepeats;
      attempt += 1
    ) {
      await onUploadAccepted({
        version: 1,
        channelId: parts[1] ?? "",
        fileIds: files.map((_, index) => `FTEST${index + 1}`),
        threadTs: parts[2] || null,
      });
    }
    await this.slackFilePostAcceptanceHook?.();
    if (this.slackFilePostAcceptanceError) {
      throw this.slackFilePostAcceptanceError;
    }
    const postHook = this.postHook;
    this.postHook = undefined;
    try {
      return await this.thread(threadId).post(message);
    } finally {
      this.postHook = postHook;
    }
  }

  async resolveSlackFileUploadReceipt(threadId: string, fileIds: string[]) {
    this.slackFileReceiptLookups.push({
      fileIds: [...fileIds],
      threadId,
    });
    await this.slackFileReceiptHook?.();
    return this.slackFileReceiptResultIds.shift() ?? null;
  }

  acceptsProviderScope(raw: unknown) {
    if (this.options.providerConfig.provider !== "microsoft-teams") return true;
    const expected = this.options.providerConfig.credentials.appTenantId;
    if (!expected || !raw || typeof raw !== "object") return Boolean(!expected);
    const payload = raw as {
      conversation?: { tenantId?: unknown };
      channelData?: { tenant?: { id?: unknown } };
      recipient?: { isTargeted?: unknown };
    };
    if (payload.recipient?.isTargeted === true) return false;
    const tenantIds = [
      payload.conversation?.tenantId,
      payload.channelData?.tenant?.id,
    ].filter((value): value is string => typeof value === "string");
    return (
      tenantIds.length > 0 && tenantIds.every((value) => value === expected)
    );
  }

  async applySlackReceiptReaction(input: {
    operation: "add" | "remove";
    threadId: string;
    messageId: string;
    reaction: "eyes";
  }) {
    const adapter = this.thread(input.threadId).adapter;
    if (input.operation === "add")
      await adapter.addReaction(
        input.threadId,
        input.messageId,
        input.reaction,
      );
    else
      await adapter.removeReaction(
        input.threadId,
        input.messageId,
        input.reaction,
      );
  }

  async applyGitHubReceiptReaction(
    input: Parameters<ChatSdkEndpointRuntime["applyGitHubReceiptReaction"]>[0],
    assertCurrent: () => Promise<void>,
  ) {
    await assertCurrent();
    await this.applySlackReceiptReaction(input);
    return input.githubReceipt ?? { botUserId: "9001", reactionId: "880012" };
  }

  async streamTelegramDraft(
    threadId: string,
    stream: AsyncIterable<string>,
    control: TelegramDraftControl,
  ) {
    if (!(await control.beforeDraft()) || !(await control.beforeFinal()))
      return { paperclipDraftStopped: true as const };
    return this.thread(threadId).post(stream);
  }

  thread(threadId: string) {
    const parts = threadId.split(":");
    const channelId =
      this.options.providerConfig.provider === "discord"
        ? (parts[2] ?? threadId)
        : (parts[1] ?? threadId);
    const isTelegramDirectMessage =
      this.options.providerConfig.provider === "telegram" &&
      /^\d+$/.test(channelId);
    return {
      id: threadId,
      channelId,
      isDM: isTelegramDirectMessage || /^D[A-Z0-9-]*$/i.test(channelId),
      channel: {
        id: channelId,
        name: "command-thread",
      },
      adapter: {
        addReaction: async (
          reactionThreadId: string,
          messageId: string,
          emoji: string,
        ) => {
          const error = this.reactionErrors.shift();
          if (error) throw error;
          this.reactions.push({
            threadId: reactionThreadId,
            messageId,
            emoji,
          });
        },
        removeReaction: async (
          reactionThreadId: string,
          messageId: string,
          emoji: string,
        ) => {
          const error = this.removeReactionErrors.shift();
          if (error) throw error;
          this.removedReactions.push({
            threadId: reactionThreadId,
            messageId,
            emoji,
          });
        },
        editMessage: async (
          editedThreadId: string,
          messageId: string,
          editedMessage: unknown,
        ) => {
          this.editAttempts.push({ threadId: editedThreadId, messageId });
          if (this.editError) throw this.editError;
          if (this.postError) throw this.postError;
          const text =
            editedMessage &&
            typeof editedMessage === "object" &&
            "markdown" in editedMessage
              ? String((editedMessage as { markdown: unknown }).markdown)
              : JSON.stringify(editedMessage);
          this.edits.push({
            threadId: editedThreadId,
            messageId,
            text,
          });
          return { id: messageId, threadId: editedThreadId };
        },
      },
      startTyping: async () => undefined,
      subscribe: async () => undefined,
      post: async (message: unknown) => {
        await this.postHook?.();
        if (this.postError) throw this.postError;
        let text: string;
        let attachments: unknown[] | undefined;
        let chunks: string[] | undefined;
        let files: unknown[] | undefined;
        if (typeof message === "string") text = message;
        else if (
          message &&
          typeof message === "object" &&
          Symbol.asyncIterator in message
        ) {
          chunks = [];
          for await (const chunk of message as AsyncIterable<unknown>)
            chunks.push(String(chunk));
          text = chunks.join("");
        } else if (
          message &&
          typeof message === "object" &&
          "markdown" in message
        ) {
          text = String((message as { markdown: unknown }).markdown);
        } else text = JSON.stringify(message);
        if (
          message &&
          typeof message === "object" &&
          "attachments" in message &&
          Array.isArray((message as { attachments?: unknown }).attachments)
        ) {
          attachments = (message as { attachments: unknown[] }).attachments;
        }
        if (
          message &&
          typeof message === "object" &&
          "files" in message &&
          Array.isArray((message as { files?: unknown }).files)
        ) {
          files = (message as { files: unknown[] }).files;
        }
        this.posts.push({
          threadId,
          text,
          ...(attachments ? { attachments } : {}),
          ...(chunks ? { chunks } : {}),
          ...(files ? { files } : {}),
        });
        this.nextPostId += 1;
        return {
          id: this.postResultIds.shift() ?? `outbound-${this.nextPostId}`,
          threadId,
        };
      },
    };
  }

  attachmentRecoveryDescriptor(attachment: Attachment) {
    if (this.options.providerConfig.provider === "github") {
      const locator = githubAttachmentLocator(attachment);
      return locator
        ? {
            version: 1,
            provider: "github",
            attachment: { type: attachment.type, name: attachment.name },
            locator,
          }
        : null;
    }
    const recoveryKey = attachment.fetchMetadata?.testRecoveryKey;
    if (typeof recoveryKey !== "string") return null;
    return {
      version: 1,
      provider: this.options.providerConfig.provider,
      attachment: {
        type: attachment.type,
        name: attachment.name,
        mimeType: attachment.mimeType,
        size: attachment.size,
      },
      locator: { kind: "test_attachment", recoveryKey },
    };
  }

  parseTelegramCommandMessage(raw: unknown): Message | null {
    if (
      this.options.providerConfig.provider !== "telegram" ||
      !raw ||
      typeof raw !== "object"
    )
      return null;
    const document = (raw as { document?: Record<string, unknown> }).document;
    const recoveryKey =
      typeof document?.file_id === "string" ? document.file_id : null;
    if (!recoveryKey) return null;
    return makeMessage({
      id: `telegram-command:${recoveryKey}`,
      text: "",
      attachments: [
        {
          type: "file",
          name:
            typeof document.file_name === "string"
              ? document.file_name
              : undefined,
          mimeType:
            typeof document.mime_type === "string"
              ? document.mime_type
              : undefined,
          size:
            typeof document.file_size === "number"
              ? document.file_size
              : undefined,
          fetchMetadata: { testRecoveryKey: recoveryKey },
        } as Attachment,
      ],
    });
  }

  parseMicrosoftTeamsMessage(raw: unknown): Message | null {
    if (
      this.options.providerConfig.provider !== "microsoft-teams" ||
      !raw ||
      typeof raw !== "object"
    )
      return null;
    const activity = raw as {
      conversation?: { conversationType?: unknown; id?: unknown };
      from?: { aadObjectId?: unknown; id?: unknown; name?: unknown };
      id?: unknown;
      serviceUrl?: unknown;
      text?: unknown;
    };
    if (
      typeof activity.id !== "string" ||
      typeof activity.conversation?.id !== "string" ||
      typeof activity.serviceUrl !== "string"
    )
      return null;
    const conversationType = activity.conversation.conversationType;
    const legacyIsDM = !activity.conversation.id.startsWith("19:");
    const explicitIsDM = conversationType === "personal";
    const includeConversationType =
      (conversationType === "channel" ||
        conversationType === "groupChat" ||
        conversationType === "personal") &&
      explicitIsDM !== legacyIsDM;
    const threadId = [
      "teams",
      Buffer.from(activity.conversation.id).toString("base64url"),
      ...(includeConversationType ? [conversationType] : []),
    ].join(":");
    const userId =
      typeof activity.from?.id === "string" ? activity.from.id : "unknown";
    const userName =
      typeof activity.from?.name === "string" ? activity.from.name : userId;
    return {
      ...makeMessage({
        id: activity.id,
        raw,
        text: typeof activity.text === "string" ? activity.text : "",
        userId,
        userName,
      }),
      threadId,
    } as Message;
  }

  rehydrateAttachment(
    descriptor: unknown,
    source?: { threadId: string; messageId: string },
  ): Attachment | null {
    this.rehydratedAttachmentDescriptors.push(descriptor);
    if (!descriptor || typeof descriptor !== "object") return null;
    const value = descriptor as {
      version?: unknown;
      provider?: unknown;
      attachment?: Attachment;
      locator?: { kind?: unknown; recoveryKey?: unknown };
    };
    if (
      this.options.providerConfig.provider === "github" &&
      value.provider === "github" &&
      value.version === 1 &&
      source
    ) {
      return rehydrateGitHubPublicAttachment(value.locator, source);
    }
    if (
      value.version !== 1 ||
      value.provider !== this.options.providerConfig.provider ||
      value.locator?.kind !== "test_attachment" ||
      typeof value.locator.recoveryKey !== "string" ||
      !value.attachment
    ) {
      return null;
    }
    const body = this.attachmentBodies.get(value.locator.recoveryKey);
    if (!body) return null;
    return {
      ...value.attachment,
      fetchData: async () => body,
      fetchMetadata: { testRecoveryKey: value.locator.recoveryKey },
    } as Attachment;
  }

  async resolveGitHubAttachmentComment(
    _request: { url: string; accept: string },
    _signal: AbortSignal,
  ): Promise<unknown> {
    return null;
  }
}

class FakeChatSdkRuntime {
  readonly endpoints = new Map<string, FakeEndpointRuntime>();
  readonly configurations = new Map<
    string,
    CreateChatSdkEndpointRuntimeOptions
  >();
  initializeHook: ((endpointId: string) => Promise<void>) | undefined;
  replaceCount = 0;

  constructor(readonly attachmentBodies: Map<string, Buffer> = new Map()) {}

  get(endpointId: string) {
    return this.endpoints.get(endpointId) ?? null;
  }

  async replaceEndpoint(options: CreateChatSdkEndpointRuntimeOptions) {
    this.replaceCount += 1;
    this.configurations.set(options.endpointId, options);
    const endpoint = new FakeEndpointRuntime(
      options,
      this.attachmentBodies,
      this.initializeHook,
    );
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
  const addReaction = vi.fn(async () => undefined);
  const startTyping = vi.fn(async () => undefined);
  const subscribe = vi.fn(async () => undefined);
  const postEphemeral = vi.fn(async () => ({
    id: `thread-ephemeral-${randomUUID()}`,
    threadId: input.id,
    usedFallback: false,
  }));
  const post = vi.fn(async () => ({
    id: `thread-post-${randomUUID()}`,
    threadId: input.id,
  }));
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
  return {
    thread,
    addReaction,
    startTyping,
    subscribe,
    post,
    postEphemeral,
  };
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

describeEmbeddedPostgres("Telegram direct messages become a standing Agent Chat conversation (X8b)", () => {
  let db!: TestDb;
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(
    os.tmpdir(),
    `paperclip-chat-channels-${randomUUID()}`,
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
        "paperclip-chat-channels-",
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

  // Services scan this file's shared database. Retire each case's fixtures
  // after its assertions so another case (or shard order) cannot claim them.
  const fixtureCompanies = new Set<string>();
  const fixtureServices = new Set<ChatChannelService>();
  afterEach(async () => {
    try {
      await Promise.all([...fixtureServices].map((service) => service.shutdown()));
    } finally {
      if (fixtureCompanies.size > 0) {
        await db.update(chatEndpoints).set({ status: "paused" })
          .where(and(inArray(chatEndpoints.companyId, [...fixtureCompanies]), eq(chatEndpoints.status, "active")));
        // The milestone scanner also considers paused endpoints while their
        // conversations are active. Retire those bindings after assertions.
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
    const replacementAgentId = randomUUID();
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
        id: replacementAgentId,
        companyId,
        name: "Linus",
        role: "engineer",
        status: "idle",
        adapterType: "paperclip_runner",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    return { companyId, assignedAgentId, replacementAgentId };
  }

  // A truthy return is not a durable scheduler receipt. These transport tests
  // record the same exact receipt identity; real scheduling/coalescing is
  // separately exercised by durable-chat-wakeup.test.ts against heartbeat.
  function receiptBackedWakeup(
    wakeup: ChatChannelServiceOptions["heartbeat"]["wakeup"],
  ): ChatChannelServiceOptions["heartbeat"]["wakeup"] {
    return async (agentId, opts) => {
      const result = await wakeup(agentId, opts);
      const request = opts.durableChatRequest;
      if (request && result !== null && result !== undefined) {
        const [existing] = await db
          .select({ id: agentWakeupRequests.id })
          .from(agentWakeupRequests)
          .where(eq(agentWakeupRequests.id, request.id));
        if (existing) return result;
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
      return result;
    };
  }

  function createService(
    runtime = new FakeChatSdkRuntime(),
    providerFetch: typeof globalThis.fetch = fakeTelegramFetch() as typeof globalThis.fetch,
    overrides: Partial<
      Pick<
        ChatChannelServiceOptions,
        | "credentialMutationLeaseRenewalIntervalMs"
        | "deferWebhookProcessing"
        | "discordGatewayEventBarrier"
        | "discordGatewayMessageAdmissionBarrier"
        | "discordRootThreadTransportBarrier"
        | "discordGatewayLeaseRenewalIntervalMs"
        | "discordGatewayLeaseTtlMs"
        | "discordGatewayLeaseWaitMs"
        | "githubWebhookAuthenticationBarrier"
        | "githubWebhookReplayBarrier"
        | "githubWebhookResponseBudgetMs"
        | "publicBaseUrl"
        | "webhookPublicBaseUrl"
        | "nativeBotIdentityClaimBarrier"
        | "confirmationResolutionPersistBarrier"
        | "conversationLeaseRenewalIntervalMs"
        | "questionFormOpenAuthorizationBarrier"
        | "questionResolutionPersistBarrier"
        | "reactionLinkPreflightBarrier"
        | "reactionReplayConversationLockBarrier"
        | "reactionReplayEndpointLockBarrier"
        | "receiptReactionTransportBarrier"
        | "resolveNativeQuestion"
        | "renewCredentialMutationLease"
        | "renewConversationDeliveryLease"
        | "renewDiscordGatewayLease"
        | "scheduleDeferredWork"
        | "slackTaskAdmissionClaimBarrier"
        | "slackSessionSyncSelectionBarrier"
        | "setupSecretActivityLogger"
        | "setupSecretCredentialPersistBarrier"
        | "setupSecretFinalOwnershipBarrier"
        | "setupTestActivationBarrier"
        | "storage"
        | "reachAuthorizationBarrier"
      >
    > & {
      cancelRun?: NonNullable<
        ChatChannelServiceOptions["heartbeat"]["cancelRun"]
      >;
      wakeup?: ChatChannelServiceOptions["heartbeat"]["wakeup"];
    } = {},
  ) {
    const {
      cancelRun: cancelRunOverride,
      wakeup: wakeupOverride,
      ...serviceOverrides
    } = overrides;
    const wakeup = vi.fn(wakeupOverride ?? (async () => ({ accepted: true })));
    const cancelRun = vi.fn(
      cancelRunOverride ?? (async () => ({ status: "cancelled" })),
    );
    const service = chatChannelService(db, {
      fetch: providerFetch,
      heartbeat: { cancelRun, wakeup: receiptBackedWakeup(wakeup) },
      publicBaseUrl: "https://paperclip.example",
      runtime: runtime as unknown as ChatSdkRuntime,
      ...serviceOverrides,
    });
    fixtureServices.add(service);
    return { cancelRun, runtime, service, wakeup };
  }
  async function configuredTelegramEndpoint(
    fixture: Awaited<ReturnType<typeof seedCompany>>,
    overrides: Parameters<typeof createService>[2] = {},
  ) {
    const context = createService(
      new FakeChatSdkRuntime(),
      fakeTelegramFetch() as typeof globalThis.fetch,
      overrides,
    );
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
        credentials: { botToken: "123456:telegram-interaction-test" },
      },
      "owner-user",
    );
    const callbacks = context.runtime.configurations.get(
      endpoint.id,
    )?.callbacks;
    if (!callbacks)
      throw new Error("Fake runtime did not receive Telegram callbacks");
    return { ...context, endpoint, callbacks };
  }
  async function deliverMessage(input: {
    callbacks: CreateChatSdkEndpointRuntimeOptions["callbacks"];
    endpointId: string;
    message: Message;
    provider?: ChatProvider;
    providerUpdateId?: number;
    thread: Thread;
    trigger: ChatSdkMessageTrigger;
  }) {
    await input.callbacks.onMessage({
      endpointId: input.endpointId,
      provider: input.provider ?? "slack",
      providerUpdateId: input.providerUpdateId,
      thread: input.thread,
      message: input.message,
      trigger: input.trigger,
    });
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

  function telegramDm(input: { channelId: string; id?: string }) {
    return makeThread({
      channelId: input.channelId,
      id: input.id ?? `telegram:${input.channelId}`,
      isDM: true,
      name: "Telegram direct message",
    });
  }

  async function sendTelegramDm(input: {
    callbacks: CreateChatSdkEndpointRuntimeOptions["callbacks"];
    endpointId: string;
    channelId: string;
    text: string;
    userId: string;
    messageId: number;
  }) {
    const { thread, post } = telegramDm({ channelId: input.channelId });
    await deliverMessage({
      callbacks: input.callbacks,
      endpointId: input.endpointId,
      provider: "telegram",
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
      trigger: "direct_message",
    });
    // myrmidon(X8b): the delivered message's own thread double is what a
    // safe-notice provider effect posts to (chat-channels.ts passes this
    // exact `thread` as `processProviderEffect`'s live target) — distinct
    // from the endpoint runtime's own `thread()` mock, which a webhook
    // delivery never goes through.
    return { post };
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

  const previousDmEnv = process.env[TELEGRAM_DM_CONVERSATIONS_ENV];

  beforeEach(async () => {
    process.env[TELEGRAM_DM_CONVERSATIONS_ENV] = "*";
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
  });

  afterEach(async () => {
    if (previousDmEnv === undefined) delete process.env[TELEGRAM_DM_CONVERSATIONS_ENV];
    else process.env[TELEGRAM_DM_CONVERSATIONS_ENV] = previousDmEnv;
  });

  it("turns a linked person's DM into a standing conversation, not a per-session task", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint } = await configuredTelegramEndpoint(fixture);
    await linkTelegramPrincipal({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      userId: "700001",
      boardUserId: "owner-user",
    });

    await sendTelegramDm({
      callbacks,
      endpointId: endpoint.id,
      channelId: "700001",
      text: "Hello there",
      userId: "700001",
      messageId: 1,
    });

    const expectedConversationUserId = telegramConversationUserId("owner-user");
    const [issue] = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, fixture.companyId),
          eq(issues.conversationUserId, expectedConversationUserId),
        ),
      );
    expect(issue).toBeDefined();
    expect(issue.conversationAgentId).toBe(fixture.assignedAgentId);
    expect(issue.originKind).not.toBe("chat_channel");
    expect(issue.title).toContain("Telegram chat with");

    const noChatChannelTask = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, fixture.companyId),
          eq(issues.originKind, "chat_channel"),
        ),
      );
    expect(noChatChannelTask).toHaveLength(0);

    const [comment] = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, issue.id));
    expect(comment).toBeDefined();
    expect(comment.body).toBe("Hello there");
    expect(comment.clientRequestId).toBeNull();

    const conversation = await conversationRow(endpoint.id, "700001");
    expect(conversation).toMatchObject({ issueId: issue.id, isDirectMessage: true, state: "active" });

    const delivery = await db
      .select()
      .from(chatDeliveries)
      .where(eq(chatDeliveries.endpointId, endpoint.id));
    expect(delivery.every((row) => row.state === "processed")).toBe(true);

    // A second message continues the same task, not a new one.
    await sendTelegramDm({
      callbacks,
      endpointId: endpoint.id,
      channelId: "700001",
      text: "Second message",
      userId: "700001",
      messageId: 2,
    });
    const conversationAfter = await conversationRow(endpoint.id, "700001");
    expect(conversationAfter!.id).toBe(conversation!.id);
    expect(conversationAfter!.issueId).toBe(issue.id);
    const commentsAfter = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, issue.id));
    expect(commentsAfter).toHaveLength(2);
  });

  it("leaves a separate web Agent Chat conversation for the same person untouched", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint } = await configuredTelegramEndpoint(fixture);
    await linkTelegramPrincipal({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      userId: "700002",
      boardUserId: "owner-user",
    });
    const webIssue = await issueService(db).create(fixture.companyId, {
      title: `Chat with ${fixture.assignedAgentId}`,
      assigneeAgentId: fixture.assignedAgentId,
      conversationAgentId: fixture.assignedAgentId,
      conversationUserId: "owner-user",
      conversationState: "waiting",
      status: "in_review",
      createdByUserId: "owner-user",
    });

    await sendTelegramDm({
      callbacks,
      endpointId: endpoint.id,
      channelId: "700002",
      text: "Telegram-only message",
      userId: "700002",
      messageId: 1,
    });

    const webComments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, webIssue.id));
    expect(webComments).toHaveLength(0);

    const telegramIssue = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, fixture.companyId),
          eq(issues.conversationUserId, telegramConversationUserId("owner-user")),
        ),
      )
      .then((rows) => rows[0]);
    expect(telegramIssue.id).not.toBe(webIssue.id);
  });

  it("follows the vendor path when the flag is off", async () => {
    delete process.env[TELEGRAM_DM_CONVERSATIONS_ENV];
    const fixture = await seedCompany();
    const { callbacks, endpoint } = await configuredTelegramEndpoint(fixture);
    await linkTelegramPrincipal({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      userId: "700003",
      boardUserId: "owner-user",
    });

    await sendTelegramDm({
      callbacks,
      endpointId: endpoint.id,
      channelId: "700003",
      text: "Vendor path please",
      userId: "700003",
      messageId: 1,
    });

    const telegramConversations = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, fixture.companyId),
          eq(issues.conversationUserId, telegramConversationUserId("owner-user")),
        ),
      );
    expect(telegramConversations).toHaveLength(0);
    const chatChannelTasks = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, fixture.companyId), eq(issues.originKind, "chat_channel")));
    expect(chatChannelTasks).toHaveLength(1);
  });

  it("follows the vendor path, without an infinite retry, when Agent Chat is disabled instance-wide", async () => {
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: false });
    const fixture = await seedCompany();
    const { callbacks, endpoint } = await configuredTelegramEndpoint(fixture);
    await linkTelegramPrincipal({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      userId: "700004",
      boardUserId: "owner-user",
    });

    await sendTelegramDm({
      callbacks,
      endpointId: endpoint.id,
      channelId: "700004",
      text: "Agent Chat is off",
      userId: "700004",
      messageId: 1,
    });

    const chatChannelTasks = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, fixture.companyId), eq(issues.originKind, "chat_channel")));
    expect(chatChannelTasks).toHaveLength(1);
    const delivery = await db
      .select()
      .from(chatDeliveries)
      .where(eq(chatDeliveries.endpointId, endpoint.id));
    // "processed" (not stuck retrying "issued") is the F19 assertion: the
    // bridge detaches instead of looping while enableAgentChat is off.
    expect(delivery.every((row) => row.state === "processed")).toBe(true);
  });

  it("migrates off an existing open chat_channel task, leaving it untouched, with one notice", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint } = await configuredTelegramEndpoint(fixture);
    await linkTelegramPrincipal({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      userId: "700005",
      boardUserId: "owner-user",
    });

    // First, the flag is off: the vendor creates its usual per-session task.
    delete process.env[TELEGRAM_DM_CONVERSATIONS_ENV];
    await sendTelegramDm({
      callbacks,
      endpointId: endpoint.id,
      channelId: "700005",
      text: "Old-style first message",
      userId: "700005",
      messageId: 1,
    });
    const [oldIssue] = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, fixture.companyId), eq(issues.originKind, "chat_channel")));
    expect(oldIssue).toBeDefined();
    const oldConversation = await conversationRow(endpoint.id, "700005");
    expect(oldConversation?.state).toBe("active");
    const oldCommentCountBefore = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, oldIssue.id));

    // Now the flag turns on: the next message migrates this thread.
    process.env[TELEGRAM_DM_CONVERSATIONS_ENV] = "*";
    await sendTelegramDm({
      callbacks,
      endpointId: endpoint.id,
      channelId: "700005",
      text: "New-style message",
      userId: "700005",
      messageId: 2,
    });

    const oldConversationAfter = await db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.id, oldConversation!.id))
      .then((rows) => rows[0]);
    expect(oldConversationAfter.state).toBe("completed");
    const oldIssueAfter = await db
      .select()
      .from(issues)
      .where(eq(issues.id, oldIssue.id))
      .then((rows) => rows[0]);
    expect(oldIssueAfter.status).toBe(oldIssue.status);
    const oldCommentCountAfter = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, oldIssue.id));
    expect(oldCommentCountAfter).toHaveLength(oldCommentCountBefore.length);

    const newConversation = await conversationRow(endpoint.id, "700005");
    expect(newConversation!.id).not.toBe(oldConversation!.id);
    expect(newConversation!.sessionGeneration).toBeGreaterThan(oldConversation!.sessionGeneration);

    // The idempotency key is per-delivery, so assert by counting migration
    // notices staged against the new conversation instead of naming one key.
    const notices = await db
      .select()
      .from(chatPublications)
      .where(eq(chatPublications.conversationId, newConversation!.id));
    const migratedNotices = notices.filter((row) =>
      row.idempotencyKey.startsWith("control:x8-migrated:"),
    );
    expect(migratedNotices).toHaveLength(1);
  });

  it("leaves groups and topics on a flagged endpoint to the vendor path", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint } = await configuredTelegramEndpoint(fixture);
    const { thread } = makeThread({
      channelId: "-700006",
      id: "telegram:-700006",
      isDM: false,
      name: "Telegram group",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread,
      message: makeMessage({
        id: "1",
        text: "@bot hello group",
        mentioned: true,
        userId: "700006",
        raw: {
          message_id: 1,
          chat: { id: -700006, type: "group" },
          from: { id: 700006, is_bot: false },
        },
      }),
      trigger: "mention",
    });
    const chatChannelTasks = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, fixture.companyId), eq(issues.originKind, "chat_channel")));
    expect(chatChannelTasks).toHaveLength(1);
    const telegramConversations = await db
      .select()
      .from(issues)
      .where(eq(issues.conversationAgentId, fixture.assignedAgentId));
    expect(telegramConversations).toHaveLength(0);
  });

  it("refuses an unlinked account once a day, without creating a task or comment", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint } = await configuredTelegramEndpoint(fixture);
    // Default endpoints sponsor unlinked senders as low-trust guests; this
    // scenario is specifically the workspace that turned that off (F21/spec #9).
    await db
      .update(chatEndpoints)
      .set({ allowUnlinkedPeople: false })
      .where(eq(chatEndpoints.id, endpoint.id));

    // The refusal notice is deduped per (endpoint, principal, day):
    // `stageProviderEffect` finds the first delivery's row already
    // `processed` on the second and skips posting again, so only the first
    // delivery's own thread double ever receives the `.post()` call.
    const { post: firstPost } = await sendTelegramDm({
      callbacks,
      endpointId: endpoint.id,
      channelId: "700007",
      text: "Let me in",
      userId: "700007",
      messageId: 1,
    });
    await sendTelegramDm({
      callbacks,
      endpointId: endpoint.id,
      channelId: "700007",
      text: "Let me in again",
      userId: "700007",
      messageId: 2,
    });

    const anyIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.companyId, fixture.companyId));
    expect(anyIssues).toHaveLength(0);

    const refusalActions = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, endpoint.id),
          eq(chatActions.kind, "provider_effect"),
        ),
      );
    const refusals = refusalActions.filter((row) =>
      row.providerActionId.startsWith("provider_effect:x8-refusal:"),
    );
    expect(refusals).toHaveLength(1);

    await vi.waitFor(() =>
      expect(
        firstPost.mock.calls.some(([text]) => text.includes("Ask an administrator")),
      ).toBe(true),
    );
  });

  it("keeps a bridged conversation active across a literal /new comment and resumes any hold", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint } = await configuredTelegramEndpoint(fixture);
    await linkTelegramPrincipal({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      userId: "700008",
      boardUserId: "owner-user",
    });
    await sendTelegramDm({
      callbacks,
      endpointId: endpoint.id,
      channelId: "700008",
      text: "First message",
      userId: "700008",
      messageId: 1,
    });
    const conversationBefore = await conversationRow(endpoint.id, "700008");

    await sendTelegramDm({
      callbacks,
      endpointId: endpoint.id,
      channelId: "700008",
      text: "/new",
      userId: "700008",
      messageId: 2,
    });

    const [issue] = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, fixture.companyId),
          eq(issues.conversationUserId, telegramConversationUserId("owner-user")),
        ),
      );
    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, issue.id))
      .orderBy(issueComments.createdAt);
    expect(comments.at(-1)!.body).toBe("/new");

    const newControlPublications = await db
      .select()
      .from(chatPublications)
      .where(eq(chatPublications.conversationId, conversationBefore!.id));
    expect(newControlPublications.filter((row) => row.idempotencyKey.startsWith("control:new:"))).toHaveLength(0);

    const conversationAfter = await conversationRow(endpoint.id, "700008");
    expect(conversationAfter!.id).toBe(conversationBefore!.id);
    expect(conversationAfter!.state).toBe("active");

    // The next message still lands in the same standing conversation.
    await sendTelegramDm({
      callbacks,
      endpointId: endpoint.id,
      channelId: "700008",
      text: "Still the same chat",
      userId: "700008",
      messageId: 3,
    });
    const commentsAfter = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, issue.id));
    expect(commentsAfter).toHaveLength(3);
  });

  it("resumes a held conversation on '/new@bot' the same way as a literal '/new'", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint } = await configuredTelegramEndpoint(fixture);
    await linkTelegramPrincipal({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      userId: "700011",
      boardUserId: "owner-user",
    });
    await sendTelegramDm({
      callbacks,
      endpointId: endpoint.id,
      channelId: "700011",
      text: "First message",
      userId: "700011",
      messageId: 1,
    });
    const conversationBefore = await conversationRow(endpoint.id, "700011");
    const [issue] = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, fixture.companyId),
          eq(issues.conversationUserId, telegramConversationUserId("owner-user")),
        ),
      );

    // A pause hold (the kind `/new` is meant to release) so this scenario can
    // tell a real reset apart from a no-op: without it, an unrecognized
    // "/new@bot" and a correctly normalized one look identical.
    const [hold] = await db
      .insert(issueTreeHolds)
      .values({ companyId: fixture.companyId, rootIssueId: issue.id, mode: "pause" })
      .returning();

    await sendTelegramDm({
      callbacks,
      endpointId: endpoint.id,
      channelId: "700011",
      text: "/new@TestBot",
      userId: "700011",
      messageId: 2,
    });

    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, issue.id))
      .orderBy(issueComments.createdAt);
    // The canonical command dispatcher (commands/index.ts, X8a) already
    // normalizes "/new@<bot>" to a literal "/new" before chat-channels.ts
    // persists the comment, so the stored body is the normalized form, not
    // the sender's literal text (see bridge.ts's own comment on this call
    // site).
    expect(comments.at(-1)!.body).toBe("/new");

    const holdAfter = await db
      .select()
      .from(issueTreeHolds)
      .where(eq(issueTreeHolds.id, hold.id))
      .then((rows) => rows[0]);
    expect(holdAfter.status).toBe("released");

    const conversationAfter = await conversationRow(endpoint.id, "700011");
    expect(conversationAfter!.id).toBe(conversationBefore!.id);
    expect(conversationAfter!.state).toBe("active");
  });

  describe("with a mocked command module", () => {
    it("finishes the turn for a reply-kind command without a comment or wakeup", async () => {
      const fixture = await seedCompany();
      const { callbacks, endpoint, wakeup } = await configuredTelegramEndpoint(fixture);
      await linkTelegramPrincipal({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        userId: "700009",
        boardUserId: "owner-user",
      });
      vi.mocked(runBridgedDirectMessageCommand).mockResolvedValueOnce({
        kind: "reply",
        command: "status",
        text: "Agent: Maya. Model: default.",
      });

      await sendTelegramDm({
        callbacks,
        endpointId: endpoint.id,
        channelId: "700009",
        text: "/status",
        userId: "700009",
        messageId: 1,
      });

      const [issue] = await db
        .select()
        .from(issues)
        .where(
          and(
            eq(issues.companyId, fixture.companyId),
            eq(issues.conversationUserId, telegramConversationUserId("owner-user")),
          ),
        );
      expect(issue).toBeDefined();
      const comments = await db
        .select()
        .from(issueComments)
        .where(eq(issueComments.issueId, issue.id));
      expect(comments).toHaveLength(0);
      expect(wakeup).not.toHaveBeenCalled();

      const conversation = await conversationRow(endpoint.id, "700009");
      const publications = await db
        .select()
        .from(chatPublications)
        .where(eq(chatPublications.conversationId, conversation!.id));
      const statusReplies = publications.filter((row) =>
        row.idempotencyKey.startsWith("control:x8-status:"),
      );
      expect(statusReplies).toHaveLength(1);

      const deliveries = await db
        .select()
        .from(chatDeliveries)
        .where(eq(chatDeliveries.endpointId, endpoint.id));
      expect(deliveries.every((row) => row.state === "processed")).toBe(true);
    });

    it("writes a comment and a notice for a message-kind command result", async () => {
      const fixture = await seedCompany();
      const { callbacks, endpoint } = await configuredTelegramEndpoint(fixture);
      await linkTelegramPrincipal({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        userId: "700010",
        boardUserId: "owner-user",
      });
      vi.mocked(runBridgedDirectMessageCommand).mockResolvedValueOnce({
        kind: "message",
        body: "What should the assistant do about the roadmap?",
        notice: "Switched to gpt-5 for this chat.",
      });

      await sendTelegramDm({
        callbacks,
        endpointId: endpoint.id,
        channelId: "700010",
        text: "/model gpt-5",
        userId: "700010",
        messageId: 1,
      });

      const [issue] = await db
        .select()
        .from(issues)
        .where(
          and(
            eq(issues.companyId, fixture.companyId),
            eq(issues.conversationUserId, telegramConversationUserId("owner-user")),
          ),
        );
      const [comment] = await db
        .select()
        .from(issueComments)
        .where(eq(issueComments.issueId, issue.id));
      expect(comment.body).toBe("What should the assistant do about the roadmap?");

      const conversation = await conversationRow(endpoint.id, "700010");
      const publications = await db
        .select()
        .from(chatPublications)
        .where(eq(chatPublications.conversationId, conversation!.id));
      const notices = publications.filter((row) => row.idempotencyKey.startsWith("control:x8-notice:"));
      expect(notices).toHaveLength(1);
    });

    it("still releases the old binding and sends the migration notice when the migrating thread's first message is a reply-kind command", async () => {
      const fixture = await seedCompany();
      const { callbacks, endpoint } = await configuredTelegramEndpoint(fixture);
      await linkTelegramPrincipal({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        userId: "700012",
        boardUserId: "owner-user",
      });

      // Flag off: the vendor creates its usual per-session task first.
      delete process.env[TELEGRAM_DM_CONVERSATIONS_ENV];
      await sendTelegramDm({
        callbacks,
        endpointId: endpoint.id,
        channelId: "700012",
        text: "Old-style first message",
        userId: "700012",
        messageId: 1,
      });
      const [oldIssue] = await db
        .select()
        .from(issues)
        .where(and(eq(issues.companyId, fixture.companyId), eq(issues.originKind, "chat_channel")));
      const oldConversation = await conversationRow(endpoint.id, "700012");
      expect(oldConversation?.state).toBe("active");

      // Flag on: the thread's first bridged message happens to parse as a
      // recognized command whose result is `reply` — that finishes the whole
      // turn inside handleTelegramDmCommand, before chat-channels.ts ever
      // reaches persistTaskMutation, so the release/migration this
      // transition needs must happen there too (F: reply-first migration).
      process.env[TELEGRAM_DM_CONVERSATIONS_ENV] = "*";
      vi.mocked(runBridgedDirectMessageCommand).mockResolvedValueOnce({
        kind: "reply",
        command: "status",
        text: "Agent: Maya. Model: default.",
      });
      await sendTelegramDm({
        callbacks,
        endpointId: endpoint.id,
        channelId: "700012",
        text: "/status",
        userId: "700012",
        messageId: 2,
      });

      const oldConversationAfter = await db
        .select()
        .from(chatConversations)
        .where(eq(chatConversations.id, oldConversation!.id))
        .then((rows) => rows[0]);
      expect(oldConversationAfter.state).toBe("completed");
      const oldIssueAfter = await db
        .select()
        .from(issues)
        .where(eq(issues.id, oldIssue.id))
        .then((rows) => rows[0]);
      expect(oldIssueAfter.status).toBe(oldIssue.status);

      const newConversation = await conversationRow(endpoint.id, "700012");
      expect(newConversation!.id).not.toBe(oldConversation!.id);

      const publications = await db
        .select()
        .from(chatPublications)
        .where(eq(chatPublications.conversationId, newConversation!.id));
      expect(
        publications.filter((row) => row.idempotencyKey.startsWith("control:x8-status:")),
      ).toHaveLength(1);
      expect(
        publications.filter((row) => row.idempotencyKey.startsWith("control:x8-migrated:")),
      ).toHaveLength(1);
    });
  });
});
