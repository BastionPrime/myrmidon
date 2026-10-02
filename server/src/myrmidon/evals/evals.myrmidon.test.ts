import { describe, expect, it } from "vitest";

import {
  aggregateEvalScores,
  checkEvalRegressionThreshold,
  decideEvalVerdictForLifecycle,
  isEvalRubric,
  isEvalVerdict,
  isEvalVerdictForLifecycle,
  DEFAULT_EVAL_REGRESSION_DROP,
} from "./index.js";

// Neutral data only (no real agents, keys or hosts).

const rubric = {
  criteria: [
    { name: "correctness", description: "the answer is correct", points: 3 },
    { name: "clarity", description: "the answer is clear", points: 3 },
  ],
};

describe("myrmidon(1.6-EVALS) rubric and score types", () => {
  it("accepts a well-formed rubric and rejects malformed ones", () => {
    expect(isEvalRubric(rubric)).toBe(true);
    expect(isEvalRubric({ criteria: [] })).toBe(false);
    expect(isEvalRubric(null)).toBe(false);
    expect(isEvalRubric({ criteria: [{ name: "x", description: "y", points: 0 }] })).toBe(false);
    expect(isEvalRubric({ criteria: [{ name: "", description: "y", points: 1 }] })).toBe(false);
    expect(isEvalRubric({ criteria: [{ name: "x", description: "y", points: 1.5 }] })).toBe(true);
  });

  it("recognizes the verdict set", () => {
    expect(isEvalVerdict("promote")).toBe(true);
    expect(isEvalVerdict("confirm")).toBe(true);
    expect(isEvalVerdict("regress")).toBe(true);
    expect(isEvalVerdict("error")).toBe(true);
    expect(isEvalVerdict("maybe")).toBe(false);
    expect(isEvalVerdict(null)).toBe(false);
  });
});

describe("myrmidon(1.6-EVALS) aggregateEvalScores", () => {
  it("weights tasks and computes the percentage", () => {
    const scores = aggregateEvalScores([
      { slug: "task-a", weight: 2, kind: "general" as const, criteriaPoints: 6, awarded: { correctness: 3, clarity: 3 } },
      { slug: "task-b", weight: 1, kind: "general" as const, criteriaPoints: 6, awarded: { correctness: 1, clarity: 2 } },
    ]);
    // task-a: 6*2=12 max, 6*2=12 got; task-b: 6 max, 3 got
    expect(scores.totalScore).toBe(12 + 3);
    expect(scores.maxScore).toBe(12 + 6);
    expect(scores.scorePercent).toBe(83.3);
    expect(scores.taskCount).toBe(2);
    expect(scores.codeTaskCount).toBe(0);
  });

  it("returns zero percent on an empty award set without dividing by zero", () => {
    const scores = aggregateEvalScores([]);
    expect(scores.scorePercent).toBe(0);
    expect(scores.totalScore).toBe(0);
  });
});

describe("myrmidon(1.6-EVALS) regression threshold", () => {
  it("does not cross while the drop is within the default threshold", () => {
    const d = checkEvalRegressionThreshold(96, 100, DEFAULT_EVAL_REGRESSION_DROP);
    expect(d.crossed).toBe(false);
    expect(d.dropPercent).toBe(4);
  });

  it("crosses only beyond the threshold, not exactly at it", () => {
    expect(checkEvalRegressionThreshold(95, 100, 5).crossed).toBe(false);
    expect(checkEvalRegressionThreshold(94.9, 100, 5).crossed).toBe(true);
  });

  it("treats an improvement as a negative drop that never crosses", () => {
    const d = checkEvalRegressionThreshold(102, 100, 5);
    expect(d.crossed).toBe(false);
    expect(d.dropPercent).toBe(-2);
  });
});

describe("myrmidon(1.6-EVALS) SKILL-LIFECYCLE verdict seam", () => {
  const baseline = { scorePercent: 90, status: "completed", verdict: null };

  it("promotes when the candidate is within the threshold", () => {
    const v = decideEvalVerdictForLifecycle({ scorePercent: 88, status: "completed", verdict: null }, baseline);
    expect(v.promote).toBe(true);
    expect(v.reason).toContain("within threshold");
  });

  it("refuses to promote on a suspected regression and asks for a confirmation run", () => {
    const v = decideEvalVerdictForLifecycle({ scorePercent: 70, status: "completed", verdict: null }, baseline);
    expect(v.promote).toBe(false);
    expect(v.reason).toContain("confirmation run is required");
  });

  it("refuses to promote and demands rollback when the repeat confirms the drop", () => {
    const v = decideEvalVerdictForLifecycle(
      { scorePercent: 70, status: "completed", verdict: null },
      baseline,
      { confirmRun: { scorePercent: 69, status: "completed", verdict: null } },
    );
    expect(v.promote).toBe(false);
    expect(v.reason).toContain("confirmed by the repeat run");
    expect(v.reason).toContain("roll back");
  });

  it("promotes nothing when the suspected drop does not repeat (retry from a fresh run)", () => {
    const v = decideEvalVerdictForLifecycle(
      { scorePercent: 70, status: "completed", verdict: null },
      baseline,
      { confirmRun: { scorePercent: 89, status: "completed", verdict: null } },
    );
    expect(v.promote).toBe(false);
    expect(v.reason).toContain("did not repeat");
  });

  it("round-trips through the lifecycle type guard", () => {
    const v = decideEvalVerdictForLifecycle({ scorePercent: 90, status: "completed", verdict: null }, baseline);
    expect(isEvalVerdictForLifecycle(v)).toBe(true);
    expect(isEvalVerdictForLifecycle({ promote: "yes" })).toBe(false);
  });
});
