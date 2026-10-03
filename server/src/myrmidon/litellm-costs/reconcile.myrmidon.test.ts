// server/src/myrmidon/litellm-costs/reconcile.myrmidon.test.ts
//
// myrmidon(HERMES-USAGE-COST): tests for the post-sweep reconcile pass that
// fills the vendor cost ledger's unpriced hermes_gateway rows with the
// gateway-collected spend (litellm_cost_events), and refreshes the
// agent/company monthly-spend counters.

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  costEvents,
  createDb,
  heartbeatRuns,
  litellmCostEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { reconcileUnpricedCostEventsDetailed } from "./reconcile.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

describeEmbeddedPostgres("myrmidon(HERMES-USAGE-COST) reconcileUnpricedCostEvents", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-litellm-reconcile-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(litellmCostEvents);
    await db.delete(costEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const company = await db
      .insert(companies)
      .values({
        name: `company-r ${randomUUID()}`,
        issuePrefix: `RC${randomUUID().slice(0, 6).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);
    const agent = await db
      .insert(agents)
      .values({
        companyId: company.id,
        name: "agent-r",
        role: "engineer",
        permissions: {},
        adapterType: "hermes_gateway",
        adapterConfig: {},
        runtimeConfig: {},
      })
      .returning()
      .then((rows) => rows[0]!);
    return { company, agent };
  }

  async function seedRun(opts: {
    companyId: string;
    agentId: string;
    startedAt: Date;
    finishedAt: Date | null;
  }) {
    return db
      .insert(heartbeatRuns)
      .values({
        companyId: opts.companyId,
        agentId: opts.agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: opts.finishedAt ? "succeeded" : "running",
        startedAt: opts.startedAt,
        finishedAt: opts.finishedAt,
        contextSnapshot: { issueId: randomUUID() },
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function seedUnpricedCostEvent(opts: {
    companyId: string;
    agentId: string;
    runId: string;
    provider?: string;
    occurredAt: Date;
  }) {
    return db
      .insert(costEvents)
      .values({
        companyId: opts.companyId,
        agentId: opts.agentId,
        heartbeatRunId: opts.runId,
        provider: opts.provider ?? "hermes_gateway",
        biller: opts.provider ?? "hermes_gateway",
        billingType: "unknown",
        costStatus: "unpriced",
        model: "dashscope-example-model",
        inputTokens: 100,
        outputTokens: 50,
        costCents: 0,
        occurredAt: opts.occurredAt,
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function seedLitellmSpend(opts: {
    companyId: string;
    agentId: string;
    runId: string;
    costCents: number;
    occurredAt: Date;
  }) {
    return db
      .insert(litellmCostEvents)
      .values({
        id: `${opts.companyId}:${randomUUID()}`,
        companyId: opts.companyId,
        agentId: opts.agentId,
        heartbeatRunId: opts.runId,
        provider: "dashscope",
        model: "dashscope-example-model",
        inputTokens: 100,
        outputTokens: 50,
        costCents: opts.costCents,
        occurredAt: opts.occurredAt,
        requestId: randomUUID(),
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  it("fills an unpriced hermes_gateway cost event with its run's collected spend", async () => {
    const { company, agent } = await seedCompany();
    const startedAt = new Date("2026-10-01T10:00:00Z");
    const run = await seedRun({
      companyId: company.id,
      agentId: agent.id,
      startedAt,
      finishedAt: new Date("2026-10-01T10:20:00Z"),
    });
    const event = await seedUnpricedCostEvent({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
      occurredAt: new Date("2026-10-01T10:20:00Z"),
    });
    await seedLitellmSpend({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
      costCents: 413,
      occurredAt: new Date("2026-10-01T10:05:00Z"),
    });

    const result = await reconcileUnpricedCostEventsDetailed(db, company.id);

    expect(result).toEqual({ updated: 1, stillUnpriced: 0 });
    const updated = await db.select().from(costEvents).where(eqId(event.id));
    expect(updated[0]!.costCents).toBe(413);
    expect(updated[0]!.costStatus).toBe("reported");
  });

  it("sums several collected spend rows for one run", async () => {
    const { company, agent } = await seedCompany();
    const run = await seedRun({
      companyId: company.id,
      agentId: agent.id,
      startedAt: new Date("2026-10-02T10:00:00Z"),
      finishedAt: new Date("2026-10-02T11:00:00Z"),
    });
    const event = await seedUnpricedCostEvent({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
      occurredAt: new Date("2026-10-02T11:00:00Z"),
    });
    await seedLitellmSpend({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
      costCents: 100,
      occurredAt: new Date("2026-10-02T10:10:00Z"),
    });
    await seedLitellmSpend({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
      costCents: 23,
      occurredAt: new Date("2026-10-02T10:40:00Z"),
    });

    const result = await reconcileUnpricedCostEventsDetailed(db, company.id);
    expect(result.updated).toBe(1);
    const updated = await db.select().from(costEvents).where(eqId(event.id));
    expect(updated[0]!.costCents).toBe(123);
  });

  it("leaves a run with no collected spend unpriced (never invents a price)", async () => {
    const { company, agent } = await seedCompany();
    const run = await seedRun({
      companyId: company.id,
      agentId: agent.id,
      startedAt: new Date("2026-10-02T12:00:00Z"),
      finishedAt: new Date("2026-10-02T12:30:00Z"),
    });
    const event = await seedUnpricedCostEvent({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
      occurredAt: new Date("2026-10-02T12:30:00Z"),
    });

    const result = await reconcileUnpricedCostEventsDetailed(db, company.id);
    expect(result).toEqual({ updated: 0, stillUnpriced: 1 });
    const unchanged = await db.select().from(costEvents).where(eqId(event.id));
    expect(unchanged[0]!.costStatus).toBe("unpriced");
    expect(unchanged[0]!.costCents).toBe(0);
  });

  it("does not touch priced rows or other providers' unpriced rows", async () => {
    const { company, agent } = await seedCompany();
    const startedAt = new Date("2026-10-03T08:00:00Z");
    const runA = await seedRun({
      companyId: company.id,
      agentId: agent.id,
      startedAt,
      finishedAt: new Date("2026-10-03T08:30:00Z"),
    });
    // a priced hermes_gateway row (adapter reported its own cost)
    const priced = await db
      .insert(costEvents)
      .values({
        companyId: company.id,
        agentId: agent.id,
        heartbeatRunId: runA.id,
        provider: "hermes_gateway",
        biller: "hermes_gateway",
        billingType: "metered_api",
        costStatus: "reported",
        model: "dashscope-example-model",
        inputTokens: 10,
        outputTokens: 5,
        costCents: 77,
        occurredAt: new Date("2026-10-03T08:30:00Z"),
      })
      .returning()
      .then((rows) => rows[0]!);
    // an unpriced row of a DIFFERENT provider
    const other = await seedUnpricedCostEvent({
      companyId: company.id,
      agentId: agent.id,
      runId: runA.id,
      provider: "dashscope",
      occurredAt: new Date("2026-10-03T08:30:00Z"),
    });
    await seedLitellmSpend({
      companyId: company.id,
      agentId: agent.id,
      runId: runA.id,
      costCents: 999,
      occurredAt: new Date("2026-10-03T08:10:00Z"),
    });

    await reconcileUnpricedCostEventsDetailed(db, company.id);

    const pricedRow = await db.select().from(costEvents).where(eqId(priced.id));
    expect(pricedRow[0]!.costCents).toBe(77); // untouched
    const otherRow = await db.select().from(costEvents).where(eqId(other.id));
    expect(otherRow[0]!.costStatus).toBe("unpriced"); // untouched
  });

  it("refreshes agent and company monthly spend counters after filling rows", async () => {
    const { company, agent } = await seedCompany();
    const run = await seedRun({
      companyId: company.id,
      agentId: agent.id,
      startedAt: new Date("2026-10-01T09:00:00Z"),
      finishedAt: new Date("2026-10-01T09:40:00Z"),
    });
    await seedUnpricedCostEvent({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
      occurredAt: new Date("2026-10-01T09:40:00Z"),
    });
    await seedLitellmSpend({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
      costCents: 515,
      occurredAt: new Date("2026-10-01T09:10:00Z"),
    });

    await reconcileUnpricedCostEventsDetailed(db, company.id);

    const [agentRow] = await db.select().from(agents).where(eq(agents.id, agent.id));
    expect(agentRow.spentMonthlyCents).toBe(515);
    const [companyRow] = await db.select().from(companies).where(eq(companies.id, company.id));
    expect(companyRow.spentMonthlyCents).toBe(515);
  });

  it("is idempotent: a second pass finds nothing to fill", async () => {
    const { company, agent } = await seedCompany();
    const run = await seedRun({
      companyId: company.id,
      agentId: agent.id,
      startedAt: new Date("2026-10-01T14:00:00Z"),
      finishedAt: new Date("2026-10-01T14:20:00Z"),
    });
    await seedUnpricedCostEvent({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
      occurredAt: new Date("2026-10-01T14:20:00Z"),
    });
    await seedLitellmSpend({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
      costCents: 42,
      occurredAt: new Date("2026-10-01T14:05:00Z"),
    });

    const first = await reconcileUnpricedCostEventsDetailed(db, company.id);
    expect(first.updated).toBe(1);
    const second = await reconcileUnpricedCostEventsDetailed(db, company.id);
    expect(second).toEqual({ updated: 0, stillUnpriced: 0 });
  });
});

function eqId(id: string) {
  return eq(costEvents.id, id as never);
}
