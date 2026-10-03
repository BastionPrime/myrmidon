// myrmidon(1.6-GRD): the event journal over the real database — the frozen
// recordGuardrailEvent contract (part B mocks it), the masked-snippet
// invariant, and the read route's company scoping. Fixtures are neutral.

import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, agents, companies, createDb, guardrailEvents, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { errorHandler } from "../../middleware/index.js";
import {
  GUARDRAIL_SURFACE_RUN_OUTPUT,
  listGuardrailEvents,
  readGuardrailOutputSettings,
  recordGuardrailEvent,
  recordRunOutputGuardrailEvents,
} from "./events.js";
import { myrmidonGuardrailsRoutes } from "./routes.js";
import { scanGuardrailText } from "./detect.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

const COMPANY_NAME = "agent-a guard test";

function boardActor(companyId: string) {
  return {
    type: "board",
    source: "session",
    userId: "user-a",
    isInstanceAdmin: false,
    companyIds: [companyId],
    memberships: [{ companyId, status: "active", membershipRole: "admin" }],
  };
}

const agent = {
  type: "agent",
  source: "agent_key",
  agentId: "10000000-0000-4000-8000-0000000000b1",
  companyId: "10000000-0000-4000-8000-000000000002",
  keyId: "key-a",
};

describeEmbeddedPostgres("myrmidon(1.6-GRD): event journal", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "";
  let agentRow: typeof agents.$inferSelect | null = null;
  let runId: string | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-guardrails-");
    db = createDb(tempDb.connectionString);
    const company = await db
      .insert(companies)
      .values({ name: `${COMPANY_NAME} ${randomUUID()}`, issuePrefix: `GR${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning()
      .then((rows) => rows[0]!);
    companyId = company.id;
    agentRow = await db
      .insert(agents)
      .values({ companyId, name: `agent-a-${randomUUID().slice(0, 6)}`, adapterType: "claude_code" })
      .returning()
      .then((rows) => rows[0]!);
  }, 60_000);

  afterEach(async () => {
    await db.delete(guardrailEvents);
    await db.delete(activityLog);
    if (runId) {
      await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      runId = null;
    }
  });

  afterAll(async () => {
    await db.delete(guardrailEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentRow!.id));
    await db.delete(agents).where(eq(agents.id, agentRow!.id));
    await db.delete(companies);
    await tempDb?.cleanup();
  });

  it("records one event row and one activity-log line (frozen contract)", async () => {
    const occurredAt = new Date("2026-01-02T03:04:05.000Z");
    const { id } = await recordGuardrailEvent(db, {
      companyId,
      issueId: null,
      runId: null,
      kind: "pii",
      surface: "run_output",
      severity: "info",
      snippet: "contact agent-a@example.com",
      occurredAt,
    });
    expect(id).toBeTruthy();
    const rows = await db.select().from(guardrailEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.companyId).toBe(companyId);
    expect(rows[0]!.kind).toBe("pii");
    expect(rows[0]!.surface).toBe("run_output");
    expect(rows[0]!.severity).toBe("info");
    expect(rows[0]!.runId).toBeNull();
    expect(rows[0]!.issueId).toBeNull();
    expect(rows[0]!.snippet).toBe("contact agent-a@example.com");
    expect(rows[0]!.occurredAt.toISOString()).toBe(occurredAt.toISOString());
    const log = await db.select().from(activityLog);
    expect(log).toHaveLength(1);
    expect(log[0]!.action).toBe("guardrails.event_recorded");
    expect(log[0]!.entityType).toBe("guardrail_event");
    expect(log[0]!.entityId).toBe(id);
  });

  it("masks a raw secret passed as snippet through the existing masking", async () => {
    // A caller that forgot to mask: the journal must still not store the
    // raw value. The neutral fake token below is a registered-style value
    // through the URL-credential path of the existing masking.
    const raw = "password in https://user:letmein123@example.com/path";
    await recordGuardrailEvent(db, {
      companyId,
      issueId: null,
      runId: null,
      kind: "secret",
      surface: GUARDRAIL_SURFACE_RUN_OUTPUT,
      severity: "warn",
      snippet: raw,
      occurredAt: new Date(),
    });
    const rows = await db.select().from(guardrailEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.snippet).not.toContain("letmein123");
    expect(rows[0]!.snippet).toContain("****");
  });

  it("lists events newest-first with a limit", async () => {
    for (let i = 0; i < 5; i += 1) {
      await recordGuardrailEvent(db, {
        companyId,
        issueId: null,
        runId: null,
        kind: "pii",
        surface: "run_output",
        severity: "info",
        snippet: `contact entry ${i}`,
        occurredAt: new Date(Date.parse("2026-01-01T00:00:00.000Z") + i * 1000),
      });
    }
    const events = await listGuardrailEvents(db, companyId, 3);
    expect(events).toHaveLength(3);
    expect(events[0]!.snippet).toBe("contact entry 4");
    expect(events[2]!.snippet).toBe("contact entry 2");
  });

  it("binds events to a real run row", async () => {
    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId: agentRow!.id,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "succeeded",
        contextSnapshot: { issueId: null },
      })
      .returning();
    runId = run.id;
    await recordGuardrailEvent(db, {
      companyId,
      issueId: null,
      runId: run.id,
      kind: "secret",
      surface: GUARDRAIL_SURFACE_RUN_OUTPUT,
      severity: "warn",
      snippet: null,
      occurredAt: new Date(),
    });
    const events = await listGuardrailEvents(db, companyId, 10);
    expect(events[0]!.runId).toBe(run.id);
  });
});

describeEmbeddedPostgres("myrmidon(1.6-GRD): run-output scan", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "";
  let agentRow: typeof agents.$inferSelect | null = null;
  let runId: string | null = null;
  const envOn = { MYRMIDON_GUARDRAILS_OUTPUT_ENABLED: "1" } as Record<string, string>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-guardrails-scan-");
    db = createDb(tempDb.connectionString);
    const company = await db
      .insert(companies)
      .values({ name: `agent-a scan ${randomUUID()}`, issuePrefix: `GS${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning()
      .then((rows) => rows[0]!);
    companyId = company.id;
    agentRow = await db
      .insert(agents)
      .values({ companyId, name: `agent-a-${randomUUID().slice(0, 6)}`, adapterType: "claude_code" })
      .returning()
      .then((rows) => rows[0]!);
  }, 60_000);

  afterEach(async () => {
    await db.delete(guardrailEvents);
    await db.delete(activityLog);
    if (runId) {
      await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      runId = null;
    }
  });

  afterAll(async () => {
    await db.delete(guardrailEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentRow!.id));
    await db.delete(agents).where(eq(agents.id, agentRow!.id));
    await db.delete(companies);
    await tempDb?.cleanup();
  });

  async function seedRun() {
    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId: agentRow!.id,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "succeeded",
        contextSnapshot: { issueId: null },
      })
      .returning();
    runId = run.id;
    return run.id;
  }

  it("does nothing while the switch is off (default)", async () => {
    const id = await seedRun();
    const result = await recordRunOutputGuardrailEvents(db, {
      companyId,
      runId: id,
      issueId: null,
      text: "write agent-a@example.com and ghp_0123456789012345678901",
      now: () => new Date(),
      env: {},
    });
    expect(result).toBeNull();
    expect(await db.select().from(guardrailEvents)).toHaveLength(0);
  });

  it("records one flagged event per hit and never changes the text", async () => {
    const id = await seedRun();
    const text = "contact agent-a@example.com or use ghp_0123456789012345678901";
    const result = await recordRunOutputGuardrailEvents(db, {
      companyId,
      runId: id,
      issueId: null,
      text,
      now: () => new Date(),
      env: envOn,
    });
    expect(result).toMatchObject({ recorded: 2, total: 2, totalSecrets: 1, totalPii: 1 });
    const events = await db.select().from(guardrailEvents);
    expect(events).toHaveLength(2);
    const kinds = events.map((row) => row.kind).sort();
    expect(kinds).toEqual(["pii", "secret"]);
    expect(events.every((row) => row.runId === id)).toBe(true);
    expect(events.every((row) => row.surface === GUARDRAIL_SURFACE_RUN_OUTPUT)).toBe(true);
    // flag-only: the scanned text itself is untouched
    expect(scanGuardrailText(text).total).toBe(2);
  });

  it("respects the categories csv from env", async () => {
    const id = await seedRun();
    const result = await recordRunOutputGuardrailEvents(db, {
      companyId,
      runId: id,
      issueId: null,
      text: "contact agent-a@example.com or use ghp_0123456789012345678901",
      now: () => new Date(),
      env: { ...envOn, MYRMIDON_GUARDRAILS_OUTPUT_CATEGORIES: "secret" },
    });
    expect(result?.totalSecrets).toBe(1);
    expect(result?.totalPii).toBe(0);
    const events = await db.select().from(guardrailEvents);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("secret");
  });

  it("falls back to all categories for a garbage csv", async () => {
    const settings = readGuardrailOutputSettings({
      MYRMIDON_GUARDRAILS_OUTPUT_ENABLED: "1",
      MYRMIDON_GUARDRAILS_OUTPUT_CATEGORIES: "yes,no",
    });
    expect(settings.categories).toEqual(["secret", "pii"]);
  });

  it("swallows journal failures instead of breaking finalization", async () => {
    const failingDb = {
      insert: () => {
        throw new Error("journal down");
      },
    } as unknown as Db;
    const result = await recordRunOutputGuardrailEvents(failingDb, {
      companyId,
      runId: "00000000-0000-4000-8000-000000000001",
      issueId: null,
      text: "agent-a@example.com",
      now: () => new Date(),
      env: envOn,
    });
    expect(result).toBeNull();
  });
});

