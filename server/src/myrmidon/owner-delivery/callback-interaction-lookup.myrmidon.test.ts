// myrmidon(U2): unit coverage for the company-wide interaction lookup used by
// chat action callbacks when a card was delivered to the owner's standing
// Telegram conversation (X8b) from a different task. Same-issue lookups keep
// the vendor's listForIssue projection; cross-issue lookups must resolve by
// interaction id within the company, and nothing outside the company.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  agents,
  authUsers,
  companies,
  createDb,
  issues,
} from "@paperclipai/db";
import { issueThreadInteractionService } from "../../services/issue-thread-interactions.js";
import { listInteractionForCallback } from "./callback-interaction-lookup.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

describeEmbeddedPostgres("callback interaction lookup (U2)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-u2-callback-lookup-",
    );
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const agentId = randomUUID();
    const boardUserId = randomUUID();
    await db.insert(companies).values([
      {
        id: companyId,
        name: `Lookup co ${companyId.slice(0, 6)}`,
        issuePrefix: `LU${companyId.replaceAll("-", "").slice(0, 7).toUpperCase()}`,
      },
      {
        id: otherCompanyId,
        name: `Other co ${otherCompanyId.slice(0, 6)}`,
        issuePrefix: `OC${otherCompanyId.replaceAll("-", "").slice(0, 7).toUpperCase()}`,
      },
    ]);
    await db
      .insert(authUsers)
      .values({
        id: boardUserId,
        name: "Owner",
        email: `owner-${boardUserId.slice(0, 8)}@example.com`,
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoNothing();
    for (const [id, co] of [
      [agentId, companyId],
      [randomUUID(), otherCompanyId],
    ] as const) {
      await db.insert(agents).values({
        id,
        companyId: co,
        name: "Agent",
        role: "engineer",
        status: "idle",
        adapterType: "paperclip_runner",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
    }
    const [conversationIssue] = await db
      .insert(issues)
      .values({
        companyId,
        title: "Telegram chat with Agent",
        assigneeAgentId: agentId,
        conversationAgentId: agentId,
        conversationUserId: `telegram:${boardUserId}`,
        conversationState: "waiting",
        status: "in_review",
        createdByUserId: boardUserId,
      })
      .returning();
    const [workIssue] = await db
      .insert(issues)
      .values({
        companyId,
        title: "Work task",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        responsibleUserId: boardUserId,
        createdByUserId: boardUserId,
      })
      .returning();
    return { companyId, otherCompanyId, agentId, conversationIssue, workIssue };
  }

  it("resolves a cross-issue interaction by id within the company", async () => {
    const fixture = await seed();
    const service = issueThreadInteractionService(db);
    const created = await service.create(
      { id: fixture.workIssue.id, companyId: fixture.companyId },
      {
        kind: "ask_user_questions" as const,
        continuationPolicy: "wake_assignee" as const,
        payload: {
          version: 1 as const,
          questions: [
            {
              id: "one",
              prompt: "Pick one",
              selectionMode: "single" as const,
              allowOther: false,
              options: [{ id: "a", label: "A" }],
            },
          ],
        },
      },
      { agentId: fixture.agentId },
    );

    const resolved = await listInteractionForCallback(db, {
      companyId: fixture.companyId,
      conversationIssueId: fixture.conversationIssue.id,
      interactionId: created.id,
    });
    expect(resolved?.id).toBe(created.id);
    expect(resolved?.issueId).toBe(fixture.workIssue.id);
    expect(resolved?.status).toBe("pending");
  });

  it("keeps the same-issue path authoritative when the id belongs to the conversation issue", async () => {
    const fixture = await seed();
    const service = issueThreadInteractionService(db);
    const created = await service.create(
      { id: fixture.conversationIssue.id, companyId: fixture.companyId },
      {
        kind: "ask_user_questions" as const,
        continuationPolicy: "wake_assignee" as const,
        payload: {
          version: 1 as const,
          questions: [
            {
              id: "one",
              prompt: "Pick one",
              selectionMode: "single" as const,
              allowOther: false,
              options: [{ id: "a", label: "A" }],
            },
          ],
        },
      },
      { agentId: fixture.agentId },
    );

    const resolved = await listInteractionForCallback(db, {
      companyId: fixture.companyId,
      conversationIssueId: fixture.conversationIssue.id,
      interactionId: created.id,
    });
    expect(resolved?.id).toBe(created.id);
    expect(resolved?.issueId).toBe(fixture.conversationIssue.id);
  });

  it("returns null for an interaction from another company", async () => {
    const fixture = await seed();
    // Create an interaction in the OTHER company on its own work task.
    const otherAgentId = (
      await db
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.companyId, fixture.otherCompanyId))
    )[0]!.id;
    const [otherIssue] = await db
      .insert(issues)
      .values({
        companyId: fixture.otherCompanyId,
        title: "Other work",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: otherAgentId,
      })
      .returning();
    const foreign = await issueThreadInteractionService(db).create(
      { id: otherIssue.id, companyId: fixture.otherCompanyId },
      {
        kind: "ask_user_questions" as const,
        continuationPolicy: "wake_assignee" as const,
        payload: {
          version: 1 as const,
          questions: [
            {
              id: "one",
              prompt: "Pick one",
              selectionMode: "single" as const,
              allowOther: false,
              options: [{ id: "a", label: "A" }],
            },
          ],
        },
      },
      { agentId: otherAgentId },
    );

    const resolved = await listInteractionForCallback(db, {
      companyId: fixture.companyId,
      conversationIssueId: fixture.conversationIssue.id,
      interactionId: foreign.id,
    });
    expect(resolved).toBeNull();
  });
});
