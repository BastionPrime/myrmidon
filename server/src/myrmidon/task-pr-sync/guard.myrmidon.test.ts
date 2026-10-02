import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issueWorkProducts, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { shouldSuppressRunForIssue } from "./guard.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("task PR sync guard", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-task-pr-sync-guard-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(issueWorkProducts);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(input: {
    issueStatus?: string;
    products: Array<{ type: string; status: string }>;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: companyId.replace(/-/g, "").slice(0, 8).toUpperCase(),
    });
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
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "GUARD-1",
      title: "Task a",
      status: input.issueStatus ?? "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    let index = 0;
    for (const product of input.products) {
      index += 1;
      await db.insert(issueWorkProducts).values({
        companyId,
        issueId,
        type: product.type,
        provider: "github",
        title: `Product ${index}`,
        status: product.status,
      });
    }
    return { companyId, agentId, issueId };
  }

  it("suppresses a run when every pull-request product is merged and the task is open", async () => {
    const seeded = await seed({
      products: [
        { type: "pull_request", status: "merged" },
        { type: "pull_request", status: "merged" },
      ],
    });
    await expect(shouldSuppressRunForIssue(seeded.issueId, db)).resolves.toBe(true);
  });

  it("does not suppress while one PR is still open", async () => {
    const seeded = await seed({
      products: [
        { type: "pull_request", status: "merged" },
        { type: "pull_request", status: "ready_for_review" },
      ],
    });
    await expect(shouldSuppressRunForIssue(seeded.issueId, db)).resolves.toBe(false);
  });

  it("does not suppress a terminal task", async () => {
    const seeded = await seed({
      issueStatus: "done",
      products: [{ type: "pull_request", status: "merged" }],
    });
    await expect(shouldSuppressRunForIssue(seeded.issueId, db)).resolves.toBe(false);
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, seeded.issueId));
    await expect(shouldSuppressRunForIssue(seeded.issueId, db)).resolves.toBe(false);
  });

  it("does not suppress a task with no pull-request product", async () => {
    const seeded = await seed({ products: [{ type: "document", status: "active" }] });
    await expect(shouldSuppressRunForIssue(seeded.issueId, db)).resolves.toBe(false);
  });

  it("ignores an archived duplicate when a replacement is merged", async () => {
    const seeded = await seed({
      products: [
        { type: "pull_request", status: "archived" },
        { type: "pull_request", status: "merged" },
      ],
    });
    await expect(shouldSuppressRunForIssue(seeded.issueId, db)).resolves.toBe(true);
  });

  it("does not suppress an unknown task", async () => {
    await expect(shouldSuppressRunForIssue(randomUUID(), db)).resolves.toBe(false);
  });
});