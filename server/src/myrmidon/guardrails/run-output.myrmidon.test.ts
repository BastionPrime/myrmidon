// myrmidon(1.6-GRD): the integration test of the run-output embedding
// point. The heartbeat finalization calls guardrailsOnRunOutput with the
// final run text; this suite drives the exact same call shape against a
// real database with the env switch on, proving the full path
// (detector -> masked snippet -> guardrail_events row -> activity_log line)
// works as one piece, and stays silent when the switch is off.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, agents, companies, createDb, guardrailEvents, heartbeatRuns, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { guardrailsOnRunOutput } from "./run-output.js";
import { GUARDRAIL_SURFACE_RUN_OUTPUT } from "./events.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

const ENV_ON = { MYRMIDON_GUARDRAILS_OUTPUT_ENABLED: "1" } as Record<string, string>;
const FIXED_NOW = () => new Date("2026-01-02T03:04:05.000Z");

describeEmbeddedPostgres("myrmidon(1.6-GRD): run-output embedding integration", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "";
  let agentId = "";
  let issueId: string | null = null;
  let runId: string | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-guardrails-int-");
    db = createDb(tempDb.connectionString);
    const company = await db
      .insert(companies)
      .values({ name: `agent-a integration ${randomUUID()}`, issuePrefix: `GI${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning()
      .then((rows) => rows[0]!);
    companyId = company.id;
    const agent = await db
      .insert(agents)
      .values({ companyId, name: `agent-a-${randomUUID().slice(0, 6)}`, adapterType: "claude_code" })
      .returning()
      .then((rows) => rows[0]!);
    agentId = agent.id;
  }, 60_000);

  afterEach(async () => {
    await db.delete(guardrailEvents);
    await db.delete(activityLog);
    if (runId) {
      await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      runId = null;
    }
    if (issueId) {
      await db.delete(issues).where(eq(issues.id, issueId));
      issueId = null;
    }
  });

  afterAll(async () => {
    await db.delete(guardrailEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    await db.delete(agents).where(eq(agents.id, agentId));
    await db.delete(companies).where(eq(companies.id, companyId));
    await tempDb?.cleanup();
  });

  async function seedIssueAndRun() {
    const [issue] = await db
      .insert(issues)
      .values({
        companyId,
        identifier: `GI-${randomUUID().slice(0, 6).toUpperCase()}`,
        title: "agent-a guardrail task",
        description: "neutral fixture",
      })
      .returning();
    issueId = issue.id;
    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "succeeded",
        contextSnapshot: { issueId: issue.id },
      })
      .returning();
    runId = run.id;
    return { issueId: issue.id, runId: run.id };
  }

  it("journals flagged hits end to end with masked snippets", async () => {
    const ids = await seedIssueAndRun();
    // Neutral fixtures: a fake token shape and a neutral address.
    const text = "final report: contact agent-a@example.com, token ghp_0123456789012345678901 attached";
    const result = await guardrailsOnRunOutput({
      db,
      companyId,
      runId: ids.runId,
      issueId: ids.issueId,
      text,
      env: ENV_ON,
      now: FIXED_NOW,
    });
    expect(result).toMatchObject({ recorded: 2, total: 2, totalSecrets: 1, totalPii: 1 });
    const events = await db.select().from(guardrailEvents);
    expect(events).toHaveLength(2);
    expect(events.every((row) => row.companyId === companyId)).toBe(true);
    expect(events.every((row) => row.runId === ids.runId)).toBe(true);
    expect(events.every((row) => row.issueId === ids.issueId)).toBe(true);
    expect(events.every((row) => row.surface === GUARDRAIL_SURFACE_RUN_OUTPUT)).toBe(true);
    expect(events.every((row) => row.occurredAt.toISOString() === "2026-01-02T03:04:05.000Z")).toBe(true);
    const secret = events.find((row) => row.kind === "secret")!;
    expect(secret.severity).toBe("warn");
    expect(secret.snippet).not.toBeNull();
    const pii = events.find((row) => row.kind === "pii")!;
    expect(pii.severity).toBe("info");
    // the snippet must carry the masked e-mail context, not raw secret prose
    expect(pii.snippet).toContain("agent-a@example.com");
    const log = await db.select().from(activityLog);
    expect(log).toHaveLength(2);
    expect(log.every((row) => row.action === "guardrails.event_recorded")).toBe(true);
  });

  it("is silent while the rollout switch stays off", async () => {
    const ids = await seedIssueAndRun();
    const result = await guardrailsOnRunOutput({
      db,
      companyId,
      runId: ids.runId,
      issueId: ids.issueId,
      text: "contact agent-a@example.com and ghp_0123456789012345678901",
      env: {},
      now: FIXED_NOW,
    });
    expect(result).toBeNull();
    expect(await db.select().from(guardrailEvents)).toHaveLength(0);
    expect(await db.select().from(activityLog)).toHaveLength(0);
  });

  it("records nothing for clean output", async () => {
    const ids = await seedIssueAndRun();
    const result = await guardrailsOnRunOutput({
      db,
      companyId,
      runId: ids.runId,
      issueId: ids.issueId,
      text: "the sweep finished, the report is in the workspace, all checks are green.",
      env: ENV_ON,
      now: FIXED_NOW,
    });
    expect(result).toMatchObject({ recorded: 0, total: 0 });
    expect(await db.select().from(guardrailEvents)).toHaveLength(0);
  });

  it("handles a null run text without touching the journal", async () => {
    const ids = await seedIssueAndRun();
    const result = await guardrailsOnRunOutput({
      db,
      companyId,
      runId: ids.runId,
      issueId: ids.issueId,
      text: null,
      env: ENV_ON,
      now: FIXED_NOW,
    });
    expect(result).toBeNull();
    expect(await db.select().from(guardrailEvents)).toHaveLength(0);
  });
});
