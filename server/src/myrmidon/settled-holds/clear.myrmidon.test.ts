// myrmidon(L2): clearSettledReplayBlock — see clear.ts.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, agents, companies, createDb, issueRecoveryActions, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { clearSettledReplayBlock } from "./clear.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("clearSettledReplayBlock (L2)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-settled-holds-clear-");
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
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
    const runId = randomUUID();
    const [action] = await db.insert(issueRecoveryActions).values({
      companyId, sourceIssueId: issue!.id, kind: "execution_reconciliation", status: "resolved",
      outcome: "blocked", cause: "uncertain_provider_action", fingerprint: randomUUID(),
      evidence: { runId, actionOutcome: "unknown", automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } },
      nextAction: "Automatic recovery stopped.",
    }).returning();
    return { companyId, issueId: issue!.id, action: action! };
  }

  it("sets replay to cleared, keeps other evidence, and records who/when/note", async () => {
    const { companyId, action } = await seed();
    const cleared = await clearSettledReplayBlock({
      db, companyId, action, actor: { actorType: "user", actorId: "board" },
      note: "Provider process confirmed stopped; no remaining effects.",
    });

    expect(cleared.evidence).toMatchObject({
      runId: action.evidence.runId,
      actionOutcome: "unknown",
      automaticRecovery: {
        replay: "cleared",
        actionOutcome: "unknown",
        replayClearedBy: "board",
        replayClearedByType: "user",
        replayClearedNote: "Provider process confirmed stopped; no remaining effects.",
      },
    });
    expect(typeof (cleared.evidence.automaticRecovery as Record<string, unknown>).replayClearedAt).toBe("string");
    // status/outcome/resolvedAt stay untouched — only the disposition and evidence move.
    expect(cleared.status).toBe("resolved");
    expect(cleared.outcome).toBe("blocked");

    const [persisted] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
    expect(persisted!.evidence).toEqual(cleared.evidence);
  });

  it("writes a durable activity log entry", async () => {
    const { companyId, issueId, action } = await seed();
    await clearSettledReplayBlock({
      db, companyId, action, actor: { actorType: "user", actorId: "board" }, note: null,
    });

    const [entry] = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
    expect(entry).toMatchObject({
      companyId, actorType: "user", actorId: "board",
      action: "issue.execution_recovery_replay_cleared", entityType: "issue", entityId: issueId,
    });
    expect(entry!.details).toMatchObject({ recoveryActionId: action.id, cause: action.cause, recoveryActionStatus: "resolved" });
  });
});
