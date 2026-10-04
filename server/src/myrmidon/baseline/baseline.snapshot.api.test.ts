// server/src/myrmidon/baseline/baseline.snapshot.api.test.ts
//
// myrmidon(1.6.2-BASELINE): route contract tests for the snapshot endpoints.
//
//   POST /api/myrmidon/companies/:companyId/baseline/snapshots {from,to,label,pinned}
//   GET  /api/myrmidon/companies/:companyId/baseline/snapshots
//   GET  /api/myrmidon/companies/:companyId/baseline/snapshots/:snapshotId
//
// Same route-contract style as baseline.myrmidon.test.ts: the compute port is
// injected, the actor is fixed on the request, and the DB-write half (insert,
// unpin-on-pin, reads) runs against an in-memory stub that records the
// drizzle call chains. Neutral data only: agent-a, example.test.

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { BaselineMetricsResponse } from "./service.js";
import type { BaselineWindow } from "./metrics.js";
import { baselineRoutes } from "./routes.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";

const FROM = "2026-09-19T08:28:00.000Z";
const TO = "2026-10-03T08:28:00.000Z";

const board = {
  type: "board",
  source: "session",
  userId: "user-a",
  isInstanceAdmin: true,
  companyIds: [COMPANY],
  memberships: [{ companyId: COMPANY, membershipRole: "owner", status: "active" }],
};

const agentActor = {
  type: "agent",
  agentId: "agent-a",
  companyId: COMPANY,
};

const anonymous = { type: "none" };

function metricsAnswer(window: BaselineWindow): BaselineMetricsResponse {
  return {
    window: { from: window.from.toISOString(), to: window.to.toISOString() },
    generatedAt: "2026-10-04T00:00:00.000Z",
    source: { statusLog: "activity_log", costs: "litellm_cost_events" as const },
    byProject: [],
    byRole: [],
  };
}

type Recorded = { op: string; values?: unknown; where?: unknown; set?: unknown };

/**
 * Stands in for the drizzle insert/update/select chains: records every op and
 * resolves like drizzle (insert().values().returning() → rows, select → rows).
 */
function stubDb() {
  const calls: Recorded[] = [];
  const rows = [
    {
      id: "snap-1",
      companyId: COMPANY,
      windowFrom: new Date(FROM),
      windowTo: new Date(TO),
      generatedAt: new Date("2026-10-04T00:00:00Z"),
      payload: {},
      label: null,
      pinned: true,
    },
  ];
  const chain = (op: string) => {
    const record: Record<string, unknown> = {};
    record.values = (values: unknown) => {
      calls.push({ op, values });
      return record;
    };
    record.set = (set: unknown) => {
      calls.push({ op, set });
      return record;
    };
    record.where = (where?: unknown) => {
      if (where !== undefined) calls.push({ op, where });
      return record;
    };
    record.limit = () => record;
    record.from = () => record;
    record.returning = () => Promise.resolve(rows);
    record.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject);
    return record;
  };
  const db = {
    insert: () => chain("insert"),
    update: () => chain("update"),
    select: () => chain("select"),
  } as unknown as Db;
  return { db, calls };
}

function app(actor: unknown, db: Db, compute: ReturnType<typeof vi.fn>) {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  server.use("/api", baselineRoutes(db, { now: () => new Date("2026-10-04T00:00:00Z"), compute }));
  return server;
}

describe("myrmidon(1.6.2-BASELINE) snapshot routes", () => {
  it("creates a pinned snapshot for a board actor over the 19.09→03.10 window", async () => {
    const { db, calls } = stubDb();
    const compute = vi.fn(async (_db: Db, _companyId: string, window: BaselineWindow) =>
      metricsAnswer(window),
    );
    const response = await request(app(board, db, compute))
      .post(`/api/myrmidon/companies/${COMPANY}/baseline/snapshots`)
      .send({ from: FROM, to: TO, label: "pre-pilot", pinned: true });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(compute).toHaveBeenCalledTimes(1);
    expect((compute.mock.calls[0]![2] as BaselineWindow).from).toEqual(new Date(FROM));
    expect((compute.mock.calls[0]![2] as BaselineWindow).to).toEqual(new Date(TO));

    const insert = calls.find((c) => c.op === "insert" && c.values);
    expect(insert, "an insert must run").toBeDefined();
    const values = insert!.values as Record<string, unknown>;
    expect(values.companyId).toBe(COMPANY);
    expect(values.windowFrom).toEqual(new Date(FROM));
    expect(values.windowTo).toEqual(new Date(TO));
    expect(values.label).toBe("pre-pilot");
    // pinning first unpins the previous pinned snapshot of this company
    const update = calls.find((c) => c.op === "update");
    expect(update, "pinning must unpin the previous snapshot").toBeDefined();
    expect((update!.set as Record<string, unknown>).pinned).toBe(false);
  });

  it("an agent key receives 403 on creation", async () => {
    const { db } = stubDb();
    const compute = vi.fn();
    const response = await request(app(agentActor, db, compute))
      .post(`/api/myrmidon/companies/${COMPANY}/baseline/snapshots`)
      .send({ from: FROM, to: TO, label: "agent attempt", pinned: false });

    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(compute).not.toHaveBeenCalled();
  });

  it("an anonymous caller receives 401 on creation", async () => {
    const { db } = stubDb();
    const compute = vi.fn();
    const response = await request(app(anonymous, db, compute))
      .post(`/api/myrmidon/companies/${COMPANY}/baseline/snapshots`)
      .send({ from: FROM, to: TO });

    expect(response.status, JSON.stringify(response.body)).toBe(401);
    expect(compute).not.toHaveBeenCalled();
  });

  it("requires both window bounds", async () => {
    const { db } = stubDb();
    const compute = vi.fn();
    const missing = await request(app(board, db, compute))
      .post(`/api/myrmidon/companies/${COMPANY}/baseline/snapshots`)
      .send({ to: TO, label: "missing from" });
    expect(missing.status, JSON.stringify(missing.body)).toBe(400);
    expect(compute).not.toHaveBeenCalled();
  });

  it("rejects an inverted window", async () => {
    const { db } = stubDb();
    const compute = vi.fn();
    const inverted = await request(app(board, db, compute))
      .post(`/api/myrmidon/companies/${COMPANY}/baseline/snapshots`)
      .send({ from: TO, to: FROM });
    expect(inverted.status, JSON.stringify(inverted.body)).toBe(400);
    expect(compute).not.toHaveBeenCalled();
  });

  it("list and single-snapshot reads run for a board actor", async () => {
    const { db } = stubDb();
    const compute = vi.fn();
    const list = await request(app(board, db, compute))
      .get(`/api/myrmidon/companies/${COMPANY}/baseline/snapshots`);
    expect(list.status, JSON.stringify(list.body)).toBe(200);

    const one = await request(app(board, db, compute))
      .get(`/api/myrmidon/companies/${COMPANY}/baseline/snapshots/snap-1`);
    expect(one.status, JSON.stringify(one.body)).toBe(200);
  });
});
