import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, evalReferenceTasks as evalTasksTable, evalRuns as evalRunsTable } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { createEvalsService, createHeuristicJudge, seedReferenceTasks, ENGINEER_REFERENCE_TASKS, EVALS_PILOT_ROLE } from "./index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

/**
 * A deterministic judge for the database path: every criterion scores full
 * points when the answer contains the marker word, zero otherwise. This
 * gives a stable "good" subject (all markers) and a stable "deliberately
 * worsened" subject (no markers) — the exact regression the threshold plus
 * the confirmation run must catch.
 */
const GOOD_MARKER = "verified-answer";
const BAD_MARKER = "garbage-answer";

function markerJudge(marker: string) {
  return createHeuristicJudge(({ answer }) => (answer.includes(marker) ? 99 : 0));
}

function answersFor(tasks: readonly { slug: string }[], text: string): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const t of tasks) answers[t.slug] = text;
  return answers;
}

describeEmbeddedPostgres("myrmidon(1.6-EVALS) reference-task runs in the database", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-evals-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(evalRunsTable);
    await db.delete(evalTasksTable);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function makeCompany() {
    return db
      .insert(companies)
      .values({ name: `company-a ${randomUUID()}`, issuePrefix: `EV${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning()
      .then((rows) => rows[0]!);
  }

  it("seeds the neutral engineer corpus idempotently (20+ tasks, no vendor collisions)", async () => {
    const company = await makeCompany();
    const first = await seedReferenceTasks(db, company.id, EVALS_PILOT_ROLE, ENGINEER_REFERENCE_TASKS);
    expect(first.inserted).toBeGreaterThanOrEqual(20);
    expect(first.updated).toBe(0);
    const again = await seedReferenceTasks(db, company.id, EVALS_PILOT_ROLE, ENGINEER_REFERENCE_TASKS);
    expect(again.inserted).toBe(0);
    expect(again.updated).toBe(first.inserted);
    const tasks = await db.select().from(evalTasksTable).where(eq(evalTasksTable.companyId, company.id));
    expect(tasks.length).toBeGreaterThanOrEqual(20);
    // The table is namespaced: no vendor table is touched.
    expect(new Set(tasks.map((t) => t.kind))).toEqual(new Set(["general", "code"]));
  });

  it("a full run stores per-task scores and the aggregate", async () => {
    const company = await makeCompany();
    await seedReferenceTasks(db, company.id, EVALS_PILOT_ROLE, ENGINEER_REFERENCE_TASKS);
    const service = createEvalsService(db, { judge: markerJudge(GOOD_MARKER), model: "test-judge", now: () => new Date() });
    const tasks = await service.loadTasks(company.id, EVALS_PILOT_ROLE);
    const outcome = await service.runEval({
      companyId: company.id,
      role: EVALS_PILOT_ROLE,
      subject: "skill-a@v1",
      answers: answersFor(tasks, GOOD_MARKER),
      ciPassRate: 100,
    });
    expect(outcome.run.status).toBe("completed");
    expect(outcome.run.scores).not.toBeNull();
    expect(outcome.run.scores!.taskCount).toBe(tasks.length);
    expect(outcome.run.scores!.scorePercent).toBeGreaterThan(90);
    expect(outcome.run.verdict).toBeNull(); // baseline run: no comparison
    expect(outcome.needsConfirm).toBe(false);
    // Every task has per-criterion points recorded.
    for (const t of outcome.run.scores!.tasks) {
      expect(Object.keys(t.criteria).length).toBeGreaterThanOrEqual(2);
      expect(t.rawScore).toBeGreaterThan(0);
    }
  });

  it("a deliberately worsened subject is caught by the threshold and confirmed by the repeat run", async () => {
    const company = await makeCompany();
    await seedReferenceTasks(db, company.id, EVALS_PILOT_ROLE, ENGINEER_REFERENCE_TASKS);
    const service = createEvalsService(db, { judge: markerJudge(GOOD_MARKER), model: "test-judge", now: () => new Date() });
    const tasks = await service.loadTasks(company.id, EVALS_PILOT_ROLE);

    // Baseline: the good subject.
    const baseline = await service.runEval({
      companyId: company.id,
      role: EVALS_PILOT_ROLE,
      subject: "skill-a@v1",
      answers: answersFor(tasks, GOOD_MARKER),
      ciPassRate: 100,
    });
    expect(baseline.run.scores!.scorePercent).toBeGreaterThan(90);

    // Candidate: the deliberately broken skill — every answer degraded.
    const candidate = await service.runEval({
      companyId: company.id,
      role: EVALS_PILOT_ROLE,
      subject: "skill-a@v2-broken",
      answers: answersFor(tasks, BAD_MARKER),
      baselineRunId: baseline.run.id,
      thresholdDrop: 10,
    });
    expect(candidate.run.verdict).toBe("confirm");
    expect(candidate.needsConfirm).toBe(true);
    expect(candidate.run.scores!.scorePercent).toBeLessThan(baseline.run.scores!.scorePercent - 10);

    // The confirmation run repeats the same degraded answers.
    const confirmation = await service.runConfirmation(candidate.run.id, answersFor(tasks, BAD_MARKER));
    expect(confirmation.run.kind).toBe("confirm");
    expect(confirmation.run.verdict).toBe("regress");
    expect(confirmation.run.confirmed).toBe(true);
    expect(confirmation.run.verdictReason).toContain("do not promote");

    // The first run is linked to its confirmation.
    const first = await service.getRun(company.id, candidate.run.id);
    expect(first!.confirmRunId).toBe(confirmation.run.id);
    expect(first!.confirmed).toBe(true);
  });

  it("a suspected regression that does NOT repeat stays promotable via the lifecycle seam", async () => {
    const company = await makeCompany();
    await seedReferenceTasks(db, company.id, EVALS_PILOT_ROLE, ENGINEER_REFERENCE_TASKS);
    // The judge flips per run: the baseline and the confirmation run are
    // good, the first candidate run is bad — noise, not a real regression.
    let good = true;
    const service = createEvalsService(db, {
      judge: createHeuristicJudge(() => (good ? 99 : 0)),
      model: "test-judge",
      now: () => new Date(),
    });
    const tasks = await service.loadTasks(company.id, EVALS_PILOT_ROLE);

    const baseline = await service.runEval({
      companyId: company.id,
      role: EVALS_PILOT_ROLE,
      subject: "skill-a@v1",
      answers: answersFor(tasks, GOOD_MARKER),
    });
    good = false; // the candidate run scores badly
    const candidate = await service.runEval({
      companyId: company.id,
      role: EVALS_PILOT_ROLE,
      subject: "skill-a@v2-flaky",
      answers: answersFor(tasks, GOOD_MARKER),
      baselineRunId: baseline.run.id,
      thresholdDrop: 10,
    });
    expect(candidate.run.verdict).toBe("confirm");

    good = true; // the repeat run scores well again
    const confirmation = await service.runConfirmation(candidate.run.id, answersFor(tasks, GOOD_MARKER));
    expect(confirmation.run.verdict).toBe("promote");
    expect(confirmation.run.verdictReason).toContain("did not repeat");

    const verdict = await service.verdictForCandidate({
      companyId: company.id,
      role: EVALS_PILOT_ROLE,
      subject: "skill-a@v2-flaky",
      baselineRunId: baseline.run.id,
    });
    expect(verdict.promote).toBe(false);
    expect(verdict.reason).toContain("did not repeat");
  });

  it("the lifecycle seam promotes a clean candidate and refuses a confirmed regression", async () => {
    const company = await makeCompany();
    await seedReferenceTasks(db, company.id, EVALS_PILOT_ROLE, ENGINEER_REFERENCE_TASKS);
    const service = createEvalsService(db, { judge: markerJudge(GOOD_MARKER), model: "test-judge", now: () => new Date() });
    const tasks = await service.loadTasks(company.id, EVALS_PILOT_ROLE);

    const baseline = await service.runEval({
      companyId: company.id,
      role: EVALS_PILOT_ROLE,
      subject: "skill-a@v1",
      answers: answersFor(tasks, GOOD_MARKER),
    });
    const clean = await service.runEval({
      companyId: company.id,
      role: EVALS_PILOT_ROLE,
      subject: "skill-b@v1",
      answers: answersFor(tasks, GOOD_MARKER),
      baselineRunId: baseline.run.id,
    });
    expect(clean.run.verdict).toBe("promote");
    const cleanVerdict = await service.verdictForCandidate({
      companyId: company.id,
      role: EVALS_PILOT_ROLE,
      subject: "skill-b@v1",
      baselineRunId: baseline.run.id,
    });
    expect(cleanVerdict.promote).toBe(true);
    expect(cleanVerdict.reason).toContain("within threshold");

    const broken = await service.runEval({
      companyId: company.id,
      role: EVALS_PILOT_ROLE,
      subject: "skill-c@v1-broken",
      answers: answersFor(tasks, BAD_MARKER),
      baselineRunId: baseline.run.id,
    });
    await service.runConfirmation(broken.run.id, answersFor(tasks, BAD_MARKER));
    const brokenVerdict = await service.verdictForCandidate({
      companyId: company.id,
      role: EVALS_PILOT_ROLE,
      subject: "skill-c@v1-broken",
      baselineRunId: baseline.run.id,
    });
    expect(brokenVerdict.promote).toBe(false);
    expect(brokenVerdict.reason).toContain("roll back");
  });
});
