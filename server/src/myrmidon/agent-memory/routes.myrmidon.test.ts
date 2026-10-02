// myrmidon(MEMORY-UI): route tests — auth contract, agent scoping, and the
// request/response shapes of the memory card API.
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { agentMemoryRoutes } from "./routes.js";
import { agentMemoryService, MemoryUiError, type MemoryServiceDeps } from "./service.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const AGENT = "33333333-3333-4333-8333-333333333333";
const AGENT_OTHER = "44444444-4444-4444-8444-444444444444";

const board = {
  type: "board",
  source: "session",
  userId: "user-a",
  isInstanceAdmin: true,
  companyIds: [COMPANY],
};
const otherBoard = { ...board, userId: "user-b", companyIds: ["99999999-9999-4999-8999-999999999999"] };
const agentActor = { type: "agent", source: "agent_key", agentId: "agent-b", companyId: COMPANY, keyId: "k" };
const anonymous = { type: "none" };

/**
 * A drizzle-shaped db mock for the routes: the service resolves the bank of
 * the agent under test, whose card carries `adapterConfig.hindsight.bankId`
 * (see service.myrmidon.test.ts for the where-capture mechanics).
 */
function makeRoutesDb() {
  const state = { agentId: null as string | null };
  const agentsRows = [
    { id: AGENT, companyId: COMPANY, adapterConfig: { hindsight: { bankId: "adm" } } },
    { id: AGENT_OTHER, companyId: "99999999-9999-4999-8999-999999999999", adapterConfig: null },
  ];
  const promise = () => Promise.resolve().then(() => {
    const row = state.agentId ? agentsRows.find((r) => r.id === state.agentId) : undefined;
    state.agentId = null;
    return row ? [{ companyId: row.companyId, adapterConfig: row.adapterConfig }] : [];
  });
  const proxy: Record<string, unknown> = {
    from: () => proxy,
    innerJoin: () => proxy,
    where: (condition: unknown) => {
      const chunks = (condition as { queryChunks?: unknown[] } | null)?.queryChunks;
      const parts = Array.isArray(chunks) ? chunks : Array.isArray(condition) ? condition : [condition];
      for (const part of parts) {
        const value = typeof part === "string" ? part : (part as { value?: unknown })?.value;
        if (typeof value === "string" && agentsRows.some((row) => row.id === value)) state.agentId = value;
      }
      return proxy;
    },
    orderBy: () => proxy,
    limit: () => ({ then: (resolve: (rows: unknown) => void) => promise().then(resolve) }),
    then: (resolve: (rows: unknown) => void) => promise().then(resolve),
  };
  return {
    select: () => proxy,
  } as unknown as Db;
}

