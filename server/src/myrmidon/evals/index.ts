// server/src/myrmidon/evals/index.ts
//
// myrmidon(1.6-EVALS): the entry point of the reference-task evaluation
// path. The domain (types, threshold, SKILL-LIFECYCLE seam), the judge
// (gateway LLM), the seed corpus, the run service and the board REST routes
// are re-exported from here so the rest of the server imports one module.
//
// The judge contour mirrors the OCR contour: MYRMIDON_EVALS_BASE_URL,
// MYRMIDON_EVALS_KEY_SECRET (company secret *name*, never the value),
// MYRMIDON_EVALS_MODEL (default: a free DashScope model) and the Langfuse
// export flag. Unset means off, with a stable "not configured" error.

export {
  EVAL_VERDICTS,
  isEvalVerdict,
  EVAL_TASK_KINDS,
  isEvalTaskKind,
  isEvalRubric,
  DEFAULT_EVAL_REGRESSION_DROP,
  aggregateEvalScores,
  checkEvalRegressionThreshold,
  decideEvalVerdictForLifecycle,
  isEvalVerdictForLifecycle,
  type EvalVerdict,
  type EvalTaskKind,
  type EvalRubric,
  type EvalRubricCriterion,
  type EvalTaskScore,
  type EvalRunScores,
  type EvalRunOutcome,
  type EvalThresholdDecision,
  type EvalVerdictForLifecycle,
  type EvalSkillLifecyclePort,
} from "./domain.js";
export {
  EVALS_BASE_URL_ENV,
  EVALS_KEY_SECRET_ENV,
  EVALS_MODEL_ENV,
  EVALS_TIMEOUT_SEC_ENV,
  EVALS_LANGFUSE_FLAG_ENV,
  DEFAULT_EVALS_MODEL,
  readEvalsSettings,
  evalsSettingsProblem,
  createJudge,
  createHeuristicJudge,
  parseJudgeResponse,
  EvalJudgeError,
  type EvalsSettings,
  type JudgePort,
  type JudgeTaskResult,
  type JudgeDeps,
} from "./judge.js";
export {
  createLangfuseScoreExporter,
  noopScoreExporter,
  readLangfuseExportSettings,
  type EvalsScoreExporter,
  type LangfuseExportSettings,
} from "./langfuse.js";
export {
  ENGINEER_REFERENCE_TASKS,
  EVALS_PILOT_ROLE,
  seedReferenceTasks,
  validateSeedCorpus,
  type SeedReferenceTask,
  type SeedResult,
} from "./seed.js";
export {
  createEvalsService,
  EvalsServiceError,
  type EvalsService,
  type EvalsServiceDeps,
  type EvalRunInput,
  type EvalRunRecord,
  type EvalTaskRow,
  type EvalRunStatus,
  type RunOutcome,
} from "./service.js";
export { myrmidonEvalsRoutes, EVALS_ACTOR_ID, type EvalsRoutesDeps } from "./routes.js";
