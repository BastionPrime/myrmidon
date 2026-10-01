// myrmidon(MEMORY-UI): tests for the agent memory service — bank resolution,
// the settings gate, list/export/invalidate/clear, and the activity log rows.
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  agentMemoryService,
  resolveAgentMemoryBank,
  MemoryUiError,
  type MemoryServiceDeps,
} from "./service.js";
import { readMemoryUiSettings, readHttpUrlSetting } from "./settings.js";
import { parseMemoryPage, createMemoryHindsightClient } from "./hindsight-client.js";

// Synthetic data only: fake UUID-shaped ids, a mock fetch over an in-memory
// "memory service". No real addresses (the API URL is a placeholder the mock
// never dereferences).

const COMPANY = "11111111-1111-4111-8111-111111111111";
const AGENT = "33333333-3333-4333-8333-333333333333";
const OTHER_COMPANY = "22222222-2222-4222-8222-222222222222";
const AGENT_OTHER_COMPANY = "44444444-4444-4444-8444-444444444444";
const AGENT_UNMAPPED = "55555555-5555-4555-8555-555555555555";

const API_URL = "http://memory.invalid";
const KEY_SECRET = "hindsight-key";

interface MockCall {
  method: string;
  path: string;
  body?: unknown;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * A drizzle-shaped mock: `select().from().where().limit()` chains over the
 * given rows, like the real query builder the service drives. The where()
 * clause is captured so the agent query returns only the requested agent's
 * row (the real `eq(agents.id, ...)` filter), not every row.
 */
function makeDb(
  agentsRows: Array<{ id: string; companyId: string; adapterConfig: Record<string, unknown> | null }>,
  pluginConfigRows: Array<{ configJson: Record<string, unknown> }> = [],
) {
  const state = { agentId: null as string | null };
  return {
    select: vi.fn().mockImplementation((projection: Record<string, unknown>) => {
      const keys = Object.keys(projection ?? {});
      const isAgentQuery = keys.includes("adapterConfig");
      const promise = Promise.resolve().then(() => {
        if (isAgentQuery) {
          const row = state.agentId ? agentsRows.find((r) => r.id === state.agentId) : undefined;
          state.agentId = null;
          return row ? [{ companyId: row.companyId, adapterConfig: row.adapterConfig }] : [];
        }
        return pluginConfigRows.map((c) => ({ configJson: c.configJson }));
      });
      const proxy: Record<string, unknown> = {
        from: () => proxy,
        innerJoin: () => proxy,
        where: (condition: unknown) => {
          // drizzle conditions carry operands in queryChunks; the agent query
          // filters by the agent id, which is the only plain string chunk.
          const chunks = (condition as { queryChunks?: unknown[] } | null)?.queryChunks;
          const parts = Array.isArray(chunks) ? chunks : Array.isArray(condition) ? condition : [condition];
          for (const part of parts) {
            const value = typeof part === "string" ? part : (part as { value?: unknown })?.value;
            if (typeof value === "string" && agentsRows.some((row) => row.id === value)) state.agentId = value;
          }
          return proxy;
        },
        orderBy: () => proxy,
        limit: () => promise,
        then: promise.then.bind(promise),
      };
      return proxy;
    }),
  } as unknown as Db;
}

function makeDeps(overrides: Partial<MemoryServiceDeps> = {}, env: Record<string, string> = {}) {
  const calls: MockCall[] = [];
  const banks = new Map<string, Array<{ id: string; text: string; fact_type: string; state: string }>>();
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = url.slice(API_URL.length).split("?")[0];
    const body = init?.body !== undefined ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    if (method === "GET" && path.endsWith("/memories/list")) {
      const bank = decodeURIComponent(path.split("/")[4]);
      const items = banks.get(bank) ?? [];
      return jsonResponse({ items, total: items.length, limit: items.length, offset: 0 });
    }
    if (method === "PATCH") {
      return jsonResponse({ ok: true });
    }
    if (method === "DELETE" && path.endsWith("/memories")) {
      const bank = decodeURIComponent(path.split("/")[4]);
      const deleted = banks.get(bank)?.length ?? 0;
      banks.set(bank, []);
      return jsonResponse({ success: true, deleted_count: deleted });
    }
    return jsonResponse({ error: "unhandled" }, 404);
  };
  const logActivity = vi.fn().mockResolvedValue(null);
  const deps: MemoryServiceDeps = {
    db: makeDb([
      { id: AGENT, companyId: COMPANY, adapterConfig: { hindsight: { bankId: "adm" } } },
      { id: AGENT_OTHER_COMPANY, companyId: OTHER_COMPANY, adapterConfig: { hindsight: { bankId: "other" } } },
      { id: AGENT_UNMAPPED, companyId: COMPANY, adapterConfig: null },
    ]),
    env: { MYRMIDON_HINDSIGHT_API_URL: API_URL, MYRMIDON_HINDSIGHT_KEY_SECRET: KEY_SECRET, ...env },
    readSecretValue: vi.fn().mockResolvedValue("hsk-test"),
    client: (baseUrl, apiKey) => createMemoryHindsightClient(baseUrl, apiKey, { fetchImpl }),
    logActivity: logActivity as unknown as typeof import("../../services/activity-log.js").logActivity,
    ...overrides,
  };
  return { deps, calls, banks, logActivity };
}

