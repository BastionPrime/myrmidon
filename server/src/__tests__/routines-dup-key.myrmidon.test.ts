import { randomUUID } from "node:crypto";
import { and, eq, notInArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  documentRevisions,
  documents,
  executionWorkspaces,
  heartbeatRuns,
  instanceSettings,
  issues,
  projectWorkspaces,
  projects,
  routineDocuments,
  routineRuns,
  routines,
  routineTriggers,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";
import { routineService } from "../services/routines.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres routine duplicate-key tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * Reads the violated constraint out of a Postgres unique-violation error,
 * walking the `cause` chain. The query layer wraps the driver error, and the
 * constraint name is reliably present either as a field or in the message.
 */
function uniqueViolationConstraint(error: unknown): string | null {
  let cursor: unknown = error;
  for (let depth = 0; cursor && depth < 6; depth += 1) {
    const candidate = cursor as {
      code?: string;
      constraint?: string;
      message?: string;
      cause?: unknown;
    };
    if (candidate.code === "23505") {
      if (typeof candidate.constraint === "string") return candidate.constraint;
      const match = /constraint "([^"]+)"/.exec(candidate.message ?? "");
      return match ? match[1] : null;
    }
    cursor = candidate.cause;
  }
  return null;
}

describeEmbeddedPostgres("routine execution duplicate-key guard", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    process.env.PAPERCLIP_API_URL = "http://localhost:3100";
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-routine-dup-key-");
    db = createDb(tempDb.connectionString);
  }, 90_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(routineRuns);
    await db.delete(routineTriggers);
    await db.delete(routines);
    await db.delete(routineDocuments);
    await db.delete(documents);
    await db.delete(documentRevisions);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const defaultResponsibleUserId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const runs: Array<{ issueId: string; runId: string }> = [];

    await db.insert(companies).values({
      id: companyId,
      name: "Example Co",
      issuePrefix,
      defaultResponsibleUserId,
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

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Routines",
      status: "in_progress",
    });

    const svc = routineService(db, {
      heartbeat: {
        // Mirrors the server: queuing a run does not stamp `execution_run_id`
        // (that happens when the run is claimed), so the issue only holds the
        // execution lock once its run actually starts.
        wakeup: async (wakeupAgentId, wakeupOpts) => {
          const issueId =
            (typeof wakeupOpts.payload?.issueId === "string" && wakeupOpts.payload.issueId) ||
            (typeof wakeupOpts.contextSnapshot?.issueId === "string" &&
              wakeupOpts.contextSnapshot.issueId) ||
            null;
          if (!issueId) return null;
          const runId = randomUUID();
          await db.insert(heartbeatRuns).values({
            id: runId,
            companyId,
            agentId: wakeupAgentId,
            invocationSource: wakeupOpts.source ?? "assignment",
            triggerDetail: wakeupOpts.triggerDetail ?? null,
            status: "queued",
            responsibleUserId: defaultResponsibleUserId,
            contextSnapshot: { ...(wakeupOpts.contextSnapshot ?? {}), issueId },
          });
          runs.push({ issueId, runId });
          return { id: runId };
        },
      },
    });
    const issueSvc = issueService(db);
    const routine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "ascii frog",
        description: "Run the frog routine",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    return { companyId, agentId, issueSvc, projectId, routine, svc, runs };
  }

  it("the partial index covers an open execution only once it holds a run", async () => {
    const { companyId, agentId, issueSvc } = await seedFixture();
    const originId = randomUUID();
    const originFingerprint = "mechanism-fingerprint";
    const firstRunId = randomUUID();
    const secondRunId = randomUUID();

    await db.insert(heartbeatRuns).values([
      {
        id: firstRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "completed",
        contextSnapshot: {},
      },
      {
        id: secondRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        contextSnapshot: {},
      },
    ]);

    const execution = {
      title: "routine execution",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      originKind: "routine_execution",
      originId,
      originFingerprint,
    };
    const existing = await issueSvc.create(companyId, { ...execution, executionRunId: firstRunId });
    // The second open execution carries no run yet, so the partial index does
    // not cover the insert and accepts it: this is the window a duplicate
    // grows in.
    const duplicate = await issueSvc.create(companyId, { ...execution, executionRunId: null });
    expect(duplicate.id).not.toBe(existing.id);

    // The duplicate only conflicts once the new issue's run starts and stamps
    // `execution_run_id` — that update is what fails on the live board.
    let error: unknown = null;
    try {
      await db
        .update(issues)
        .set({ executionRunId: secondRunId })
        .where(eq(issues.id, duplicate.id));
    } catch (caught) {
      error = caught;
    }
    expect(uniqueViolationConstraint(error)).toBe("issues_open_routine_execution_uq");
  });

  it("coalesces instead of duplicating when the previous execution's run finished", async () => {
    const { routine, svc, runs } = await seedFixture();

    const first = await svc.runRoutine(routine.id, { source: "manual" });
    expect(first.status).toBe("issue_created");
    const issueId = first.linkedIssueId;
    expect(issueId).toBeTruthy();
    const runId = runs.find((entry) => entry.issueId === issueId)?.runId;
    expect(runId).toBeTruthy();

    // The execution run finished while its issue stayed open — the normal
    // state of a routine that files a task the assignee has not closed yet.
    await db
      .update(heartbeatRuns)
      .set({ status: "completed", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, runId!));
    await db
      .update(issues)
      .set({ executionRunId: runId!, executionLockedAt: new Date() })
      .where(eq(issues.id, issueId!));

    const second = await svc.runRoutine(routine.id, { source: "manual" });

    expect(second.status).toBe("coalesced");
    expect(second.linkedIssueId).toBe(issueId);
    expect(second.coalescedIntoRunId).toBe(first.id);

    const openIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.originId, routine.id), notInArray(issues.status, ["done", "cancelled"])));
    expect(openIssues.map((row) => row.id)).toEqual([issueId]);
  });
});