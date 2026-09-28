// myrmidon(L1): a stranded assigned issue whose agent is merely paused by
// infrastructure (not failed provider work) is not escalated to the board
// while the shared infra-interrupt retry budget still allows it.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { heartbeatService } from "../heartbeat.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("reconcileStrandedAssignedIssues: infrastructure interruptions (L1)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-infra-interrupts-stranded-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedStrandedIssue(input: { errorCode: string | null; scheduledRetryAttempt?: number }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const now = new Date();

    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: `W${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "user-a",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "agent-a",
      role: "engineer",
      status: "paused",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "in progress when the agent paused",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "user-a",
      createdAt: new Date(now.getTime() - 60 * 60 * 1000),
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "cancelled",
      contextSnapshot: { issueId },
      errorCode: input.errorCode,
      scheduledRetryAttempt: input.scheduledRetryAttempt ?? 0,
      finishedAt: now,
      updatedAt: now,
    });
    return { companyId, agentId, issueId, runId };
  }

  async function activeRecoveryActionsFor(issueId: string) {
    return db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
  }

  it("does not escalate while the agent is only paused and the retry budget is not exhausted", async () => {
    const { issueId } = await seedStrandedIssue({ errorCode: "agent_paused", scheduledRetryAttempt: 0 });

    await heartbeatService(db).reconcileStrandedAssignedIssues();

    expect(await activeRecoveryActionsFor(issueId)).toHaveLength(0);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue!.status).toBe("in_progress");
  }, 30_000);

  it("still escalates to the board once the shared infra-interrupt retry budget is exhausted", async () => {
    const { issueId } = await seedStrandedIssue({ errorCode: "agent_paused", scheduledRetryAttempt: 2 });

    await heartbeatService(db).reconcileStrandedAssignedIssues();

    const actions = await activeRecoveryActionsFor(issueId);
    expect(actions.length).toBeGreaterThan(0);
    expect(actions[0]!.ownerType).toBe("board");
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue!.status).toBe("blocked");
  }, 30_000);

  it("still escalates a paused agent's stranded issue when the run failed for a non-infrastructure reason", async () => {
    const { issueId } = await seedStrandedIssue({ errorCode: "adapter_failed", scheduledRetryAttempt: 0 });

    await heartbeatService(db).reconcileStrandedAssignedIssues();

    expect((await activeRecoveryActionsFor(issueId)).length).toBeGreaterThan(0);
  }, 30_000);
});