describe("readMemoryUiSettings", () => {
  it("is off without both the address and the secret name", () => {
    expect(readMemoryUiSettings({}).enabled).toBe(false);
    expect(readMemoryUiSettings({ MYRMIDON_HINDSIGHT_API_URL: API_URL }).enabled).toBe(false);
    expect(readMemoryUiSettings({ MYRMIDON_HINDSIGHT_KEY_SECRET: KEY_SECRET }).enabled).toBe(false);
  });

  it("is on with both", () => {
    const settings = readMemoryUiSettings({
      MYRMIDON_HINDSIGHT_API_URL: API_URL,
      MYRMIDON_HINDSIGHT_KEY_SECRET: KEY_SECRET,
    });
    expect(settings.enabled).toBe(true);
    expect(settings.baseUrl).toBe(API_URL);
  });

  it("drops a non-http url", () => {
    expect(readHttpUrlSetting("ftp://memory.invalid")).toBeNull();
    expect(readHttpUrlSetting("not a url")).toBeNull();
    expect(readHttpUrlSetting("  ")).toBeNull();
    expect(readHttpUrlSetting("http://memory.invalid")).toBe("http://memory.invalid");
  });
});

describe("resolveAgentMemoryBank", () => {
  it("reads the bank from the agent card", async () => {
    const db = makeDb([{ id: AGENT, companyId: COMPANY, adapterConfig: { hindsight: { bankId: "adm" } } }]);
    const resolution = await resolveAgentMemoryBank(db, { agentId: AGENT, companyId: COMPANY });
    expect(resolution).toEqual({ bankId: "adm", source: "agent-card" });
  });

  it("returns null for another company's agent", async () => {
    const db = makeDb([{ id: AGENT, companyId: COMPANY, adapterConfig: { hindsight: { bankId: "adm" } } }]);
    expect(await resolveAgentMemoryBank(db, { agentId: AGENT, companyId: OTHER_COMPANY })).toBeNull();
  });

  it("returns null for an unknown or malformed agent", async () => {
    const db = makeDb([]);
    expect(await resolveAgentMemoryBank(db, { agentId: AGENT, companyId: COMPANY })).toBeNull();
    expect(await resolveAgentMemoryBank(db, { agentId: "not-a-uuid", companyId: COMPANY })).toBeNull();
  });

  it("returns null when the card names no bank (closed agent)", async () => {
    const db = makeDb([{ id: AGENT, companyId: COMPANY, adapterConfig: null }]);
    expect(await resolveAgentMemoryBank(db, { agentId: AGENT, companyId: COMPANY })).toBeNull();
  });
});

describe("parseMemoryPage", () => {
  it("parses items with ids and drops rows without ids", () => {
    const page = parseMemoryPage({
      items: [
        { id: "m1", text: "likes tea", fact_type: "world", state: "valid", created_at: "2026-09-01T00:00:00Z", tags: ["x"] },
        { text: "no id" },
        { id: "m2", text: "", fact_type: "experience", state: "invalidated" },
      ],
      total: 3,
      limit: 50,
      offset: 0,
    });
    expect(page?.items).toHaveLength(2);
    expect(page?.items[0]).toMatchObject({ id: "m1", text: "likes tea", factType: "world", state: "valid" });
    expect(page?.total).toBe(3);
  });

  it("returns null for a foreign shape", () => {
    expect(parseMemoryPage({ data: [] })).toBeNull();
    expect(parseMemoryPage(null)).toBeNull();
  });
});

