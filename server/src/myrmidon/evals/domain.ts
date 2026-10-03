// server/src/myrmidon/evals/domain.ts
//
// myrmidon(1.6-EVALS): the pure part of the reference-task evaluation path.
//
// A company keeps a set of reference tasks for one role. A run sends each
// task's prompt to a subject, the judge (an LLM behind the company's gateway)
// scores the answer against the task rubric, and the aggregate decides
// whether the subject is promoted, needs a confirmation run, or regressed.
// This file has no database and no Express: it holds the types, the score
// threshold logic, and the SKILL-LIFECYCLE seam. The store-bound
// service and the routes sit on top.

/**
 * The verdict a run can carry. `promote` and `regress` are final (for a first
 * run that did not cross the threshold, or for a confirmed drop); `confirm`
 * means the first run crossed the threshold and a second run must agree
 * before anything is rolled back.
 */
export const EVAL_VERDICTS = ["promote", "confirm", "regress", "error"] as const;
export type EvalVerdict = (typeof EVAL_VERDICTS)[number];

export function isEvalVerdict(value: unknown): value is EvalVerdict {
  return typeof value === "string" && (EVAL_VERDICTS as readonly string[]).includes(value);
}

/** The kind of a reference task; `code` tasks also take a CI pass rate input. */
export const EVAL_TASK_KINDS = ["general", "code"] as const;
export type EvalTaskKind = (typeof EVAL_TASK_KINDS)[number];

export function isEvalTaskKind(value: unknown): value is EvalTaskKind {
  return typeof value === "string" && (EVAL_TASK_KINDS as readonly string[]).includes(value);
}

/**
 * One rubric criterion: what the judge grades an answer on. Kept as plain
 * data in the `rubric` jsonb column so a rubric can evolve without a
 * migration; `criteria` is the list the judge prompt is built from.
 */
export interface EvalRubricCriterion {
  /** Short machine name, unique inside one rubric. */
  name: string;
  /** What the criterion means, in judge-facing plain language. */
  description: string;
  /** Points the criterion is worth in the aggregate. */
  points: number;
}

export interface EvalRubric {
  criteria: EvalRubricCriterion[];
}

export function isEvalRubric(value: unknown): value is EvalRubric {
  if (typeof value !== "object" || value === null) return false;
  const criteria = (value as { criteria?: unknown }).criteria;
  if (!Array.isArray(criteria) || criteria.length === 0) return false;
  return criteria.every((c) => {
    if (typeof c !== "object" || c === null) return false;
    const r = c as Record<string, unknown>;
    return typeof r.name === "string" && r.name.length > 0 && typeof r.description === "string" && typeof r.points === "number" && r.points > 0;
  });
}

/** Per-task judge output stored in `eval_runs.scores`. */
export interface EvalTaskScore {
  taskSlug: string;
  /** Raw judge points per criterion: criterion name -> points awarded. */
  criteria: Record<string, number>;
  /** Criterion points summed (before weighting). */
  rawScore: number;
  /** The task's weight in the run aggregate. */
  weight: number;
  /** The maximum achievable for this task (weight * total criterion points). */
  maxScore: number;
}

/** The aggregate of one run stored in `eval_runs.scores`. */
export interface EvalRunScores {
  tasks: EvalTaskScore[];
  /** Sum of (rawScore * weight) over tasks. */
  totalScore: number;
  /** Sum of (maxScore * weight) over tasks. */
  maxScore: number;
  /** totalScore / maxScore * 100, one decimal. */
  scorePercent: number;
  /** The task kind counts, for the board view. */
  taskCount: number;
  codeTaskCount: number;
}

/** Aggregate a judge's per-task points into run scores. Pure. */
export function aggregateEvalScores(
  tasks: readonly { slug: string; weight: number; kind: EvalTaskKind; criteriaPoints: number; awarded: Record<string, number> }[],
): EvalRunScores {
  const taskScores: EvalTaskScore[] = tasks.map((t) => {
    const rawScore = Object.values(t.awarded).reduce((a, b) => a + b, 0);
    return {
      taskSlug: t.slug,
      criteria: t.awarded,
      rawScore,
      weight: t.weight,
      maxScore: t.weight * t.criteriaPoints,
    };
  });
  const totalScore = taskScores.reduce((a, t) => a + t.rawScore * t.weight, 0);
  const maxScore = taskScores.reduce((a, t) => a + t.maxScore, 0);
  return {
    tasks: taskScores,
    totalScore,
    maxScore,
    scorePercent: maxScore > 0 ? Math.round((totalScore / maxScore) * 1000) / 10 : 0,
    taskCount: taskScores.length,
    codeTaskCount: tasks.filter((t) => t.kind === "code").length,
  };
}

