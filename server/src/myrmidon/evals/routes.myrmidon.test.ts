// myrmidon(1.6-EVALS): the evals REST routes over the real database with a
// heuristic judge — permissions, the seed/run/confirm/verdict flow and the
// not-configured 503.

import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, companies, createDb, evalReferenceTasks, evalRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { errorHandler } from "../../middleware/index.js";
import { myrmidonEvalsRoutes } from "./routes.js";
import { createEvalsService, createHeuristicJudge } from "./index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

const COMPANY = "10000000-0000-4000-8000-000000000001";
const OTHER_COMPANY = "10000000-0000-4000-8000-000000000002";

/** The board actor for the company created in beforeAll. */
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
  companyId: COMPANY,
  keyId: "key-a",
};

const GOOD = "verified-answer";
const BAD = "garbage-answer";

describeEmbeddedPostgres("myrmidon(1.6-EVALS): routes", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-evals-routes-");
    db = createDb(tempDb.connectionString);
    const company = await db
      .insert(companies)
      .values({ name: `company-a ${randomUUID()}`, issuePrefix: `EV${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning()
      .then((rows) => rows[0]!);
    companyId = company.id;
  }, 60_000);

  afterEach(async () => {
    await db.delete(evalRuns);
    await db.delete(evalReferenceTasks);
  });

  afterAll(async () => {
    await db.delete(activityLog); // the routes journal their mutations
    await db.delete(companies);
    await tempDb?.cleanup();
  });

  function app(actor: unknown) {
    const service = createEvalsService(db, { judge: createHeuristicJudge(({ answer }) => (answer.includes(GOOD) ? 99 : 0)), model: "test-judge", now: () => new Date() });
    const expressApp = express();
    expressApp.use(express.json());
    expressApp.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = actor;
      next();
    });
    expressApp.use("/api", myrmidonEvalsRoutes(db, { service }));
    expressApp.use(errorHandler);
    return expressApp;
  }

  const base = (company: string) => `/api/myrmidon/companies/${company}/evals`;

  async function seedTasks() {
    const res = await request(app(boardActor(companyId))).post(`${base(companyId)}/seed`).send({ role: "engineer" }).expect(200);
    expect(res.body.inserted).toBeGreaterThanOrEqual(20);
    return res.body as { inserted: number };
  }

  async function loadTasks() {
    const res = await request(app(boardActor(companyId))).get(`${base(companyId)}/tasks?role=engineer`).expect(200);
    return res.body.tasks as { slug: string }[];
  }

  it("refuses a read from an agent of another company", async () => {
    await request(app({ ...agent, companyId: OTHER_COMPANY })).get(`${base(companyId)}/tasks`).expect(403);
  });

  it("refuses a mutation from an agent actor", async () => {
    await request(app(agent)).post(`${base(companyId)}/seed`).expect(403);
  });

  it("seeds and lists the neutral corpus for a board member", async () => {
    await seedTasks();
    const tasks = await loadTasks();
    expect(tasks.length).toBeGreaterThanOrEqual(20);
    const again = await request(app(boardActor(companyId))).post(`${base(companyId)}/seed`).send({}).expect(200);
    expect(again.body.inserted).toBe(0);
    expect(again.body.updated).toBeGreaterThanOrEqual(20);
  });

  it("runs, stores scores, and reads the run back", async () => {
    await seedTasks();
    const tasks = await loadTasks();
    const answers: Record<string, string> = {};
    for (const t of tasks) answers[t.slug] = GOOD;
    const run = await request(app(boardActor(companyId)))
      .post(`${base(companyId)}/runs`)
      .send({ role: "engineer", subject: "skill-a@v1", answers, ciPassRate: 100 })
      .expect(200);
    expect(run.body.run.status).toBe("completed");
    expect(run.body.run.scores.taskCount).toBe(tasks.length);
    const runId = run.body.run.id as string;

    const read = await request(app(boardActor(companyId))).get(`${base(companyId)}/runs/${runId}`).expect(200);
    expect(read.body.run.id).toBe(runId);
    expect(read.body.run.scores.scorePercent).toBeGreaterThan(90);

    const listed = await request(app(boardActor(companyId))).get(`${base(companyId)}/runs?role=engineer`).expect(200);
    expect(listed.body.runs.length).toBe(1);
  });

  it("answers 503 with the reason when the judge contour is not configured", async () => {
    const expressApp = express();
    expressApp.use(express.json());
    expressApp.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = boardActor(companyId);
      next();
    });
    // No deps.service, no env: the settings path is off.
    expressApp.use("/api", myrmidonEvalsRoutes(db, { env: {}, now: () => new Date() }));
    expressApp.use(errorHandler);
    const res = await request(expressApp).post(`${base(companyId)}/runs`).send({ role: "engineer", subject: "s", answers: {} }).expect(503);
    expect(res.body.enabled).toBe(false);
    expect(res.body.error).toContain("MYRMIDON_EVALS_BASE_URL");
  });

  it("catches a broken candidate through threshold and repeat, and answers the lifecycle verdict", async () => {
    await seedTasks();
    const tasks = await loadTasks();
    const good: Record<string, string> = {};
    const bad: Record<string, string> = {};
    for (const t of tasks) {
      good[t.slug] = GOOD;
      bad[t.slug] = BAD;
    }
    const baseline = await request(app(boardActor(companyId)))
      .post(`${base(companyId)}/runs`)
      .send({ role: "engineer", subject: "skill-a@v1", answers: good })
      .expect(200);
    const candidate = await request(app(boardActor(companyId)))
      .post(`${base(companyId)}/runs`)
      .send({ role: "engineer", subject: "skill-b@v1-broken", answers: bad, baselineRunId: baseline.body.run.id, thresholdDrop: 10 })
      .expect(200);
    expect(candidate.body.run.verdict).toBe("confirm");
    expect(candidate.body.needsConfirm).toBe(true);

    const confirmation = await request(app(boardActor(companyId)))
      .post(`${base(companyId)}/runs/${candidate.body.run.id}/confirm`)
      .send({ answers: bad })
      .expect(200);
    expect(confirmation.body.run.verdict).toBe("regress");
    expect(confirmation.body.run.verdictReason).toContain("do not promote");

    const verdict = await request(app(boardActor(companyId)))
      .post(`${base(companyId)}/verdict`)
      .send({ role: "engineer", subject: "skill-b@v1-broken", baselineRunId: baseline.body.run.id })
      .expect(200);
    expect(verdict.body.promote).toBe(false);
    expect(verdict.body.reason).toContain("roll back");
  });
});
