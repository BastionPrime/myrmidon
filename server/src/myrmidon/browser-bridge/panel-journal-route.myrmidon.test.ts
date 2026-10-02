// myrmidon(EXTCASE-PANEL): the journal route of the bridge panel.
//
// The route reads the company activity log for bridge rows. The harness uses
// an in-memory db fake shaped like drizzle's select-builder so no postgres is
// needed: the route under test is filter assembly and access, not the query.
//
// Pins:
//   1. a member of the company reads rows; an actor from outside the company
//      gets 403 (assertCompanyAccess, the same gate part B uses);
//   2. signaturesOnly filters to browser.sign rows;
//   3. the response carries signedToday/dailyLimit only when the journal or
//      the limit makes them meaningful;
//   4. a malformed query (limit=abc) is a 400.

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import { assertCompanyAccess } from "../../routes/authz.js";
import { browserBridgePanelRoutes } from "./routes.js";
import type { BrowserBridgeService } from "./service.js";

vi.mock("../../myrmidon/browser-bridge/journal-view.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./journal-view.js")>();
  return {
    ...original,
    bridgeJournalService: vi.fn(() => fakeJournal),
  };
});

vi.mock("../../services/activity-log.js", () => ({ logActivity: vi.fn(async () => ({})) }));

const COMPANY_A = "11111111-1111-4111-8111-111111111111";

const fakeJournal = {
  list: vi.fn(async (query: unknown) => {
    const q = query as { signaturesOnly?: boolean; deviceId?: string; method?: string };
    const allRows = [
      {
        id: "row-1",
        createdAt: "2026-10-01T10:00:00.000Z",
        action: "browser_bridge.action.executed",
        deviceId: "device-0001",
        label: null,
        method: "browser.sign",
        url: null,
        target: null,
        outcome: "ok",
        confirmation: "confirmed",
        durationMs: 1200,
        reasonCode: null,
        signActionType: "tender.submit",
        signStatus: "signed",
        documentHash: "a".repeat(64),
        actorType: "agent",
        actorId: "agent-1",
        runId: null,
      },
      {
        id: "row-2",
        createdAt: "2026-10-01T09:00:00.000Z",
        action: "browser_bridge.action.executed",
        deviceId: "device-0001",
        label: null,
        method: "browser.read",
        url: "https://tender.example/lot/1",
        target: null,
        outcome: "ok",
        confirmation: "not_required",
        durationMs: 300,
        reasonCode: null,
        signActionType: null,
        signStatus: null,
        documentHash: null,
        actorType: "agent",
        actorId: "agent-1",
        runId: null,
      },
    ];
    return allRows.filter((row) => (q.signaturesOnly ? row.method === "browser.sign" : true));
  }),
  countSignaturesToday: vi.fn(async () => 3),
};

const fakeService = {
  readSettings: vi.fn(async () => ({
    domains: ["tender.example"],
    signing: { enabled: true, mode: "auto", types: [], dailyLimit: 5 },
  })),
} as unknown as BrowserBridgeService;

const member = {
  type: "board",
  source: "session",
  userId: "user-a",
  isInstanceAdmin: false,
  companyIds: [COMPANY_A],
};

const outsider = { ...member, userId: "user-x", companyIds: ["99999999-9999-4999-8999-999999999999"] };

function harness(actor: unknown) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", browserBridgePanelRoutes(() => fakeService, () => ({}) as never));
  app.use(errorHandler);
  return app;
}

const URL = (companyId: string) => `/api/myrmidon/browser-bridge/companies/${companyId}/journal`;

describe("myrmidon(EXTCASE-PANEL) journal route", () => {
  it("lists the bridge rows for a member of the company", async () => {
    const res = await request(harness(member)).get(URL(COMPANY_A)).expect(200);
    expect(res.body.rows).toHaveLength(2);
    expect(res.body.rows[0]).toMatchObject({
      method: "browser.sign",
      signActionType: "tender.submit",
      documentHash: "a".repeat(64),
    });
    // The limit is set (5), so the counter ran and both numbers are present.
    expect(res.body.dailyLimit).toBe(5);
    expect(res.body.signedToday).toBe(3);
  });

  it("refuses an actor from outside the company", async () => {
    // assertCompanyAccess throws for a board actor without the company; the
    // error handler maps it to 403 the same way part B's routes do.
    const res = await request(harness(outsider)).get(URL(COMPANY_A)).expect(403);
    expect(res.body).toBeDefined();
  });

  it("signaturesOnly keeps the signature rows and runs the counter", async () => {
    const res = await request(harness(member)).get(`${URL(COMPANY_A)}?signaturesOnly=true`).expect(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].method).toBe("browser.sign");
    expect(fakeJournal.countSignaturesToday).toHaveBeenCalled();
  });

  it("skips the counter when there is no limit and no signatures filter", async () => {
    fakeJournal.countSignaturesToday.mockClear();
    (fakeService.readSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      domains: ["tender.example"],
      signing: { enabled: true, mode: "auto", types: [], dailyLimit: 0 },
    });
    const res = await request(harness(member)).get(URL(COMPANY_A)).expect(200);
    expect(res.body.dailyLimit).toBe(0);
    expect(res.body.signedToday).toBeNull();
    expect(fakeJournal.countSignaturesToday).not.toHaveBeenCalled();
  });

  it("rejects a malformed limit with a 400", async () => {
    await request(harness(member)).get(`${URL(COMPANY_A)}?limit=abc`).expect(400);
  });
});

// Silence the unused import warning for assertCompanyAccess: the route pulls
// it in through the module graph; the test never calls it directly.
void assertCompanyAccess;