function app(actor: unknown) {
  const deps: MemoryServiceDeps = {
    db: makeRoutesDb(),
    env: { MYRMIDON_HINDSIGHT_API_URL: "http://memory.invalid", MYRMIDON_HINDSIGHT_KEY_SECRET: "s" },
    readSecretValue: vi.fn().mockResolvedValue("hsk-test"),
    client: () => ({
      list: async () => ({ items: [{ id: "m1", text: "likes tea", factType: "world", state: "valid", occurredAt: null, createdAt: null, documentId: null, tags: [] }], total: 1, limit: 50, offset: 0 }),
      invalidate: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue({ deletedCount: 1 }),
    }),
    logActivity: vi.fn().mockResolvedValue(null) as unknown as MemoryServiceDeps["logActivity"],
  };
  const server = express();
  server.use(express.json());
  server.use((_req, _res, next) => {
    (_req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  server.use("/api", agentMemoryRoutes({
    deps,
    async getAgent(id) {
      if (id === AGENT) return { id: AGENT, companyId: COMPANY };
      if (id === AGENT_OTHER) return { id: AGENT_OTHER, companyId: "99999999-9999-4999-8999-999999999999" };
      return null;
    },
    hasCompanyAccess(req, companyId) {
      // The real hasCompanyAccess: an agent key is company-scoped; a board
      // actor must hold this company's access (companyIds).
      const actor = req.actor as
        | { type?: string; source?: string; companyId?: string; companyIds?: string[] }
        | undefined;
      if (actor?.type === "none" || !actor) return false;
      if (actor.type === "agent") return actor.companyId === companyId;
      if (actor.source === "local_implicit") return true;
      return (actor.companyIds ?? []).includes(companyId);
    },
    assertBoard(req) {
      if (req.actor?.type !== "board") throw httpError(403, "Board access required");
    },
  }));
  // Zod failures from `validate` are ZodError, not HttpError: mirror the real
  // errorHandler's 400 branch for them, HttpError's status otherwise.
  server.use((err: unknown, _req: unknown, res: { status: (code: number) => { json: (body: unknown) => void } }, _next: unknown) => {
    const status = (err as { status?: number } | null)?.status;
    if (typeof status === "number") {
      res.status(status).json({ error: err instanceof Error ? err.message : "error" });
      return;
    }
    res.status(400).json({ error: "Validation error" });
  });
  return server;
}

function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

describe("agent memory routes", () => {
  it("serves status to a board actor of the company", async () => {
    const res = await request(app(board)).get(`/api/myrmidon/agents/${AGENT}/memory`).expect(200);
    expect(res.body).toMatchObject({ enabled: true, bank: { bankId: "adm", source: "agent-card" } });
  });

  it("hides another company's agent behind 404", async () => {
    await request(app(board)).get(`/api/myrmidon/agents/${AGENT_OTHER}/memory`).expect(404);
  });

  it("rejects anonymous and agent actors", async () => {
    // Anonymous (no company access) hides the agent behind 404 — the same
    // indistinguishability rule; agent keys of this company reach the
    // board-only gate (403), which is not an existence leak.
    await request(app(anonymous)).get(`/api/myrmidon/agents/${AGENT}/memory`).expect(404);
    await request(app(agentActor)).get(`/api/myrmidon/agents/${AGENT}/memory`).expect(403);
  });

  it("a board actor without this company's access is hidden behind 404", async () => {
    await request(app(otherBoard)).get(`/api/myrmidon/agents/${AGENT}/memory`).expect(404);
  });

  it("lists memories with paging params", async () => {
    const res = await request(app(board))
      .get(`/api/myrmidon/agents/${AGENT}/memory/memories?limit=10&offset=0&state=valid`)
      .expect(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ id: "m1", text: "likes tea" });
  });

  it("malformed paging params fall back to defaults, not an error", async () => {
    await request(app(board)).get(`/api/myrmidon/agents/${AGENT}/memory/memories?limit=abc`).expect(200);
  });

  it("exports the bank as a JSON attachment", async () => {
    const res = await request(app(board)).get(`/api/myrmidon/agents/${AGENT}/memory/export`).expect(200);
    expect(res.headers["content-disposition"]).toContain("memory.json");
    expect(res.body.items).toHaveLength(1);
  });

  it("invalidates one memory with a reason", async () => {
    const res = await request(app(board))
      .delete(`/api/myrmidon/agents/${AGENT}/memory/memories/m1`)
      .send({ reason: "stale" })
      .expect(200);
    expect(res.body).toEqual({ deleted: true });
  });

  it("rejects an invalidation without a reason", async () => {
    await request(app(board)).delete(`/api/myrmidon/agents/${AGENT}/memory/memories/m1`).send({}).expect(400);
  });

  it("clears the whole bank", async () => {
    const res = await request(app(board)).post(`/api/myrmidon/agents/${AGENT}/memory/clear`).send({}).expect(200);
    expect(res.body).toEqual({ cleared: true, deletedCount: 1 });
  });

  it("a 503 service error keeps its status", async () => {
    const server = express();
    server.use(express.json());
    server.use((_req, _res, next) => {
      (_req as unknown as { actor: unknown }).actor = board;
      next();
    });
    const deps: MemoryServiceDeps = {
      db: makeRoutesDb(),
      env: {},
      readSecretValue: vi.fn(),
      client: () => ({ list: vi.fn(), invalidate: vi.fn(), clear: vi.fn() }),
      logActivity: vi.fn().mockResolvedValue(null) as unknown as MemoryServiceDeps["logActivity"],
    };
    const failing = {
      ...deps,
      client: () => ({
        list: async () => {
          throw new MemoryUiError(503, "agent memory is not enabled");
        },
        invalidate: async () => {
          throw new MemoryUiError(503, "agent memory is not enabled");
        },
        clear: async () => {
          throw new MemoryUiError(503, "agent memory is not enabled");
        },
      }),
    };
    server.use("/api", agentMemoryRoutes({
      deps: failing,
      async getAgent(id) {
        return id === AGENT ? { id: AGENT, companyId: COMPANY } : null;
      },
      hasCompanyAccess: () => true,
      assertBoard: () => {},
    }));
    server.use((err: unknown, _req: unknown, res: { status: (code: number) => { json: (body: unknown) => void } }, _next: unknown) => {
      const status = (err as { status?: number } | null)?.status ?? 500;
      res.status(status).json({ error: err instanceof Error ? err.message : "error" });
    });
    await request(server).get(`/api/myrmidon/agents/${AGENT}/memory/memories`).expect(503);
    await request(server).post(`/api/myrmidon/agents/${AGENT}/memory/clear`).expect(503);
  });

  it("an agent of another company is hidden behind 404, not leaked", async () => {
    await request(app(agentActor)).get(`/api/myrmidon/agents/${AGENT_OTHER}/memory`).expect(404);
  });

  it("a malformed agent id is a 404, not a 500", async () => {
    await request(app(board)).get("/api/myrmidon/agents/not-a-uuid/memory").expect(404);
  });
});
