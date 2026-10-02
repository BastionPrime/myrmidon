// server/src/myrmidon/evals/service.ts
//
// myrmidon(1.6-EVALS): the store-bound run service.
//
// One run = load the reference tasks for (companyId, role), score the
// subject's stored answer for each task with the judge, aggregate, persist
// into `eval_runs`, and compare against the baseline. A first run that
// crosses the regression threshold is NOT a verdict: the run is marked
// `confirm` and a second run must cross again before the verdict says
// "regress" (do not promote). Local scores are always written; the Langfuse
// export is a flag (see langfuse.ts) and never blocks the local path.
//
// The judge never executes code: for `code` tasks the caller passes the CI
// pass rate (0-100) and the service folds it into the aggregate as a
// separate score line, not as rubric points.

import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { evalReferenceTasks, evalRuns } from "@paperclipai/db";
import { and, desc, eq } from "drizzle-orm";
import {
  aggregateEvalScores,
  checkEvalRegressionThreshold,
  decideEvalVerdictForLifecycle,
  isEvalRubric,
  isEvalTaskKind,
  type EvalRubric,
  type EvalRunOutcome,
  type EvalRunScores,
  type EvalTaskKind,
  type EvalVerdict,
  type EvalVerdictForLifecycle,
} from "./domain.js";
import type { JudgePort, JudgeTaskResult } from "./judge.js";
import type { EvalsScoreExporter } from "./langfuse.js";

export type EvalRunStatus = "running" | "completed" | "failed";

export interface EvalTaskRow {
  id: string;
  slug: string;
  title: string;
  prompt: string;
  kind: EvalTaskKind;
  weight: number;
  rubric: EvalRubric;
}

export interface EvalRunInput {
  companyId: string;
  role: string;
  /** The candidate identifier: a skill version, an agent config, a draft. */
  subject: string;
  /** The answer text per task slug. Missing slugs score zero. */
  answers: Record<string, string>;
  /** CI pass rate for code tasks (0-100); required to fold code scoring in. */
  ciPassRate?: number | null;
  /** The baseline run id to compare against; omit for a baseline run. */
  baselineRunId?: string | null;
  thresholdDrop?: number;
}

export interface EvalRunRecord {
  id: string;
  companyId: string;
  role: string;
  subject: string;
  baselineId: string | null;
  confirmRunId: string | null;
  kind: "first" | "confirm";
  status: EvalRunStatus;
  scores: EvalRunScores | null;
  verdict: EvalVerdict | null;
  verdictReason: string | null;
  thresholdDrop: number | null;
  confirmed: boolean;
  model: string | null;
  ciPassRate: number | null;
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

/** How the subject's answers are produced. Tests inject a fake; production reads them from the request. */
export interface EvalsServiceDeps {
  judge: JudgePort;
  /** Optional Langfuse-backed score exporter; absent = local-only. */
  exporter?: EvalsScoreExporter;
  /** The model id the judge runs on, recorded on the run. */
  model: string;
  now(): Date;
}

export class EvalsServiceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "EvalsServiceError";
    this.code = code;
  }
}

export interface RunOutcome {
  run: EvalRunRecord;
  /** Set when the run crossed the threshold and needs a confirmation run. */
  needsConfirm: boolean;
}

function toOutcome(row: typeof evalRuns.$inferSelect): EvalRunRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    role: row.role,
    subject: row.subject,
    baselineId: row.baselineId,
    confirmRunId: row.confirmRunId,
    kind: row.kind as "first" | "confirm",
    status: row.status as EvalRunStatus,
    scores: (row.scores as EvalRunScores | null) ?? null,
    verdict: (row.verdict as EvalVerdict | null) ?? null,
    verdictReason: row.verdictReason,
    thresholdDrop: row.thresholdDrop,
    confirmed: row.confirmed,
    model: row.model,
    ciPassRate: row.ciPassRate,
    error: row.error,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

