// myrmidon(1.6-FORAGE): the FORAGING routes — access rules, the sweep switch and
// the audit rows. The store, the service and the db are fakes: this pins the
// surface, not the vendor.
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { Response } from "express";
import { foragingRoutes } from "./routes.js";
import type { ForagingService } from "./service.js";
import type { ForagingFindingRow, ForagingSourceRow, ForagingStore } from "./store.js";

function req(actor: Record<string, unknown>, params: Record<string, string>, body: unknown = {}, query: Record<string, string> = {}) {
  return { actor, params, body, query } as unknown as Parameters<ReturnType<typeof foragingRoutes>["handle"]>[0];
}

/** A minimal res double that records the status and body of the answer. */
function res() {
  const out: { status: number; body: unknown } = { status: 200, body: null };
  const double = {
    status(code: number) {
      out.status = code;
      return double;
    },
    json(payload: unknown) {
      out.body = payload;
      return double;
    },
  };
  return { double: double as unknown as Response, out };
}

const source: ForagingSourceRow = {
  id: "source-1",
  companyId: "company-a",
  role: "engineer",
  url: "https://example.com/changelog",
  kind: "url",
  enabled: true,
  lastSnapshot: ["a", "b"],
  lastSnapshotAt: new Date("2026-10-02T10:00:00.000Z"),
  lastCheckedAt: new Date("2026-10-02T10:00:00.000Z"),
  lastError: null,
};

const finding: ForagingFindingRow = {
  id: "finding-1",
  sourceId: "source-1",
  role: "engineer",
  status: "unverified",
  summary: "foraged-engineer: 1 added",
  diff: { added: ["c"], removed: [] },
  skillKey: "foraged-engineer",
  candidateRef: null,
  reason: null,
  detectedAt: new Date("2026-10-02T10:00:00.000Z"),
};

function fakeStore(): ForagingStore {
  return {
    listSources: vi.fn(async () => [source]),
    enabledSources: vi.fn(async () => [source]),
    upsertSource: vi.fn(async () => source),
    deleteSource: vi.fn(async () => true),
    saveSnapshot: vi.fn(async () => {}),
    saveRead: vi.fn(async () => {}),
    insertFinding: vi.fn(async () => finding),
    listFindings: vi.fn(async () => [finding]),
    listUnverifiedFindings: vi.fn(async () => [finding]),
    markFindingCandidate: vi.fn(async () => {}),
    monthFindingCount: vi.fn(async () => 3),
    listCompanyIds: vi.fn(async () => ["company-a"]),
  };
}

const service: ForagingService = {
  runPass: vi.fn(async () => ({
    sourcesRead: 1,
    findings: 1,
    candidates: 0,
    spentCents: 2,
    stoppedByBudget: false,
    errors: 0,
  })),
  budgetState: vi.fn(async () => ({ spentCents: 4, maxCostCents: 50, enabled: true })),
};

const boardActor = { type: "board", userId: "user-1", source: "session" };
const agentActor = { type: "agent", agentId: "agent-a", companyId: "company-a", source: "agent_key" };

/** Calls the route handler for `method path` by walking the router's stack. */
async function callRoute(
  router: ReturnType<typeof foragingRoutes>,
  method: string,
  path: string,
  request: unknown,
  response: Response,
) {
  const stack = (router as unknown as { stack: Array<Record<string, any>> }).stack;
  for (const layer of stack) {
    if (layer.route && layer.route.path === path && layer.route.methods[method.toLowerCase()]) {
      for (const handler of layer.route.stack) {
        let advanced = false;
        await handler.handle(request, response, () => {
          advanced = true;
        });
        if (!advanced) return;
      }
      return;
    }
  }
  throw new Error(`no route ${method} ${path}`);
}

function makeRouter(store = fakeStore(), overrides: Partial<{ enabled: boolean; db: Db }> = {}) {
  const db = (overrides.db ?? {}) as Db;
  return {
    router: foragingRoutes({
      db,
      store,
      service,
      env: { MYRMIDON_FORAGING_ENABLED: overrides.enabled === false ? "0" : "1" } as NodeJS.ProcessEnv,
    }),
    store,
  };
}

describe("myrmidon(1.6-FORAGE) routes", () => {
  it("lists sources with the snapshot line count for a company member", async () => {
    const { router } = makeRouter();
    const { double, out } = res();
    await callRoute(router, "get", "/myrmidon/companies/:companyId/foraging/sources", req(boardActor, { companyId: "company-a" }), double);
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ enabled: true, sources: [{ id: "source-1", snapshotLines: 2 }] });
  });

  it("refuses an agent of another company", async () => {
    const { router } = makeRouter();
    const { double } = res();
    await expect(
      callRoute(
        router,
        "get",
        "/myrmidon/companies/:companyId/foraging/sources",
        req({ ...agentActor, companyId: "company-b" }, { companyId: "company-a" }),
        double,
      ),
    ).rejects.toThrow(/another company/i);
  });

  it("refuses a source write from an agent", async () => {
    const { router } = makeRouter();
    const { double } = res();
    await expect(
      callRoute(
        router,
        "put",
        "/myrmidon/companies/:companyId/foraging/sources",
        req(agentActor, { companyId: "company-a" }, { role: "engineer", url: "https://example.com/a", kind: "url" }),
        double,
      ),
    ).rejects.toThrow(/Board access required/i);
  });

  it("answers 404 on removing a source that is not there", async () => {
    const store = fakeStore();
    store.deleteSource = vi.fn(async () => false);
    const { router } = makeRouter(store);
    const { double, out } = res();
    await callRoute(
      router,
      "delete",
      "/myrmidon/companies/:companyId/foraging/sources/:sourceId",
      req(boardActor, { companyId: "company-a", sourceId: "missing" }),
      double,
    );
    expect(out.status).toBe(404);
  });

  it("returns the findings and the budget", async () => {
    const { router } = makeRouter();
    const findings = res();
    await callRoute(router, "get", "/myrmidon/companies/:companyId/foraging/findings", req(boardActor, { companyId: "company-a" }), findings.double);
    expect(findings.out.body).toMatchObject({ findings: [{ id: "finding-1", skillKey: "foraged-engineer" }] });

    const budget = res();
    await callRoute(router, "get", "/myrmidon/companies/:companyId/foraging/budget", req(boardActor, { companyId: "company-a" }), budget.double);
    expect(budget.out.body).toMatchObject({ enabled: true, spentCents: 4, budget: { maxCostCents: 50 } });
  });

  it("runs a pass for a board actor and answers the counters", async () => {
    const { router } = makeRouter();
    const { double, out } = res();
    await callRoute(router, "post", "/myrmidon/companies/:companyId/foraging/sweep", req(boardActor, { companyId: "company-a" }), double);
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ sourcesRead: 1, findings: 1, stoppedByBudget: false });
  });

  it("answers 503 on a manual pass while the sweep is switched off", async () => {
    const { router } = makeRouter(fakeStore(), { enabled: false });
    const { double, out } = res();
    await callRoute(router, "post", "/myrmidon/companies/:companyId/foraging/sweep", req(boardActor, { companyId: "company-a" }), double);
    expect(out.status).toBe(503);
    expect(out.body).toMatchObject({ enabled: false });
  });
});