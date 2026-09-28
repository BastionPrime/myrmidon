import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  getEmbeddedPostgresTestSupport,
  principalPermissionGrants,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import {
  chatChannelService,
  type ChatChannelService,
} from "../services/chat-channels.js";
import type {
  ChatSdkRuntime,
  CreateChatSdkEndpointRuntimeOptions,
} from "../services/chat-sdk-runtime.js";
import { TELEGRAM_DM_COMMANDS } from "../myrmidon/agent-chat-bridge/commands/index.js";
import { telegramDmConversationsEnabled } from "../myrmidon/agent-chat-bridge/settings.js";

// myrmidon(X8e): the vendor registers one "no scope" Telegram command menu on
// connect, reconnect, and remove (see "configures Telegram and preserves
// queued updates…" in chat-channels.integration.test.ts, grep setMyCommands).
// This drives that same flow through a minimal Telegram-only double of that
// harness and checks the extra all_private_chats scoped calls the bridge adds
// for endpoints with MYRMIDON_TELEGRAM_DM_CONVERSATIONS enabled.

const externalTestDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;
const embeddedPostgresSupport = externalTestDatabaseUrl
  ? { supported: true }
  : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe.sequential
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Telegram DM command menu tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type TestDb = ReturnType<typeof createDb>;

class FakeEndpointRuntime {
  readonly initialize = vi.fn(async () => undefined);
  readonly shutdown = vi.fn(async () => undefined);
  constructor(
    private readonly options: CreateChatSdkEndpointRuntimeOptions,
  ) {}
  get provider() {
    return this.options.providerConfig.provider;
  }
}

// A minimal double of chat-channels.integration.test.ts's FakeChatSdkRuntime:
// only the four methods the service calls to stand up and tear down a
// Telegram endpoint's runtime. Posting/receiving messages is out of scope
// here; register_commands never touches the runtime at all.
class FakeChatSdkRuntime {
  readonly endpoints = new Map<string, FakeEndpointRuntime>();

  get(endpointId: string) {
    return this.endpoints.get(endpointId) ?? null;
  }

  async replaceEndpoint(options: CreateChatSdkEndpointRuntimeOptions) {
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
      [...this.endpoints.values()].map((endpoint) => endpoint.shutdown()),
    );
    this.endpoints.clear();
  }
}

interface CapturedCommandsCall {
  method: "setMyCommands" | "deleteMyCommands";
  body: Record<string, unknown>;
}

