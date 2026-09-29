import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  authUsers,
  chatActions,
  chatEndpoints,
  companies,
  companyMemberships,
  createDb,
  getEmbeddedPostgresTestSupport,
  principalPermissionGrants,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import {
  chatChannelService,
  telegramCommandsCopyVersion,
  type ChatChannelService,
} from "../services/chat-channels.js";
import type {
  ChatSdkRuntime,
  CreateChatSdkEndpointRuntimeOptions,
} from "../services/chat-sdk-runtime.js";
import { TELEGRAM_DM_COMMANDS } from "../myrmidon/agent-chat-bridge/commands/index.js";
import {
  telegramDmConversationsConfigured,
  telegramDmConversationsEnabled,
} from "../myrmidon/agent-chat-bridge/settings.js";

// myrmidon(X8e): the vendor registers one "no scope" Telegram command menu on
// connect, reconnect, and remove (see "configures Telegram and preserves
// queued updates…" in chat-channels.integration.test.ts, grep setMyCommands).
// This drives that same flow through a minimal Telegram-only double of that
// harness and checks the extra all_private_chats scoped calls the bridge adds
// when MYRMIDON_TELEGRAM_DM_CONVERSATIONS is set: a scoped setMyCommands for
// an enabled endpoint, a scoped deleteMyCommands for an endpoint the (set)
// list leaves out. With the variable unset, blank or only separators the
// service must make exactly the vendor's provider calls and nothing more.

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
  method: string;
  body: Record<string, unknown>;
}