describe("agentMemoryService", () => {
  it("status reports the bank and enabled flag", async () => {
    const { deps } = makeDeps();
    const service = agentMemoryService(deps);
    const status = await service.status(AGENT, COMPANY);
    expect(status).toEqual({ enabled: true, bank: { bankId: "adm", source: "agent-card" }, reason: null });
  });

  it("status says not_enabled while the switch is off", async () => {
    const { deps } = makeDeps({}, {});
    const service = agentMemoryService({ ...deps, env: {} });
    const status = await service.status(AGENT, COMPANY);
    expect(status.enabled).toBe(false);
    expect(status.reason).toBe("not_enabled");
  });

  it("status says no_bank for a closed agent", async () => {
    const { deps } = makeDeps();
    const service = agentMemoryService(deps);
    const status = await service.status(AGENT_UNMAPPED, COMPANY);
    expect(status.enabled).toBe(true);
    expect(status.bank).toBeNull();
    expect(status.reason).toBe("no_bank");
  });

  it("list reads the agent's own bank only", async () => {
    const { deps, calls, banks } = makeDeps();
    banks.set("adm", [{ id: "m1", text: "likes tea", fact_type: "world", state: "valid" }]);
    const service = agentMemoryService(deps);
    const page = await service.list(AGENT, COMPANY);
    expect(page.items).toHaveLength(1);
    expect(calls[0]?.path).toContain("/banks/adm/memories/list");
  });

  it("list throws 404 when the agent has no bank", async () => {
    const { deps } = makeDeps();
    const service = agentMemoryService(deps);
    await expect(service.list(AGENT_UNMAPPED, COMPANY)).rejects.toMatchObject({ status: 404 });
  });

  it("list throws 503 while the switch is off", async () => {
    const { deps } = makeDeps();
    const service = agentMemoryService({ ...deps, env: {} });
    await expect(service.list(AGENT, COMPANY)).rejects.toMatchObject({ status: 503 });
  });

  it("invalidate patches the unit and writes an activity row", async () => {
    const { deps, calls, logActivity } = makeDeps();
    const service = agentMemoryService(deps);
    await service.invalidate(AGENT, COMPANY, "m1", "stale fact", {
      actorType: "user",
      actorId: "user-a",
      agentId: null,
    });
    expect(calls[0]).toMatchObject({ method: "PATCH", path: "/v1/default/banks/adm/memories/m1" });
    expect(calls[0]?.body).toEqual({ state: "invalidated", reason: "stale fact" });
    expect(logActivity).toHaveBeenCalledWith(
      deps.db,
      expect.objectContaining({
        action: "myrmidon.agent.memory.delete",
        companyId: COMPANY,
        entityId: AGENT,
        details: { bankId: "adm", memoryId: "m1", reason: "stale fact" },
      }),
    );
  });

  it("clear empties the bank and writes an activity row", async () => {
    const { deps, banks, logActivity } = makeDeps();
    banks.set("adm", [
      { id: "m1", text: "a", fact_type: "world", state: "valid" },
      { id: "m2", text: "b", fact_type: "world", state: "valid" },
    ]);
    const service = agentMemoryService(deps);
    const result = await service.clearBank(AGENT, COMPANY, { actorType: "user", actorId: "user-a", agentId: null });
    expect(result.deletedCount).toBe(2);
    expect(banks.get("adm")).toHaveLength(0);
    expect(logActivity).toHaveBeenCalledWith(
      deps.db,
      expect.objectContaining({ action: "myrmidon.agent.memory.clear", details: { bankId: "adm", deletedCount: 2 } }),
    );
  });

  it("export pages the bank, caps rows and writes an activity row", async () => {
    const { deps, banks, logActivity } = makeDeps();
    const rows = Array.from({ length: 3 }, (_, i) => ({
      id: `m${i}`,
      text: `fact ${i}`,
      fact_type: "world",
      state: "valid",
    }));
    banks.set("adm", rows);
    const service = agentMemoryService(deps);
    const exported = await service.exportBank(AGENT, COMPANY, { actorType: "user", actorId: "user-a", agentId: null }, { limit: 2 });
    expect(exported.items).toHaveLength(3);
    expect(exported.truncated).toBe(false);
    expect(logActivity).toHaveBeenCalledWith(
      deps.db,
      expect.objectContaining({ action: "myrmidon.agent.memory.export" }),
    );
  });

  it("a memory service error surfaces with its status", async () => {
    const { deps } = makeDeps();
    const failing = {
      ...deps,
      client: () => ({
        list: async () => {
          throw Object.assign(new Error("HTTP 400 from PATCH: cannot curate"), { status: 400 });
        },
        invalidate: async () => {},
        clear: async () => ({ deletedCount: 0 }),
      }),
    };
    const service = agentMemoryService(failing);
    await expect(service.list(AGENT, COMPANY)).rejects.toMatchObject({ status: 400 });
  });

  it("keeps serving when the activity write fails", async () => {
    const { deps } = makeDeps();
    const service = agentMemoryService({
      ...deps,
      logActivity: vi.fn().mockRejectedValue(new Error("log down")) as unknown as MemoryServiceDeps["logActivity"],
    });
    await expect(
      service.invalidate(AGENT, COMPANY, "m1", "stale fact", { actorType: "user", actorId: "user-a", agentId: null }),
    ).resolves.toBeUndefined();
  });
});