function fakeTelegramFetch(
  captured: CapturedCommandsCall[],
  botId = Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 12), 16),
) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
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
    if (url.endsWith("/setWebhook") || url.endsWith("/deleteWebhook")) {
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/setMyCommands") || url.endsWith("/deleteMyCommands")) {
      const method = url.endsWith("/setMyCommands")
        ? "setMyCommands"
        : "deleteMyCommands";
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<
        string,
        unknown
      >;
      captured.push({ method, body });
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected provider request: ${url}`);
  }) as unknown as typeof globalThis.fetch;
}

describeEmbeddedPostgres("Telegram bridged DM command menu (X8e)", () => {
  let db!: TestDb;
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(
    os.tmpdir(),
    `paperclip-dm-menu-${randomUUID()}`,
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
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dm-menu-");
      db = createDb(tempDb.connectionString);
    }
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    if (previousKeyFile === undefined) {
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    } else {
      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    }
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  const fixtureServices: ChatChannelService[] = [];
  afterEach(async () => {
    await Promise.all(
      fixtureServices.splice(0).map((service) => service.shutdown()),
    );
    vi.unstubAllEnvs();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const assignedAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `DM Menu Test ${companyId.slice(0, 8)}`,
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
      name: "Maya",
      role: "engineer",
      status: "idle",
      adapterType: "paperclip_runner",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, assignedAgentId };
  }

  function createService(providerFetch: typeof globalThis.fetch) {
    const service = chatChannelService(db, {
      fetch: providerFetch,
      heartbeat: { wakeup: async () => ({ accepted: true }) },
      publicBaseUrl: "https://paperclip.example",
      runtime: new FakeChatSdkRuntime() as unknown as ChatSdkRuntime,
    });
    fixtureServices.push(service);
    return service;
  }

  async function connectTelegramEndpoint(
    providerFetch: typeof globalThis.fetch,
  ) {
    const { companyId, assignedAgentId } = await seedCompany();
    const service = createService(providerFetch);
    const endpoint = await service.create(
      companyId,
      { provider: "telegram", assignedAgentId },
      "owner-user",
    );
    await service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: { botToken: "123456:dm-menu-test-token" },
      },
      "owner-user",
    );
    return { endpoint, service };
  }

  it("adds the all_private_chats bridged menu when the endpoint is enabled", async () => {
    vi.stubEnv("MYRMIDON_TELEGRAM_DM_CONVERSATIONS", "*");
    const captured: CapturedCommandsCall[] = [];

    await connectTelegramEndpoint(fakeTelegramFetch(captured));

    const setCalls = captured.filter((call) => call.method === "setMyCommands");
    expect(setCalls).toHaveLength(2);
    // The vendor menu is unscoped and untouched by the bridge.
    expect(setCalls[0].body).not.toHaveProperty("scope");
    expect(setCalls[1].body).toEqual({
      commands: TELEGRAM_DM_COMMANDS,
      scope: { type: "all_private_chats" },
    });
    expect(
      captured.filter((call) => call.method === "deleteMyCommands"),
    ).toHaveLength(0);
  });

  it("clears the all_private_chats bridged menu when the endpoint is not enabled", async () => {
    const captured: CapturedCommandsCall[] = [];

    await connectTelegramEndpoint(fakeTelegramFetch(captured));

    expect(
      captured.filter((call) => call.method === "setMyCommands"),
    ).toHaveLength(1);
    expect(
      captured.filter((call) => call.method === "deleteMyCommands"),
    ).toEqual([
      {
        method: "deleteMyCommands",
        body: { scope: { type: "all_private_chats" } },
      },
    ]);
  });

  it("clears the all_private_chats bridged menu when the endpoint is removed", async () => {
    vi.stubEnv("MYRMIDON_TELEGRAM_DM_CONVERSATIONS", "*");
    const captured: CapturedCommandsCall[] = [];
    const { endpoint, service } = await connectTelegramEndpoint(
      fakeTelegramFetch(captured),
    );
    captured.length = 0;

    await service.configure(endpoint.id, { action: "remove" }, "owner-user");

    expect(
      captured.filter((call) => call.method === "deleteMyCommands"),
    ).toEqual([
      { method: "deleteMyCommands", body: {} },
      {
        method: "deleteMyCommands",
        body: { scope: { type: "all_private_chats" } },
      },
    ]);
  });
});

// myrmidon(X8e): unit coverage for telegramDmConversationsEnabled's
// comma-separated endpoint id list — the only branch the scenarios above
// don't exercise (they only cover "*" and unset). Pure function, no
// database needed, so it runs even where embedded Postgres is unsupported.
describe("telegramDmConversationsEnabled (X8e)", () => {
  const ownId = "11111111-1111-1111-1111-111111111111";
  const otherId = "22222222-2222-2222-2222-222222222222";

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("matches the endpoint's own id in a comma-separated list", () => {
    vi.stubEnv(
      "MYRMIDON_TELEGRAM_DM_CONVERSATIONS",
      `${otherId},${ownId}`,
    );
    expect(telegramDmConversationsEnabled(ownId)).toBe(true);
  });

  it("does not match an id absent from the list", () => {
    vi.stubEnv("MYRMIDON_TELEGRAM_DM_CONVERSATIONS", otherId);
    expect(telegramDmConversationsEnabled(ownId)).toBe(false);
  });

  it("trims whitespace around listed ids and ignores empty entries", () => {
    vi.stubEnv(
      "MYRMIDON_TELEGRAM_DM_CONVERSATIONS",
      ` ${otherId} , ${ownId} ,, `,
    );
    expect(telegramDmConversationsEnabled(ownId)).toBe(true);
    expect(telegramDmConversationsEnabled(otherId)).toBe(true);
    expect(telegramDmConversationsEnabled("third-id")).toBe(false);
  });

  // myrmidon(X8e): "*" must work as one entry of a mixed list, not only as
  // the entire raw value — this is the branch that diverged from X8a's copy
  // of this function until it was aligned (review fix).
  it("matches every endpoint when '*' is one entry among others", () => {
    vi.stubEnv("MYRMIDON_TELEGRAM_DM_CONVERSATIONS", `${otherId},*`);
    expect(telegramDmConversationsEnabled(ownId)).toBe(true);
    expect(telegramDmConversationsEnabled(otherId)).toBe(true);
    expect(telegramDmConversationsEnabled("any-other-id")).toBe(true);
  });
});