/** A run's outcome in the compact form the threshold compares. */
export interface EvalRunOutcome {
  scorePercent: number;
  status: string;
  verdict: string | null;
}

/**
 * Default drop tolerance: how many percentage points a candidate may lose
 * against the baseline before the run crosses the regression threshold.
 * Small enough to catch a real skill regression, large enough to absorb the
 * judge's run-to-run noise on a free model.
 */
export const DEFAULT_EVAL_REGRESSION_DROP = 5;

/** A comparison result; `dropPercent` is baseline minus candidate (positive = worse). */
export interface EvalThresholdDecision {
  crossed: boolean;
  dropPercent: number;
  thresholdDrop: number;
}

/** Pure threshold check: did the candidate drop more than allowed? */
export function checkEvalRegressionThreshold(
  candidatePercent: number,
  baselinePercent: number,
  thresholdDrop = DEFAULT_EVAL_REGRESSION_DROP,
): EvalThresholdDecision {
  const dropPercent = Math.round((baselinePercent - candidatePercent) * 10) / 10;
  return { crossed: dropPercent > thresholdDrop, dropPercent, thresholdDrop };
}

/**
 * The SKILL-LIFECYCLE seam (myr/1.6-skill-lifecycle, not merged yet).
 *
 * The lifecycle asks "did this candidate regress against its baseline?" and
 * expects a promote/rollback decision with the evidence. Until the sibling
 * branch merges, the evals side owns the contract: this pure function and the
 * `EvalSkillLifecyclePort` type. The lifecycle side will import or mirror it;
 * the shape is additive-only so no vendor file changes when it lands.
 */
export interface EvalVerdictForLifecycle {
  promote: boolean;
  scores: { baselinePercent: number; candidatePercent: number; dropPercent: number; thresholdDrop: number };
  reason: string;
}

export function decideEvalVerdictForLifecycle(
  candidate: EvalRunOutcome,
  baseline: EvalRunOutcome,
  options: { thresholdDrop?: number; confirmRun?: EvalRunOutcome | null } = {},
): EvalVerdictForLifecycle {
  const threshold = options.thresholdDrop ?? DEFAULT_EVAL_REGRESSION_DROP;
  const first = checkEvalRegressionThreshold(candidate.scorePercent, baseline.scorePercent, threshold);
  if (!first.crossed) {
    return {
      promote: true,
      scores: { baselinePercent: baseline.scorePercent, candidatePercent: candidate.scorePercent, dropPercent: first.dropPercent, thresholdDrop: threshold },
      reason: `no regression: drop ${first.dropPercent} points is within threshold ${threshold}`,
    };
  }
  const confirm = options.confirmRun;
  if (!confirm) {
    // First run crossed the threshold; a confirmation run must agree.
    return {
      promote: false,
      scores: { baselinePercent: baseline.scorePercent, candidatePercent: candidate.scorePercent, dropPercent: first.dropPercent, thresholdDrop: threshold },
      reason: `regression suspected (drop ${first.dropPercent} > ${threshold}); a confirmation run is required`,
    };
  }
  const second = checkEvalRegressionThreshold(confirm.scorePercent, baseline.scorePercent, threshold);
  if (second.crossed) {
    return {
      promote: false,
      scores: { baselinePercent: baseline.scorePercent, candidatePercent: candidate.scorePercent, dropPercent: second.dropPercent, thresholdDrop: threshold },
      reason: `regression confirmed by the repeat run (drop ${second.dropPercent} > ${threshold}); do not promote, roll back`,
    };
  }
  return {
    promote: false,
    scores: { baselinePercent: baseline.scorePercent, candidatePercent: candidate.scorePercent, dropPercent: second.dropPercent, thresholdDrop: threshold },
    reason: `suspected regression did not repeat (repeat drop ${second.dropPercent} within threshold ${threshold}); retry from a fresh run`,
  };
}

/**
 * The port the (not-yet-merged) SKILL-LIFECYCLE service will call into. Kept
 * here as the frozen contract; the lifecycle side wires it to its own store.
 */
export interface EvalSkillLifecyclePort {
  /** Evaluate one candidate against the baseline run; see decideEvalVerdictForLifecycle. */
  verdictForCandidate(input: {
    companyId: string;
    role: string;
    subject: string;
    baselineRunId: string;
    thresholdDrop?: number;
  }): Promise<EvalVerdictForLifecycle>;
}

export function isEvalVerdictForLifecycle(value: unknown): value is EvalVerdictForLifecycle {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.promote === "boolean" && typeof v.reason === "string" && typeof v.scores === "object" && v.scores !== null;
}