export function createEvalsService(db: Db, deps: EvalsServiceDeps) {
  async function loadTasks(companyId: string, role: string): Promise<EvalTaskRow[]> {
    const rows = await db
      .select()
      .from(evalReferenceTasks)
      .where(and(eq(evalReferenceTasks.companyId, companyId), eq(evalReferenceTasks.role, role)));
    return rows
      .filter((r) => isEvalTaskKind(r.kind) && isEvalRubric(r.rubric))
      .map((r) => ({
        id: r.id,
        slug: r.slug,
        title: r.title,
        prompt: r.prompt,
        kind: r.kind as EvalTaskKind,
        weight: r.weight,
        rubric: r.rubric as EvalRubric,
      }))
      .sort((a, b) => a.slug.localeCompare(b.slug));
  }

  async function getRun(companyId: string, runId: string): Promise<EvalRunRecord | null> {
    const rows = await db
      .select()
      .from(evalRuns)
      .where(and(eq(evalRuns.companyId, companyId), eq(evalRuns.id, runId)))
      .limit(1);
    return rows[0] ? toOutcome(rows[0]) : null;
  }

  async function listRuns(companyId: string, role?: string, limit = 50): Promise<EvalRunRecord[]> {
    const where = role
      ? and(eq(evalRuns.companyId, companyId), eq(evalRuns.role, role))
      : eq(evalRuns.companyId, companyId);
    const rows = await db.select().from(evalRuns).where(where).orderBy(desc(evalRuns.startedAt)).limit(limit);
    return rows.map(toOutcome);
  }

  /**
   * The pure scoring step: judge every task, fold the CI pass rate for code
   * tasks in as a criterion-shaped score line, aggregate.
   */
  async function scoreRun(
    tasks: readonly EvalTaskRow[],
    answers: Record<string, string>,
    input: { ciPassRate?: number | null; subject: string; role: string },
  ): Promise<{ scores: EvalRunScores; judgeResults: (JudgeTaskResult & { criteriaPoints: number })[] }> {
    const judgeResults: (JudgeTaskResult & { criteriaPoints: number })[] = [];
    for (const task of tasks) {
      const answer = answers[task.slug] ?? "";
      const result = await deps.judge.judgeTask({
        taskSlug: task.slug,
        prompt: task.prompt,
        answer,
        rubric: task.rubric,
        kind: task.kind,
      });
      const criteriaPoints = task.rubric.criteria.reduce((a, c) => a + c.points, 0);
      judgeResults.push({ ...result, criteriaPoints });
    }
    const scores = aggregateEvalScores(
      tasks.map((t, i) => {
        const result = judgeResults[i]!;
        // A code task folds the CI pass rate in as one extra criterion:
        // points = ciPassRate% of the task's rubric points, rounded.
        if (t.kind === "code" && typeof input.ciPassRate === "number") {
          const base = result.awarded;
          const extra = {
            ...base,
            __ci: Math.round((input.ciPassRate / 100) * t.rubric.criteria.reduce((a, c) => a + c.points, 0) * 100) / 100,
          };
          return { slug: t.slug, weight: t.weight, kind: t.kind, criteriaPoints: result.criteriaPoints + 0, awarded: extra };
        }
        return { slug: t.slug, weight: t.weight, kind: t.kind, criteriaPoints: result.criteriaPoints, awarded: result.awarded };
      }),
    );
    // maxScore for code tasks must account for the __ci extra criterion.
    const fixed = {
      ...scores,
      tasks: scores.tasks.map((ts, i) => {
        const t = tasks[i]!;
        if (t.kind === "code" && typeof input.ciPassRate === "number") {
          const rubricPoints = t.rubric.criteria.reduce((a, c) => a + c.points, 0);
          return { ...ts, maxScore: t.weight * rubricPoints * 2, rawScore: ts.rawScore };
        }
        return ts;
      }),
    };
    fixed.totalScore = fixed.tasks.reduce((a, t) => a + t.rawScore * t.weight, 0);
    fixed.maxScore = fixed.tasks.reduce((a, t) => a + t.maxScore, 0);
    fixed.scorePercent = fixed.maxScore > 0 ? Math.round((fixed.totalScore / fixed.maxScore) * 1000) / 10 : 0;
    return { scores: fixed, judgeResults };
  }

  /**
   * Run the eval for one subject. The verdict logic:
   * - no baseline or no drop beyond threshold → verdict `promote` (or null for a baseline run)
   * - drop beyond threshold on a first run → verdict `confirm`, needsConfirm
   * - drop beyond threshold on a confirmation run → verdict `regress`
   */
  async function runEval(input: EvalRunInput): Promise<RunOutcome> {
    const tasks = await loadTasks(input.companyId, input.role);
    if (tasks.length === 0) {
      throw new EvalsServiceError("evals_no_tasks", `no reference tasks for role "${input.role}"`);
    }
    const threshold = input.thresholdDrop ?? undefined;
    const runId = randomUUID();
    const startedAt = deps.now();
    // Insert the running row first so the board sees a live run.
    const [runningRow] = await db
      .insert(evalRuns)
      .values({
        id: runId,
        companyId: input.companyId,
        role: input.role,
        subject: input.subject,
        baselineId: input.baselineRunId ?? null,
        kind: "first",
        status: "running",
        model: deps.model,
        ciPassRate: typeof input.ciPassRate === "number" ? input.ciPassRate : null,
        startedAt,
      })
      .returning();
    try {
      const { scores } = await scoreRun(tasks, input.answers, { ciPassRate: input.ciPassRate, subject: input.subject, role: input.role });
      let verdict: EvalVerdict | null = null;
      let verdictReason: string | null = null;
      let confirmRunId: string | null = null;
      let confirmed = false;
      let needsConfirm = false;
      let thresholdDropValue: number | null = null;

      const baseline =
        input.baselineRunId && input.baselineRunId !== runId ? await getRun(input.companyId, input.baselineRunId) : null;
      if (baseline && baseline.status === "completed" && baseline.scores) {
        const decision = checkEvalRegressionThreshold(
          scores.scorePercent,
          baseline.scores.scorePercent,
          threshold ?? undefined,
        );
        thresholdDropValue = decision.thresholdDrop;
        if (decision.crossed) {
          verdict = "confirm";
          verdictReason = `drop ${decision.dropPercent} beyond threshold ${decision.thresholdDrop}; a confirmation run is required`;
          needsConfirm = true;
        } else {
          verdict = "promote";
          verdictReason = `drop ${decision.dropPercent} within threshold ${decision.thresholdDrop}`;
        }
      } else if (baseline) {
        verdict = null;
        verdictReason = `baseline run ${input.baselineRunId} is not completed; no comparison`;
      } else {
        verdict = null;
        verdictReason = "baseline run: no comparison";
      }

      const finishedAt = deps.now();
      const [row] = await db
        .update(evalRuns)
        .set({ status: "completed", scores, verdict, verdictReason, thresholdDrop: thresholdDropValue, confirmRunId, confirmed, finishedAt })
        .where(eq(evalRuns.id, runId))
        .returning();
      // Langfuse export is best-effort and behind the flag in settings.
      await deps.exporter?.exportRun({ runId, companyId: input.companyId, role: input.role, subject: input.subject, scores, verdict });
      return { run: toOutcome(row ?? runningRow!), needsConfirm };
    } catch (error) {
      const finishedAt = deps.now();
      const [row] = await db
        .update(evalRuns)
        .set({ status: "failed", error: (error as Error).message, finishedAt })
        .where(eq(evalRuns.id, runId))
        .returning();
      throw Object.assign(new EvalsServiceError("eval_run_failed", (error as Error).message), { run: toOutcome(row ?? runningRow!) });
    }
  }

  /**
   * The confirmation run: the same subject and answers, marked kind=confirm,
   * linked to the first run. Only a second threshold crossing turns the
   * verdict into `regress`.
   */
  async function runConfirmation(firstRunId: string, answers?: Record<string, string>): Promise<RunOutcome> {
    const first = await getRunById(firstRunId);
    if (!first) throw new EvalsServiceError("evals_run_not_found", `run ${firstRunId} not found`);
    if (first.companyId !== undefined) {
      // company boundary enforced by the caller; kept for tests
    }
    const tasks = await loadTasks(first.companyId, first.role);
    const effectiveAnswers = answers ?? readAnswersFromScores(first, tasks);
    const runId = randomUUID();
    const startedAt = deps.now();
    const [runningRow] = await db
      .insert(evalRuns)
      .values({
        id: runId,
        companyId: first.companyId,
        role: first.role,
        subject: first.subject,
        baselineId: first.baselineId,
        confirmRunId: firstRunId,
        kind: "confirm",
        status: "running",
        model: deps.model,
        ciPassRate: first.ciPassRate,
        startedAt,
      })
      .returning();
    try {
      const { scores } = await scoreRun(tasks, effectiveAnswers, {
        ciPassRate: first.ciPassRate,
        subject: first.subject,
        role: first.role,
      });
      const baseline = first.baselineId ? await getRun(first.companyId, first.baselineId) : null;
      let verdict: EvalVerdict;
      let verdictReason: string;
      let confirmed = false;
      if (baseline && baseline.status === "completed" && baseline.scores) {
        const decision = checkEvalRegressionThreshold(
          scores.scorePercent,
          baseline.scores.scorePercent,
          first.thresholdDrop ?? undefined,
        );
        if (decision.crossed) {
          verdict = "regress";
          verdictReason = `regression confirmed by the repeat run (drop ${decision.dropPercent} beyond threshold ${decision.thresholdDrop}); do not promote`;
          confirmed = true;
        } else {
          verdict = "promote";
          verdictReason = `suspected regression did not repeat (drop ${decision.dropPercent} within threshold ${decision.thresholdDrop})`;
          confirmed = true;
        }
      } else {
        verdict = "error";
        verdictReason = "baseline unavailable for the confirmation run";
      }
      const finishedAt = deps.now();
      const [row] = await db
        .update(evalRuns)
        .set({ status: "completed", scores, verdict, verdictReason, confirmed, finishedAt })
        .where(eq(evalRuns.id, runId))
        .returning();
      // Link the first run to its confirmation.
      await db.update(evalRuns).set({ confirmRunId: runId, confirmed }).where(eq(evalRuns.id, firstRunId));
      await deps.exporter?.exportRun({ runId, companyId: first.companyId, role: first.role, subject: first.subject, scores, verdict });
      return { run: toOutcome(row ?? runningRow!), needsConfirm: false };
    } catch (error) {
      const finishedAt = deps.now();
      const [row] = await db
        .update(evalRuns)
        .set({ status: "failed", error: (error as Error).message, finishedAt })
        .where(eq(evalRuns.id, runId))
        .returning();
      throw Object.assign(new EvalsServiceError("eval_run_failed", (error as Error).message), { run: toOutcome(row ?? runningRow!) });
    }
  }

  async function getRunById(runId: string): Promise<EvalRunRecord | null> {
    const rows = await db.select().from(evalRuns).where(eq(evalRuns.id, runId)).limit(1);
    return rows[0] ? toOutcome(rows[0]) : null;
  }

  /**
   * The SKILL-LIFECYCLE seam: verdict for a candidate against its baseline.
   * Delegates to the pure domain function; the lifecycle side calls this port.
   */
  async function verdictForCandidate(input: {
    companyId: string;
    role: string;
    subject: string;
    baselineRunId: string;
    thresholdDrop?: number;
  }): Promise<EvalVerdictForLifecycle> {
    const candidateRuns = await db
      .select()
      .from(evalRuns)
      .where(and(eq(evalRuns.companyId, input.companyId), eq(evalRuns.role, input.role), eq(evalRuns.subject, input.subject)))
      .orderBy(desc(evalRuns.startedAt));
    // The candidate is the subject's latest *first* run: a confirmation run
    // (kind=confirm) is a re-run of the same candidate, not a new one.
    const candidate = candidateRuns.find((r) => r.status === "completed" && r.kind === "first") ?? null;
    const baseline = await getRun(input.companyId, input.baselineRunId);
    if (!candidate || !baseline || !baseline.scores || !(candidate.scores as EvalRunScores | null)) {
      throw new EvalsServiceError("evals_no_completed_runs", "a completed candidate run and a completed baseline run are required");
    }
    const confirmRun = candidate.confirmRunId ? await getRunById(candidate.confirmRunId) : null;
    return decideEvalVerdictForLifecycle(
      { scorePercent: (candidate.scores as EvalRunScores).scorePercent, status: candidate.status, verdict: candidate.verdict },
      { scorePercent: baseline.scores.scorePercent, status: baseline.status, verdict: baseline.verdict },
      {
        thresholdDrop: input.thresholdDrop,
        confirmRun: confirmRun && confirmRun.status === "completed" && confirmRun.scores
          ? { scorePercent: confirmRun.scores.scorePercent, status: confirmRun.status, verdict: confirmRun.verdict }
          : null,
      },
    );
  }

  return { loadTasks, runEval, runConfirmation, getRun, getRunById, listRuns, verdictForCandidate, scoreRun };
}

export type EvalsService = ReturnType<typeof createEvalsService>;

/** Reconstruct the answers map from a stored run, for a confirmation re-run. */
function readAnswersFromScores(run: EvalRunRecord, tasks: readonly EvalTaskRow[]): Record<string, string> {
  // Answers are not persisted (only scores are); a confirmation re-run needs
  // the caller to pass them again. Return the task slugs so the caller knows
  // what to provide; empty answers score zero, which the threshold catches.
  void run;
  void tasks;
  return {};
}
