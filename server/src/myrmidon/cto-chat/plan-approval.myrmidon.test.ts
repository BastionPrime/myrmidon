/**
 * Guard for myrmidon(1.6-CTO-CHAT-B): the parts where a mistake is invisible
 * until the owner is affected.
 *
 * Two halves, both against a real database (embedded postgres, as the vendor
 * does — no live network, no keys):
 *
 *  - the approval card: a proposal must become a pending `suggest_tasks` card on
 *    the task it was asked from, the same plan id must not stack a second card,
 *    and NOTHING may be created before the card is accepted;
 *  - the Telegram entry: a bridge turn must reach the same planner and produce
 *    the same card, and a turn that cannot be planned must come back as a
 *    reportable outcome instead of an exception in the middle of a chat.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  issues,
  issueThreadInteractions,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { ctoChatPlanSchema, type CtoChatPlan } from "@paperclipai/shared";
import {
  createCtoChatPlanApproval,
  ctoChatApprovalIdempotencyKey,
} from "./plan-approval.js";
import { planFromTelegramTurn, describeTelegramOutcome } from "./telegram-entry.js";
import { DEFAULT_CTO_CHAT_MODEL, type CtoChatSettings } from "./settings.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function plan(overrides: Partial<CtoChatPlan> = {}): CtoChatPlan {
  return ctoChatPlanSchema.parse({
    planId: `plan-${randomUUID()}`,
    epicClientKey: "epic",
    epic: { title: "Ship the weekly report", acceptanceCriteria: ["Numbers match the ledger"] },
    tasks: [
      { clientKey: "api", title: "Report API", acceptanceCriteria: ["Empty week returns zeros"] },
      { clientKey: "page", title: "Report page" },
    ],
    ...overrides,
  });
}

function settings(overrides: Partial<CtoChatSettings> = {}): CtoChatSettings {
  return {
    enabled: true,
    baseUrl: "https://gateway.example.com/v1",
    keySecret: "cto-chat-key",
    model: DEFAULT_CTO_CHAT_MODEL,
    timeoutMs: 5_000,
    maxTasks: 8,
    ...overrides,
  };
}

function gateway(content: string) {
  return (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content } }] }),
    }) as unknown as Response) as unknown as typeof fetch;
}

const GOOD_ANSWER = JSON.stringify({
  epic: { title: "Add a weekly report page", acceptanceCriteria: ["Numbers match the ledger"] },
  tasks: [{ clientKey: "api", title: "Report API", acceptanceCriteria: ["Empty week returns zeros"] }],
});

describeEmbeddedPostgres("myrmidon(1.6-CTO-CHAT-B) approval and Telegram entry", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-cto-chat-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(issueThreadInteractions);
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
    await db.insert(companies).values({ id: companyId, name: "Example Co", issuePrefix: "EX" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "agent-a",
      role: "engineer",
      adapterType: "process",
      status: "active",
    });
    const [hostIssue] = await db
      .insert(issues)
      .values({
        companyId,
        title: "Chat with agent-a",
        status: "in_review",
        priority: "medium",
        assigneeAgentId: agentId,
      })
      .returning();
    return { companyId, agentId, hostIssueId: hostIssue!.id };
  }

  async function interactionsFor(companyId: string, issueId: string) {
    return db
      .select()
      .from(issueThreadInteractions)
      .where(and(eq(issueThreadInteractions.companyId, companyId), eq(issueThreadInteractions.issueId, issueId)));
  }

  it("posts a pending card for the proposal and creates no task before it is accepted", async () => {
    const { companyId, agentId, hostIssueId } = await seed();
    const proposal = plan();

    const card = await createCtoChatPlanApproval(
      { plan: proposal, hostIssueId, companyId, createdByAgentId: agentId },
      { db },
    );

    expect(card.interactionId).toBeTruthy();
    const rows = await interactionsFor(companyId, hostIssueId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("suggest_tasks");
    expect(rows[0]!.status).toBe("pending");

    // The card carries the epic first and its children parented on it.
    const payload = rows[0]!.payload as { tasks: Array<{ clientKey: string; parentClientKey: string | null }> };
    expect(payload.tasks.map((task) => [task.clientKey, task.parentClientKey])).toEqual([
      ["epic", null],
      ["api", "epic"],
      ["page", "epic"],
    ]);

    // Nothing exists yet but the host task itself.
    const all = await db.select().from(issues).where(eq(issues.companyId, companyId));
    expect(all).toHaveLength(1);
    expect(all[0]!.title).toBe("Chat with agent-a");
  });

  it("reuses the card for a repeated plan id instead of stacking a second one", async () => {
    const { companyId, agentId, hostIssueId } = await seed();
    const proposal = plan();
    expect(ctoChatApprovalIdempotencyKey(proposal.planId)).toContain(proposal.planId);

    await createCtoChatPlanApproval({ plan: proposal, hostIssueId, companyId, createdByAgentId: agentId }, { db });
    await createCtoChatPlanApproval({ plan: proposal, hostIssueId, companyId, createdByAgentId: agentId }, { db });

    expect(await interactionsFor(companyId, hostIssueId)).toHaveLength(1);
  });

  it("plans a Telegram turn into the same card on the conversation task", async () => {
    const { companyId, agentId, hostIssueId } = await seed();
    const outcome = await planFromTelegramTurn(
      { companyId, hostIssueId, text: "Please plan a weekly report page", agentId },
      {
        db,
        settings: settings(),
        fetch: gateway(GOOD_ANSWER),
        mintPlanId: () => `plan-${randomUUID()}`,
        readCompanyKey: async () => "test-key",
      },
    );

    expect(outcome.kind).toBe("card");
    if (outcome.kind !== "card") throw new Error("expected a card");
    expect(outcome.plan.epic.title).toBe("Add a weekly report page");
    const rows = await interactionsFor(companyId, hostIssueId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("suggest_tasks");

    // The owner gets a reply naming the proposal, not a stack trace.
    const reply = describeTelegramOutcome(outcome, "https://board.example.com/EX/issues/EX-1");
    expect(reply).toContain("Add a weekly report page");
    expect(reply).toContain("https://board.example.com/EX/issues/EX-1");
  });

  it("reports a bridge turn it cannot plan instead of throwing into the chat", async () => {
    const { companyId, agentId, hostIssueId } = await seed();
    const unavailable = await planFromTelegramTurn(
      { companyId, hostIssueId, text: "Plan something", agentId },
      {
        db,
        settings: settings({ baseUrl: null, keySecret: null, enabled: false }),
        fetch: gateway(GOOD_ANSWER),
        mintPlanId: () => "plan-1",
        readCompanyKey: async () => null,
      },
    );
    expect(unavailable.kind).toBe("unavailable");
    expect(describeTelegramOutcome(unavailable, null)).toContain("cannot plan");

    const rejected = await planFromTelegramTurn(
      { companyId, hostIssueId, text: "   ", agentId },
      {
        db,
        settings: settings(),
        fetch: gateway(GOOD_ANSWER),
        mintPlanId: () => "plan-1",
        readCompanyKey: async () => "test-key",
      },
    );
    expect(rejected).toMatchObject({ kind: "rejected", code: "empty_message" });
    expect(describeTelegramOutcome(rejected, null)).toContain("could not turn that into a plan");
    // A rejected turn leaves the board untouched.
    expect(await interactionsFor(companyId, hostIssueId)).toHaveLength(0);
  });
});