function fakeTelegramFetch(
  captured: CapturedCommandsCall[],
  botId = Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 12), 16),
) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    // Record every provider call in order, so a test can prove the exact
    // sequence (not only the menu calls).
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    } catch {
      // Not every Bot API call carries a JSON body; only the method matters.
    }
    captured.push({
      method: url.slice(url.lastIndexOf("/") + 1).split("?")[0],
      body,
    });
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
  // Endpoints a test marked active for the recovery sweep; paused afterwards so
  // a later test's sweep does not pick them up.
  const activatedEndpointIds: string[] = [];
  afterEach(async () => {
    await Promise.all(
      fixtureServices.splice(0).map((service) => service.shutdown()),
    );
    if (activatedEndpointIds.length > 0) {
      await db
        .update(chatEndpoints)
        .set({ status: "paused" })
        .where(inArray(chatEndpoints.id, activatedEndpointIds.splice(0)));
    }
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
    botToken = "123456:dm-menu-test-token",
  ) {
    const { companyId, assignedAgentId } = await seedCompany();
    const service = createService(providerFetch);
    const endpoint = await service.create(
      companyId,
      { provider: "telegram", assignedAgentId },
      "owner-user",
    );
    const configured = await service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: { botToken },
      },
      "owner-user",
    );
    return { endpoint, service, configured };
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

  it("clears the all_private_chats bridged menu when the set list leaves the endpoint out", async () => {
    // The variable names only another endpoint: it is set, so the bridge owns
    // the private-chat menu and must not leave a stale one behind.
    vi.stubEnv(
      "MYRMIDON_TELEGRAM_DM_CONVERSATIONS",
      "33333333-3333-3333-3333-333333333333",
    );
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

  // The review's defect: with the variable unset the bridge used to send an
  // extra scoped deleteMyCommands (and an extra lease check) on every
  // Telegram endpoint, shifting the vendor's credential-lease accounting.
  // Unset, blank and separators-only are all "not configured": the vendor's
  // provider calls, byte for byte.
  it.each([
    ["unset", undefined],
    ["blank", "   "],
    ["only separators", " , ,"],
  ])(
    "makes exactly the vendor's provider calls on connect when the variable is %s",
    async (_label, value) => {
      vi.stubEnv("MYRMIDON_TELEGRAM_DM_CONVERSATIONS", value);
      const captured: CapturedCommandsCall[] = [];

      await connectTelegramEndpoint(fakeTelegramFetch(captured));

      expect(
        captured.filter((call) => call.method === "deleteMyCommands"),
      ).toEqual([]);
      const setCalls = captured.filter(
        (call) => call.method === "setMyCommands",
      );
      expect(setCalls).toHaveLength(1);
      expect(setCalls[0].body).not.toHaveProperty("scope");
      expect(setCalls[0].body).not.toEqual(
        expect.objectContaining({ commands: TELEGRAM_DM_COMMANDS }),
      );
      // The vendor's unscoped setMyCommands is the last provider call.
      expect(captured.at(-1)?.method).toBe("setMyCommands");
      for (const call of captured) {
        expect(call.body).not.toHaveProperty("scope");
      }
    },
  );

  it.each([
    ["unset", undefined],
    ["blank", "   "],
    ["only separators", " , ,"],
  ])(
    "makes exactly the vendor's provider calls on remove when the variable is %s",
    async (_label, value) => {
      vi.stubEnv("MYRMIDON_TELEGRAM_DM_CONVERSATIONS", value);
      const captured: CapturedCommandsCall[] = [];
      const { endpoint, service } = await connectTelegramEndpoint(
        fakeTelegramFetch(captured),
      );
      captured.length = 0;

      await service.configure(endpoint.id, { action: "remove" }, "owner-user");

      // Vendor's own order: deleteWebhook, then the unscoped deleteMyCommands
      // as the very last provider call; nothing scoped, nothing after it.
      expect(
        captured.filter((call) => call.method === "deleteMyCommands"),
      ).toEqual([{ method: "deleteMyCommands", body: {} }]);
      expect(captured.at(-2)?.method).toBe("deleteWebhook");
      expect(captured.at(-1)?.method).toBe("deleteMyCommands");
    },
  );

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

  it("still clears the bridged menu on removal when the set list leaves the endpoint out", async () => {
    // The endpoint may have been listed when its menu was registered; the
    // variable was edited afterwards. Removal must not leave the menu behind.
    vi.stubEnv(
      "MYRMIDON_TELEGRAM_DM_CONVERSATIONS",
      "33333333-3333-3333-3333-333333333333",
    );
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

  // myrmidon(B1b): the recovery sweep re-registers the "/" menu once for a bot
  // connected before a menu copy change. The same register_commands action
  // owns the bridged direct-message menu, so a refresh must leave that menu in
  // the state the bridge settings ask for and must never replace or drop it.
  // Only this bot's calls are recorded: the sweep scans every active Telegram
  // endpoint in the database with this service's fetch.
  function fetchRecordingOnly(
    botToken: string,
    captured: CapturedCommandsCall[],
  ) {
    const own = fakeTelegramFetch(captured);
    const others = fakeTelegramFetch([]);
    return ((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      return url.includes(botToken) || url.includes(encodeURIComponent(botToken))
        ? own(input, init)
        : others(input, init);
    }) as unknown as typeof globalThis.fetch;
  }

  async function connectActiveEndpoint(list: string | undefined) {
    vi.stubEnv("MYRMIDON_TELEGRAM_DM_CONVERSATIONS", list);
    const botToken = `123456:dm-menu-refresh-${randomUUID().replaceAll("-", "")}`;
    const captured: CapturedCommandsCall[] = [];
    const { endpoint, service, configured } = await connectTelegramEndpoint(
      fetchRecordingOnly(botToken, captured),
      botToken,
    );
    await db
      .update(chatEndpoints)
      .set({
        status: "active",
        setup: { ...configured.setup, step: "complete" },
      })
      .where(eq(chatEndpoints.id, endpoint.id));
    activatedEndpointIds.push(endpoint.id);
    const registrations = () =>
      db
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpoint.id),
            eq(chatActions.kind, "telegram_maintenance"),
            sql`${chatActions.payload}->>'operation' = 'register_commands'`,
          ),
        );
    const sweep = async () => {
      for (let pass = 0; pass < 3; pass++) await service.processPendingDeliveries();
    };
    const menuCalls = () =>
      captured.filter(
        (call) =>
          call.method === "setMyCommands" || call.method === "deleteMyCommands",
      );
    // A bot connected before the copy change: its register action does not
    // carry the current version.
    const makeStale = async () => {
      const [action] = await registrations();
      await db
        .update(chatActions)
        .set({ payload: sql`${chatActions.payload} - 'commandsCopyVersion'` })
        .where(eq(chatActions.id, action.id));
    };
    return { menuCalls, registrations, sweep, makeStale };
  }

  it("refresh keeps the bridged menu registered and versions both menus for an enabled endpoint", async () => {
    const { menuCalls, registrations, sweep, makeStale } =
      await connectActiveEndpoint("*");

    // Connect: the vendor menu, then the bridged one.
    const connectCalls = menuCalls();
    expect(connectCalls.map((call) => call.method)).toEqual([
      "setMyCommands",
      "setMyCommands",
    ]);
    const vendorMenu = connectCalls[0].body;
    expect(vendorMenu).not.toHaveProperty("scope");
    const bridgedMenu = {
      commands: TELEGRAM_DM_COMMANDS,
      scope: { type: "all_private_chats" },
    };
    expect(connectCalls[1].body).toEqual(bridgedMenu);

    // The version stamped on the action covers both menus.
    const [connectAction] = await registrations();
    expect(connectAction.payload.commandsCopyVersion).toBe(
      createHash("sha256")
        .update(JSON.stringify([vendorMenu.commands, TELEGRAM_DM_COMMANDS]))
        .digest("hex")
        .slice(0, 12),
    );
    expect(connectAction.payload.commandsCopyVersion).toBe(
      telegramCommandsCopyVersion(),
    );

    // Current: sweeps leave the bot alone.
    await sweep();
    expect(menuCalls()).toHaveLength(2);
    expect(await registrations()).toHaveLength(1);

    // Stale: one refresh writes the vendor menu and asserts the bridged menu
    // again (never a bare vendor menu that would leave the bridge unmentioned).
    await makeStale();
    await sweep();
    expect(menuCalls().slice(2)).toEqual([
      { method: "setMyCommands", body: vendorMenu },
      { method: "setMyCommands", body: bridgedMenu },
    ]);
    const afterRefresh = await registrations();
    expect(afterRefresh).toHaveLength(2);
    expect(afterRefresh.every((row) => row.status === "processed")).toBe(true);

    // Exactly once.
    await sweep();
    await sweep();
    expect(menuCalls()).toHaveLength(4);
    expect(await registrations()).toHaveLength(2);
  });

  it("refresh clears the bridged menu again for an endpoint the set list leaves out", async () => {
    const { menuCalls, registrations, sweep, makeStale } =
      await connectActiveEndpoint("33333333-3333-3333-3333-333333333333");
    const clearBridged = {
      method: "deleteMyCommands",
      body: { scope: { type: "all_private_chats" } },
    };
    expect(menuCalls().map((call) => call.method)).toEqual([
      "setMyCommands",
      "deleteMyCommands",
    ]);
    const vendorMenu = menuCalls()[0].body;

    await makeStale();
    await sweep();

    expect(menuCalls().slice(2)).toEqual([
      { method: "setMyCommands", body: vendorMenu },
      clearBridged,
    ]);
    expect(await registrations()).toHaveLength(2);
    await sweep();
    expect(menuCalls()).toHaveLength(4);
  });

  it("refresh makes only the vendor's own menu call when the bridge list is unset", async () => {
    const { menuCalls, registrations, sweep, makeStale } =
      await connectActiveEndpoint(undefined);
    expect(menuCalls().map((call) => call.method)).toEqual(["setMyCommands"]);
    const vendorMenu = menuCalls()[0].body;

    await makeStale();
    await sweep();

    // One more unscoped setMyCommands and nothing else: no scoped call, no
    // deleteMyCommands, so the vendor's service path is unchanged.
    expect(menuCalls().slice(1)).toEqual([
      { method: "setMyCommands", body: vendorMenu },
    ]);
    expect(await registrations()).toHaveLength(2);
    await sweep();
    expect(menuCalls()).toHaveLength(2);
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

// myrmidon(X8e): "configured" decides whether the bridge touches the vendor's
// Telegram service path at all; unset, blank and separators-only must all be
// "not configured" so that path stays the vendor's.
describe("telegramDmConversationsConfigured (X8e)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is false when unset, blank, or only separators", () => {
    vi.stubEnv("MYRMIDON_TELEGRAM_DM_CONVERSATIONS", undefined);
    expect(telegramDmConversationsConfigured()).toBe(false);
    for (const value of ["", "   ", ",", " , ,, "]) {
      vi.stubEnv("MYRMIDON_TELEGRAM_DM_CONVERSATIONS", value);
      expect(telegramDmConversationsConfigured()).toBe(false);
    }
  });

  it("is true for '*' and for any list with an id, even one that is not this endpoint's", () => {
    for (const value of ["*", "endpoint-a", " , endpoint-a ,"]) {
      vi.stubEnv("MYRMIDON_TELEGRAM_DM_CONVERSATIONS", value);
      expect(telegramDmConversationsConfigured()).toBe(true);
    }
  });
});

// myrmidon(B1b): the menu copy version depends on the two menus' wording and
// on nothing else. In particular not on the bridge list: a once-per-version
// key cannot express a state that flips back and forth (enabled, left out,
// enabled again), so the refresh action applies whatever state holds when it
// runs and a changed list is applied by Reconnect, as before.
describe("telegramCommandsCopyVersion (B1b)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is a stable 12-hex-digit value that does not follow the bridge list", () => {
    vi.stubEnv("MYRMIDON_TELEGRAM_DM_CONVERSATIONS", undefined);
    const unset = telegramCommandsCopyVersion();
    expect(unset).toMatch(/^[a-f0-9]{12}$/);
    for (const value of ["*", "endpoint-a", " , "]) {
      vi.stubEnv("MYRMIDON_TELEGRAM_DM_CONVERSATIONS", value);
      expect(telegramCommandsCopyVersion()).toBe(unset);
    }
  });
});
