// myrmidon(L2): getExecutionBlocker with `explicitWake` — see execution-blocker.ts
// (point of call) and predicate.ts.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { getExecutionBlocker } from "../../services/execution-blocker.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("getExecutionBlocker explicitWake (L2)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-settled-holds-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: `H${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "user-a",
      requireBoardApprovalForNewAgents: false,
    });
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId, companyId, name: "agent-a", role: "engineer", status: "idle",
      adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    const [issue] = await db.insert(issues).values({
      companyId, title: "held", status: "blocked", priority: "medium", assigneeAgentId: agentId,
    }).returning();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId, invocationSource: "assignment", triggerDetail: "system",
      status: "failed", contextSnapshot: { issueId: issue!.id },
    }).returning();
    return { companyId, agentId, issueId: issue!.id, runId: run!.id };
  }

  async function seedAction(input: {
    companyId: string; issueId: string; runId: string;
    status: "active" | "resolved" | "escalated"; replay?: string;
  }) {
    await db.insert(issueRecoveryActions).values({
      companyId: input.companyId, sourceIssueId: input.issueId, kind: "execution_reconciliation",
      status: input.status, cause: "uncertain_provider_action", fingerprint: randomUUID(),
      evidence: { runId: input.runId, ...(input.replay ? { automaticRecovery: { replay: input.replay } } : {}) },
      nextAction: "Automatic recovery stopped.",
    });
  }

  it("bypasses a settled no-replay hold for an explicit wake, but not otherwise", async () => {
    const { companyId, issueId, runId } = await seed();
    await seedAction({ companyId, issueId, runId, status: "resolved", replay: "blocked" });

    expect(await getExecutionBlocker(db, companyId, issueId)).not.toBeNull();
    expect(await getExecutionBlocker(db, companyId, issueId, { explicitWake: false })).not.toBeNull();
    expect(await getExecutionBlocker(db, companyId, issueId, { explicitWake: true })).toBeNull();
  });

  it("still blocks an explicit wake on a genuinely active (unsettled) recovery action", async () => {
    const { companyId, issueId, runId } = await seed();
    await seedAction({ companyId, issueId, runId, status: "active" });

    const blocked = await getExecutionBlocker(db, companyId, issueId, { explicitWake: true });
    expect(blocked).not.toBeNull();
    expect(blocked!.recoveryActionId).not.toBeNull();
  });

  it("still blocks an explicit wake on an escalated recovery action", async () => {
    const { companyId, issueId, runId } = await seed();
    await seedAction({ companyId, issueId, runId, status: "escalated" });

    expect(await getExecutionBlocker(db, companyId, issueId, { explicitWake: true })).not.toBeNull();
  });

  it("does not block anything once the recovery action is settled without a no-replay disposition", async () => {
    const { companyId, issueId, runId } = await seed();
    await seedAction({ companyId, issueId, runId, status: "resolved" });

    expect(await getExecutionBlocker(db, companyId, issueId)).toBeNull();
    expect(await getExecutionBlocker(db, companyId, issueId, { explicitWake: true })).toBeNull();
  });
});
