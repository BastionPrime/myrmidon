import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { listReplayBlockedIssues } from "./index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("replay-blocked issue list", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-replay-blocked-");
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
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "user-a",
      requireBoardApprovalForNewAgents: false,
    });
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "agent-a",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedHeld(
    companyId: string,
    agentId: string,
    opts: { issueStatus?: string; actionStatus?: string; replay?: string } = {},
  ) {
    const [issue] = await db
      .insert(issues)
      .values({
        companyId,
        title: "held",
        status: opts.issueStatus ?? "blocked",
        priority: "medium",
        assigneeAgentId: agentId,
      })
      .returning();
    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "failed",
        contextSnapshot: { issueId: issue!.id },
      })
      .returning();
    const [action] = await db
      .insert(issueRecoveryActions)
      .values({
        companyId,
        sourceIssueId: issue!.id,
        kind: "execution_reconciliation",
        status: opts.actionStatus ?? "resolved",
        cause: "uncertain_provider_action",
        fingerprint: randomUUID(),
        evidence: { runId: run!.id, automaticRecovery: { replay: opts.replay ?? "blocked" } },
        nextAction: "Automatic recovery stopped.",
      })
      .returning();
    return { issueId: issue!.id, runId: run!.id, actionId: action!.id };
  }

  it("lists open tasks held by a settled no-replay recovery, with the run and its agent", async () => {
    const { companyId, agentId } = await seed();
    const held = await seedHeld(companyId, agentId);
    await seedHeld(companyId, agentId, { issueStatus: "done" });
    await seedHeld(companyId, agentId, { actionStatus: "active" });
    await seedHeld(companyId, agentId, { replay: "conversation_continuation" });
    const other = await seed();
    await seedHeld(other.companyId, other.agentId);

    expect(await listReplayBlockedIssues(db, companyId)).toEqual([
      {
        issueId: held.issueId,
        recoveryActionId: held.actionId,
        runId: held.runId,
        runAgentId: agentId,
        assigneeAgentId: agentId,
        cause: "uncertain_provider_action",
        nextAction: "Automatic recovery stopped.",
      },
    ]);
  }, 30_000);
});
