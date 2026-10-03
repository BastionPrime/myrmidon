// myrmidon(PARALLEL-HELPERS): the parallel-helpers routes.
//
// The routes run over the real service with fake ports (settings row, audit
// sink, agents walk), so validation, permissions, the audit record and the
// capacity hint are all exercised without a database.

import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { errorHandler } from "../../middleware/index.js";
import { parallelHelpersRoutes } from "./routes.js";
import { PARALLEL_HELPERS_ACTION, parallelHelpersService, type ParallelHelpersServiceDeps } from "./service.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

const member = {
  type: "board",
  source: "session",
  userId: "user-a",
  isInstanceAdmin: false,
  companyIds: [COMPANY_ID],
};
const admin = { ...member, userId: "user-b", isInstanceAdmin: true };
const outsider = { ...member, userId: "user-c", companyIds: [] };
const agentActor = {
  type: "agent",
  source: "agent_key",
  agentId: "11111111-1111-4111-8111-111111111111",
  companyId: COMPANY_ID,
  keyId: "key-a",
};

interface HarnessOptions {
  stored?: unknown;
  companyIds?: string[];
  cards?: Array<{ id: string; name: string; adapterConfig: Record<string, unknown> }>;
}

function harness(options: HarnessOptions = {}) {
  const calls: string[] = [];
  const updated: Array<{ parallelHelpers: unknown }> = [];
  const audits: Array<Record<string, unknown>> = [];
  const current = { stored: options.stored as unknown };

  const deps: Partial<ParallelHelpersServiceDeps> = {
    settings: {
      getGeneral: async () => ({ parallelHelpers: current.stored }),
      updateGeneral: async (patch: { parallelHelpers: unknown }) => {
        current.stored = patch.parallelHelpers;
        updated.push(patch as { parallelHelpers: unknown });
        calls.push("write");
        return {};
      },
    },
    listCompanyIds: async () => options.companyIds ?? [COMPANY_ID],
    logActivity: async (entry) => {
      audits.push(entry as unknown as Record<string, unknown>);
      calls.push("audit");
    },
    listCards: async () => options.cards ?? [],
  };

  const withActor = (actor: unknown) => {
    const scoped = express();
    scoped.use(express.json());
    scoped.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = actor;
      next();
    });
    scoped.use("/api", parallelHelpersRoutes({} as Db, parallelHelpersService({} as Db, deps)));
    scoped.use(errorHandler);
    return scoped;
  };
  return { app: withActor(member), withActor, calls, updated, audits };
}

const URL = "/api/myrmidon/parallel-helpers";

describe("myrmidon(PARALLEL-HELPERS) routes: reading the settings and hint", () => {
  it("reports module defaults and a hint with no agents", async () => {
    const { app } = harness();
    const res = await request(app).get(URL).expect(200);
    expect(res.body.settings).toEqual({});
    expect(res.body.effective).toEqual({ ceiling: 10, defaultPerAgent: 2 });
    expect(res.body.capacity).toMatchObject({ requestedTotal: 0, enabledAgents: 0, warning: null });
  });

  it("sums the enabled agents' limits into the hint, resolved like the compiler", async () => {
    const { app } = harness({
      stored: { maxPerAgent: 6 },
      cards: [
        { id: "a", name: "A", adapterConfig: { parallelHelpers: { enabled: true, maxConcurrent: 4 } } },
        // Over the ceiling: the hint counts the RESOLVED value (6), not the raw 99.
        { id: "b", name: "B", adapterConfig: { parallelHelpers: { enabled: true, maxConcurrent: 99 } } },
        { id: "c", name: "C", adapterConfig: { parallelHelpers: { enabled: false, maxConcurrent: 8 } } },
        { id: "d", name: "D", adapterConfig: {} },
      ],
    });
    const res = await request(app).get(URL).expect(200);
    expect(res.body.capacity).toMatchObject({ requestedTotal: 10, enabledAgents: 2 });
  });

  it("is readable by a board member, denied for an agent and an outsider", async () => {
    // Agents are denied on purpose: this is an operator settings surface, the
    // same rule runtime-limits follows (assertBoardOrgAccess).
    const { app, withActor } = harness();
    await request(app).get(URL).expect(200);
    await request(withActor(agentActor)).get(URL).expect(403);
    await request(withActor(outsider)).get(URL).expect(403);
  });
});

describe("myrmidon(PARALLEL-HELPERS) routes: writing the settings", () => {
  it("is instance-admin only", async () => {
    const { withActor, updated } = harness();
    await request(withActor(admin)).patch(URL).send({ maxPerAgent: 6 }).expect(200);
    expect(updated).toHaveLength(1);
    await request(withActor(member)).patch(URL).send({ maxPerAgent: 6 }).expect(403);
    await request(withActor(agentActor)).patch(URL).send({ maxPerAgent: 6 }).expect(403);
    expect(updated).toHaveLength(1);
  });

  it("persists a partial patch and audits the change for every company", async () => {
    const { withActor, updated, audits } = harness({
      stored: { maxPerAgent: 5, defaultMaxPerAgent: 2 },
      companyIds: [COMPANY_ID, "33333333-3333-4333-8333-333333333333"],
    });
    const app = withActor(admin);
    const res = await request(app).patch(URL).send({ defaultMaxPerAgent: 3 }).expect(200);
    // Only the patched field changed; the ceiling survives.
    expect(updated[0]?.parallelHelpers).toEqual({ maxPerAgent: 5, defaultMaxPerAgent: 3 });
    expect(res.body.settings).toEqual({ maxPerAgent: 5, defaultMaxPerAgent: 3 });
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({ action: PARALLEL_HELPERS_ACTION, entityType: "instance_settings" });
    expect(audits[0]?.details).toMatchObject({ changedKeys: ["defaultMaxPerAgent"] });
  });

  it("rejects invalid bodies with 400", async () => {
    const { app, updated } = harness();
    await request(app).patch(URL).send({ maxPerAgent: 0 }).expect(400);
    await request(app).patch(URL).send({ maxPerAgent: 2.5 }).expect(400);
    await request(app).patch(URL).send({ unknown: true }).expect(400);
    expect(updated).toHaveLength(0);
  });
});
