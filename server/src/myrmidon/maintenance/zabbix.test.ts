import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, instanceSettings } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { resetMaintenanceGateCaches } from "./gate.js";
import { maintenanceService } from "./service.js";
import { readZabbixSettings, resolveZabbixToken, zabbixMaintenanceHooks, type ZabbixSettings } from "./zabbix.js";

const SETTINGS: ZabbixSettings = {
  url: "https://zabbix.example.com/api_jsonrpc.php",
  tokenRef: "env:TEST_ZABBIX_TOKEN",
  hostGroups: ["group-a", "group-b"],
  maxWindowSec: 3600,
  timeoutMs: 1000,
};

type Call = { url: string; method: string; params: unknown; authorization: string | null };

function fakeZabbix(options: { failMethod?: string; networkError?: boolean } = {}) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { method: string; params: unknown; id: number };
    const headers = new Headers(init.headers);
    calls.push({ url, method: body.method, params: body.params, authorization: headers.get("authorization") });
    if (options.networkError) throw new TypeError("fetch failed");
    if (body.method === options.failMethod) {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32602, message: "Invalid params." } }));
    }
    const result =
      body.method === "hostgroup.get"
        ? [{ groupid: "11", name: "group-a" }, { groupid: "12", name: "group-b" }]
        : body.method === "maintenance.create"
          ? { maintenanceids: ["501"] }
          : { maintenanceids: ["501"] };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  };
  return { calls, fetch };
}

describe("zabbix settings", () => {
  it("is off unless url, token reference and host groups are all set", () => {
    expect(readZabbixSettings({})).toBeNull();
    expect(readZabbixSettings({ MYRMIDON_ZABBIX_URL: SETTINGS.url, MYRMIDON_ZABBIX_TOKEN_REF: "env:X" })).toBeNull();
    expect(
      readZabbixSettings({
        MYRMIDON_ZABBIX_URL: SETTINGS.url,
        MYRMIDON_ZABBIX_TOKEN_REF: "env:X",
        MYRMIDON_ZABBIX_HOST_GROUPS: " group-a, group-b ,",
      }),
    ).toMatchObject({ hostGroups: ["group-a", "group-b"], maxWindowSec: 14_400 });
  });

  it("resolves env: and file: token references and rejects plain values", () => {
    expect(resolveZabbixToken("env:TOKEN_A", { env: { TOKEN_A: " value-a\n" } })).toBe("value-a");
    expect(resolveZabbixToken("file:/run/secrets/zabbix", { readFile: () => "value-b\n" })).toBe("value-b");
    expect(() => resolveZabbixToken("value-c")).toThrow(/env:<NAME> or file:<path>/);
    expect(() => resolveZabbixToken("env:MISSING", { env: {} })).toThrow(/empty/);
  });

  it("makes no calls without settings", () => {
    expect(zabbixMaintenanceHooks(null)).toEqual({});
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("maintenance mode with Zabbix", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const ADMIN = { actorType: "user", actorId: "admin-user" };
  const heartbeat = { resumeQueuedRuns: async () => undefined };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-maintenance-zabbix-");
    db = createDb(tempDb.connectionString);
    await db.insert(companies).values({
      id: randomUUID(),
      name: "company-a",
      issuePrefix: "ZBX",
      requireBoardApprovalForNewAgents: false,
    });
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(instanceSettings);
    resetMaintenanceGateCaches();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function service(fake: ReturnType<typeof fakeZabbix>) {
    const hooks = zabbixMaintenanceHooks(SETTINGS, {
      fetch: fake.fetch,
      token: () => resolveZabbixToken(SETTINGS.tokenRef, { env: { TEST_ZABBIX_TOKEN: "fake-zabbix-token" } }),
      now: () => new Date("2026-09-27T10:00:00.000Z"),
    });
    return maintenanceService(db, { heartbeat, hooks });
  }

  it("creates a maintenance period on enter and deletes it on exit", async () => {
    const fake = fakeZabbix();
    const svc = service(fake);
    await svc.enter({ scope: { type: "instance" }, reason: "deploy" }, ADMIN);

    expect(fake.calls.map((c) => c.method)).toEqual(["hostgroup.get", "maintenance.create"]);
    expect(fake.calls[0]!.authorization).toBe("Bearer fake-zabbix-token");
    expect(fake.calls[0]!.params).toMatchObject({ filter: { name: ["group-a", "group-b"] } });
    const since = Date.parse("2026-09-27T10:00:00.000Z") / 1000;
    expect(fake.calls[1]!.params).toMatchObject({
      active_since: since,
      active_till: since + 3600,
      maintenance_type: 0,
      groups: [{ groupid: "11" }, { groupid: "12" }],
    });

    await svc.exit({ type: "instance" }, ADMIN);
    expect(fake.calls.map((c) => c.method)).toEqual(["hostgroup.get", "maintenance.create", "maintenance.delete"]);
    expect(fake.calls[2]!.params).toEqual(["501"]);
  });

  it("enters and exits normally when Zabbix fails, and records the failure", async () => {
    for (const fake of [fakeZabbix({ failMethod: "maintenance.create" }), fakeZabbix({ networkError: true })]) {
      const svc = service(fake);
      const entered = await svc.enter({ scope: { type: "instance" }, reason: "deploy" }, ADMIN);
      expect(entered).toMatchObject({ state: "on", changed: true });
      const exited = await svc.exit({ type: "instance" }, ADMIN);
      expect(exited).toMatchObject({ state: "off", changed: true });
      // No period was created, so there is nothing to delete.
      expect(fake.calls.map((c) => c.method)).not.toContain("maintenance.delete");
      const failures = await db.select().from(activityLog).where(eq(activityLog.action, "myrmidon.maintenance.zabbix_failed"));
      expect(failures.length).toBe(1);
      expect(JSON.stringify(failures[0]!.details)).not.toContain("fake-zabbix-token");
      await db.delete(activityLog);
    }
  });

  it("does not call Zabbix for narrower scopes", async () => {
    const [company] = await db.select({ id: companies.id }).from(companies);
    const fake = fakeZabbix();
    const svc = service(fake);
    await svc.enter({ scope: { type: "company", id: company!.id }, reason: "company work" }, ADMIN);
    await svc.exit({ type: "company", id: company!.id }, ADMIN);
    expect(fake.calls).toEqual([]);
    expect(await db.select().from(agents)).toEqual([]);
  });
});
