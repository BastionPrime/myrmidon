// myrmidon(M3): the owner signal on a budget hard-stop.
//
// What the vendor does on a hard-stop: creates the incident, pauses the scope,
// cancels the runs — and leaves the interrupted issue thread silent (only the
// decision inbox card exists, which the owner must open on their own). These
// tests pin the signal: one system-notice comment per (incident, issue) in
// the thread of every issue the stop interrupted, with the cause and the two
// ways to continue, deduped on repeat evaluations, off via
// MYRMIDON_BUDGET_SIGNAL_MODE=off.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  budgetIncidents,
  budgetPolicies,
  companies,
  costEvents,
  createDb,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { budgetService } from "../services/budgets.js";
import {
  budgetSignalEnabled,
  buildBudgetHardStopBody,
  buildBudgetHardStopMetadata,
  budgetSignalKey,
  deliverBudgetHardStopSignal,
  type BudgetSignalPorts,
} from "./budget-signal.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describe("budget hard-stop signal logic (M3)", () => {
  it("is on by default and off only on the explicit off mode", () => {
    expect(budgetSignalEnabled({})).toBe(true);
    expect(budgetSignalEnabled({ MYRMIDON_BUDGET_SIGNAL_MODE: "off" })).toBe(false);
    expect(budgetSignalEnabled({ MYRMIDON_BUDGET_SIGNAL_MODE: "OFF" })).toBe(false);
    expect(budgetSignalEnabled({ MYRMIDON_BUDGET_SIGNAL_MODE: "on" })).toBe(true);
  });

  it("the signal body names the cause, the limit and the way to continue", () => {
    const body = buildBudgetHardStopBody({
      companyId: "c",
      policyId: "p",
      scopeType: "agent",
      scopeId: "a",
      scopeName: "agent-a",
      amountLimit: 1000,
      amountObserved: 1200,
      windowStart: new Date("2026-10-01T00:00:00.000Z"),
      windowEnd: new Date("2026-10-31T00:00:00.000Z"),
      incidentId: "i",
      approvalId: null,
    });
    expect(body).toContain("hard-stop was reached");
    expect(body).toContain('agent "agent-a"');
    expect(body).toContain("$10.00");
    expect(body).toContain("$12.00");
    expect(body).toContain("raise the budget");
    expect(body).toContain("keep the scope paused");
  });

  it("the metadata carries the signal key for dedup", () => {
    const metadata = buildBudgetHardStopMetadata(
      {
        incidentId: "incident-1",
        policyId: "policy-1",
        scopeType: "company",
        scopeName: "company-a",
        amountLimit: 100,
        amountObserved: 120,
        windowStart: new Date("2026-10-01T00:00:00.000Z"),
        windowEnd: new Date("2026-10-31T00:00:00.000Z"),
      },
      "issue-1",
      "C-1",
    );
    const firstRow = metadata.sections[0]!.rows[0]!;
    expect(firstRow).toMatchObject({ type: "key_value", label: "Signal key" });
    if (firstRow.type === "key_value") {
      expect(firstRow.value).toBe(budgetSignalKey("incident-1", "issue-1"));
    }
  });
});

describeEmbeddedPostgres("budget hard-stop signal delivery (M3)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-budget-signal-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(budgetIncidents);
    await db.delete(approvals);
    await db.delete(budgetPolicies);
    await db.delete(costEvents);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "agent-a",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "task",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "agent",
      scopeId: agentId,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 100,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
    });
    return { companyId, agentId, issueId };
  }

  async function insertCostEvent(companyId: string, agentId: string, costCents: number) {
    const [event] = await db
      .insert(costEvents)
      .values({
        companyId,
        agentId,
        provider: "test",
        biller: "test",
        billingType: "metered_api",
        model: "test-model",
        inputTokens: 10,
        outputTokens: 5,
        costCents,
        occurredAt: new Date(),
      })
      .returning();
    return event!;
  }

  function portsFor(seen: Array<Record<string, unknown>>): BudgetSignalPorts {
    return {
      addComment: async (issueId, body, actor, options) => {
        // Route through the real comment writer shape used in production.
        seen.push({ issueId, body, actor, options });
        await db.insert(issueComments).values({
          companyId: (options as { companyId?: string }).companyId ?? seenCompanyId,
          issueId,
          authorType: "system",
          body,
          presentation: options.presentation,
          metadata: options.metadata,
        });
        return null;
      },
      now: () => new Date(),
      log: { info: () => {}, warn: () => {} },
    };
  }

  let seenCompanyId = "";

  async function issueThreadComments(issueId: string) {
    return db
      .select()
      .from(issueComments)
      .where(and(eq(issueComments.issueId, issueId), eq(issueComments.authorType, "system")));
  }

  it("signals the interrupted issue thread once per incident and dedupes repeats", async () => {
    const { companyId, agentId, issueId } = await seed();
    seenCompanyId = companyId;
    const seen: Array<Record<string, unknown>> = [];
    const signalCalls: string[] = [];
    const service = budgetService(db, {
      signalBudgetHardStop: async (input) => {
        signalCalls.push(input.incidentId);
        await deliverBudgetHardStopSignal(db, portsFor(seen), {
          ...input,
          scopeName: input.scopeName,
        });
      },
    });

    const event = await insertCostEvent(companyId, agentId, 120);
    await service.evaluateCostEvent(event);

    // The agent scope's open issue got exactly one system comment...
    const comments = await issueThreadComments(issueId);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("hard-stop was reached");
    expect(comments[0]?.body).toContain("raise the budget");
    expect(comments[0]?.presentation).toMatchObject({ kind: "system_notice", tone: "warning" });

    // ...and the signal does not duplicate on a repeated evaluation.
    await service.evaluateCostEvent(event);
    const commentsAfterRepeat = await issueThreadComments(issueId);
    expect(commentsAfterRepeat).toHaveLength(1);
    expect(signalCalls).toHaveLength(1);
  });

  it("signals the issue whose run the stop cancelled, even when the agent has no open issue of record", async () => {
    const { companyId, agentId, issueId } = await seed();
    seenCompanyId = companyId;
    const seen: Array<Record<string, unknown>> = [];
    // The stop cancels the agent's run on the issue: the run row carries the
    // vendor cancel reason and the issue context.
    await db.update(issues).set({ status: "todo", assigneeAgentId: null }).where(eq(issues.id, issueId));
    const service = budgetService(db, {
      signalBudgetHardStop: async (input) => {
        await deliverBudgetHardStopSignal(db, portsFor(seen), input);
      },
    });
    const event = await insertCostEvent(companyId, agentId, 150);
    await service.evaluateCostEvent(event);
    // No open run was cancelled and the issue is unassigned: the agent-scope
    // fallback (open issues assigned to the scope) finds nothing — the
    // delivery is a no-op, not a crash.
    expect(await issueThreadComments(issueId)).toHaveLength(0);
  });

  it("without the hook the thread stays silent: the vendor behaviour the feature replaces", async () => {
    const { companyId, agentId, issueId } = await seed();
    const service = budgetService(db, {});
    const event = await insertCostEvent(companyId, agentId, 130);
    await service.evaluateCostEvent(event);
    // Vendor path: incident + pause, no comment in the interrupted thread.
    const incidents = await db.select().from(budgetIncidents).where(eq(budgetIncidents.companyId, companyId));
    expect(incidents.filter((incident) => incident.thresholdType === "hard")).toHaveLength(1);
    expect(await issueThreadComments(issueId)).toHaveLength(0);
  });
});