describeEmbeddedPostgres("myrmidon(1.6-GRD): routes", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-guardrails-routes-");
    db = createDb(tempDb.connectionString);
    const company = await db
      .insert(companies)
      .values({ name: `agent-a routes ${randomUUID()}`, issuePrefix: `GT${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning()
      .then((rows) => rows[0]!);
    companyId = company.id;
  }, 60_000);

  afterEach(async () => {
    await db.delete(guardrailEvents);
    await db.delete(activityLog);
  });

  afterAll(async () => {
    await db.delete(guardrailEvents);
    await db.delete(activityLog);
    await db.delete(companies);
    await tempDb?.cleanup();
  });

  function app(actor: unknown) {
    const expressApp = express();
    expressApp.use(express.json());
    expressApp.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = actor;
      next();
    });
    expressApp.use("/api", myrmidonGuardrailsRoutes(db));
    expressApp.use(errorHandler);
    return expressApp;
  }

  const base = (company: string) => `/api/myrmidon/companies/${company}/guardrails/events`;

  it("refuses an unauthenticated read", async () => {
    await request(app({ type: "none" })).get(`${base(companyId)}`).expect(401);
  });

  it("refuses a read from an agent of another company", async () => {
    await request(app({ ...agent, companyId: "10000000-0000-4000-8000-000000000002" }))
      .get(`${base(companyId)}`)
      .expect(403);
  });

  it("lists the journal for a board member of the company", async () => {
    await recordGuardrailEvent(db, {
      companyId,
      issueId: null,
      runId: null,
      kind: "secret",
      surface: "run_output",
      severity: "warn",
      snippet: "masked [secret:value] excerpt",
      occurredAt: new Date(),
    });
    const res = await request(app(boardActor(companyId))).get(`${base(companyId)}`).expect(200);
    expect(res.body.count).toBe(1);
    expect(res.body.events[0]!.snippet).toBe("masked [secret:value] excerpt");
    expect(res.body.limit).toBe(50);
  });

  it("caps the limit at 200", async () => {
    const res = await request(app(boardActor(companyId))).get(`${base(companyId)}?limit=9999`).expect(200);
    expect(res.body.limit).toBe(200);
  });

  it("answers an empty journal cleanly", async () => {
    const res = await request(app(boardActor(companyId))).get(`${base(companyId)}?limit=1`).expect(200);
    expect(res.body.count).toBe(0);
    expect(res.body.events).toEqual([]);
  });
});
