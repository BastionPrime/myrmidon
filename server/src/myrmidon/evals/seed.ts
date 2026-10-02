// server/src/myrmidon/evals/seed.ts
//
// myrmidon(1.6-EVALS): the seed corpus of reference tasks for the pilot role.
//
// 24 neutral tasks for the `engineer` role: a prompt, a kind (general/code)
// and a two-criterion rubric each. All data is neutral (no real agents,
// hosts, companies or ticket ids); each task names example.com-style
// entities only. The seeder is idempotent on (companyId, role, slug): a
// re-run updates prompt/rubric/weight in place instead of duplicating rows.

import type { Db } from "@paperclipai/db";
import { evalReferenceTasks } from "@paperclipai/db";
import { eq, and } from "drizzle-orm";
import { isEvalRubric, type EvalRubric } from "./domain.js";

/** The pilot role the 1.6 wave evaluates. */
export const EVALS_PILOT_ROLE = "engineer";

export interface SeedReferenceTask {
  slug: string;
  title: string;
  prompt: string;
  kind: "general" | "code";
  weight: number;
  rubric: EvalRubric;
}

const R = (a: string, aDesc: string, aPoints: number, b: string, bDesc: string, bPoints: number): EvalRubric => ({
  criteria: [
    { name: a, description: aDesc, points: aPoints },
    { name: b, description: bDesc, points: bPoints },
  ],
});

/**
 * The reference corpus. Neutral wording throughout; nothing an operator
 * could trace back to a real company, agent or host.
 */
export const ENGINEER_REFERENCE_TASKS: SeedReferenceTask[] = [
  {
    slug: "triage-incoming-issue",
    title: "Triage an incoming issue",
    prompt:
      "A ticket arrives: \"Users report the export button on the reports page returns a 500 error since this morning.\" Write the triage note: what you check first, in order, and what evidence you collect before proposing a fix.",
    kind: "general",
    weight: 1,
    rubric: R(
      "prioritization", "The note orders the checks by likelihood and cost, starting with the cheapest discriminating check.", 3,
      "evidence", "The note names the concrete artifacts to collect (logs, deploy diff, reproduction steps).", 3,
    ),
  },
  {
    slug: "write-repro-script",
    title: "Write a minimal reproduction script",
    prompt:
      "Write a minimal shell or Python script that reproduces: \"HTTP requests to example.com/api/v1/items intermittently return 429 even with no rate limit configured.\" The script must be safe to run and print a clear verdict line.",
    kind: "code",
    weight: 1,
    rubric: R(
      "minimality", "The script contains only the steps needed to reproduce and no unrelated scaffolding.", 3,
      "verdict", "The script prints an unambiguous pass/fail verdict a CI job could read.", 3,
    ),
  },
  {
    slug: "review-pr-comments",
    title: "Review a pull request",
    prompt:
      "You review a PR that adds a 300-line function with no tests and one TODO comment. Draft the review comment: the blocking points first, then the non-blocking notes, with the reason for each.",
    kind: "general",
    weight: 1,
    rubric: R(
      "blocking_first", "Blocking issues (no tests around complex logic) come first and are named as blocking.", 3,
      "actionable", "Each point says what to change, not only what is wrong.", 3,
    ),
  },
  {
    slug: "design-error-handling",
    title: "Design error handling for a flaky dependency",
    prompt:
      "A service calls a third-party API (example.com) that fails 2% of the time with a 503. Design the error handling: retries, backoff, fallback, and what the caller sees. State the limits of your design.",
    kind: "general",
    weight: 1,
    rubric: R(
      "strategy", "The design covers retry, backoff and a fallback path with concrete parameters.", 3,
      "limits", "The design states at least one condition where it fails or degrades.", 3,
    ),
  },
  {
    slug: "sql-index-advice",
    title: "Advise on a slow query",
    prompt:
      "A query `SELECT * FROM orders WHERE customer_id = ? AND status = 'paid' ORDER BY created_at DESC LIMIT 20` takes 4 seconds on 10M rows. Explain the likely cause and propose the fix, including what to verify before and after.",
    kind: "general",
    weight: 1,
    rubric: R(
      "diagnosis", "The explanation identifies a missing composite index / wrong plan as the likely cause.", 3,
      "verification", "The proposal says how to verify the fix (explain plan, timing).", 3,
    ),
  },
  {
    slug: "write-git-recovery",
    title: "Recover a lost commit",
    prompt:
      "A colleague says: \"I did a hard reset and lost my last commit.\" Give the exact commands to recover it, and one sentence on why they work.",
    kind: "code",
    weight: 1,
    rubric: R(
      "commands", "The commands are correct and complete (reflog or equivalent).", 4,
      "explanation", "The explanation of why the commit is recoverable is correct and short.", 2,
    ),
  },
  {
    slug: "plan-migration",
    title: "Plan a zero-downtime column add",
    prompt:
      "Plan adding a NOT NULL column to a 50M-row table used by a live service. List the steps in order and the failure mode each step guards against.",
    kind: "general",
    weight: 2,
    rubric: R(
      "steps", "The steps follow a safe order (add nullable, backfill, tighten) with no lock on the hot path.", 4,
      "failure_modes", "At least two steps name the failure mode they prevent.", 3,
    ),
  },
  {
    slug: "write-test-boundary",
    title: "Write a boundary test",
    prompt:
      "Write a unit test (any framework) for a function `parseDuration(text)` that must accept '1h30m', reject 'h', and return 0 for the empty string. Show only the test code.",
    kind: "code",
    weight: 1,
    rubric: R(
      "coverage", "The test covers all three named behaviors and asserts exact values.", 3,
      "isolation", "The test has no hidden order dependency or shared state.", 3,
    ),
  },
  {
    slug: "incident-first-hour",
    title: "Run the first hour of an incident",
    prompt:
      "At 09:10 the checkout API error rate jumps from 0.1% to 40%. Write the first-hour plan: what you do in the first 10 minutes, the next 20, and what you communicate meanwhile.",
    kind: "general",
    weight: 2,
    rubric: R(
      "stabilize_first", "The first actions reduce blast radius (rollback, feature flag, traffic shift) before root-causing.", 4,
      "communication", "The plan includes a stakeholder update with a concrete cadence.", 3,
    ),
   },
  {
    slug: "api-rate-limit-design",
    title: "Design a rate limiter",
    prompt:
      "Design a rate limiter for a public API: 100 requests/minute per key, 1000/hour per IP. Choose the algorithm, say where state lives, and explain the failure behavior when the state store is down.",
    kind: "general",
    weight: 1,
    rubric: R(
      "algorithm", "A concrete algorithm (token bucket / sliding window) with the tradeoff named.", 3,
      "fail_behavior", "The design says whether the limiter fails open or closed and why.", 3,
    ),
   },
  {
    slug: "read-stack-trace",
    title: "Read a stack trace",
    prompt:
      "Given `TypeError: Cannot read properties of undefined (reading 'map') at renderItems (Items.tsx:42) at ItemList (ItemList.tsx:18)` — write the debugging steps and the most likely fix.",
    kind: "general",
    weight: 1,
    rubric: R(
      "root_cause", "The steps trace the undefined value to its source before fixing.", 3,
      "fix_safety", "The fix handles the empty/undefined case instead of only the happy path.", 3,
    ),
  },
  {
    slug: "write-ci-pipeline",
    title: "Write a CI pipeline",
    prompt:
      "Write a CI pipeline (GitHub Actions) for a Node package: install, lint, typecheck, test, with caching. It must fail fast and not run the full suite twice on the same commit.",
    kind: "code",
    weight: 2,
    rubric: R(
      "correctness", "The YAML is structurally valid and the steps run in a sensible order.", 4,
      "efficiency", "Caching is present and redundant runs are prevented.", 3,
    ),
  },
  {
    slug: "negotiate-scope-319",
    title: "Answer a scope request",
    prompt:
      "A stakeholder asks to \"just also export to PDF\" in a ticket about fixing an export bug. Draft the reply that keeps the ticket scoped and offers a path for the new request.",
    kind: "general",
    weight: 1,
    rubric: R(
      "boundary", "The reply separates the new request from the fix without refusing outright.", 3,
      "path_forward", "The reply proposes a concrete next step for the new request.", 3,
    ),
  },
  {
    slug: "choose-storage",
    title: "Choose a storage engine",
    prompt:
      "A feature needs to store 500M key-value rows, read by key only, no transactions across rows, 10k reads/sec. Compare two storage options and state which you pick and the one condition that would flip the choice.",
    kind: "general",
    weight: 2,
    rubric: R(
      "comparison", "Two options are compared on the stated access pattern, not on generic pros/cons.", 4,
      "flip_condition", "A concrete condition that flips the decision is named.", 3,
    ),
  },
  {
    slug: "write-runbook",
    title: "Write a runbook step",
    prompt:
      "Write the runbook step \"restore the nightly backup to a verification environment\" so an on-call engineer who has never done it can follow it at 03:00. Include the verification and the abort condition.",
    kind: "general",
    weight: 2,
    rubric: R(
      "executable", "The step is a literal command sequence, not prose instructions.", 4,
      "abort_condition", "The step says when to stop and escalate instead of continuing.", 3,
    ),
  },
  {
    slug: "refactor-guard",
    title: "Refactor under a guard test",
    prompt:
      "You must rename a public function used in 40 files. Describe the exact sequence: the guard you write first, the mechanical rename, and how you prove nothing was missed.",
    kind: "general",
    weight: 1,
    rubric: R(
      "guard_first", "A failing/passing guard (grep, type, test) is written before the rename.", 3,
      "proof", "The proof of completeness is mechanical (compiler, grep count), not manual review only.", 3,
    ),
  },
  {
    slug: "explain-failure-domain",
    title: "Explain a failure domain",
    prompt:
      "A cache layer sits in front of the database. Explain what happens to latency and correctness when the cache hit rate drops from 95% to 50%, and which metric detects it first.",
    kind: "general",
    weight: 1,
    rubric: R(
      "mechanics", "The explanation traces the load shift to the database and its latency effect.", 3,
      "detection", "A specific first-detecting metric is named, not a vague \"monitoring\".", 3,
    ),
  },
  {
    slug: "write-error-message",
    title: "Write an operator-facing error",
    prompt:
      "Rewrite this log line so an on-call engineer can act on it: `ERROR: something went wrong in processor`. Keep it one line, include the entity id, the operation, and the next check.",
    kind: "general",
    weight: 1,
    rubric: R(
      "actionable", "The line names the entity, operation and a next check.", 4,
      "brevity", "The line stays one line with no secrets or noise.", 2,
    ),
   },
  {
    slug: "plan-rollback",
    title: "Plan a rollback",
    prompt:
      "A deploy just made things worse. Write the rollback checklist: what you verify first, the exact rollback steps, and what you do about data written since the deploy.",
    kind: "general",
    weight: 2,
    rubric: R(
      "order", "The checklist verifies the blast radius before acting.", 3,
      "data_plan", "The checklist addresses post-deploy data explicitly (keep, migrate or discard).", 4,
    ),
  },
  {
    slug: "review-own-diff",
    title: "Review your own diff",
    prompt:
      "Before handing your 12-file diff to review, list the five checks you run yourself, in the order that catches the most defects earliest.",
    kind: "general",
    weight: 1,
    rubric: R(
      "ordering", "The checks are ordered by defect-catching power (tests, contracts) not by convenience.", 3,
      "specificity", "The checks are concrete commands or comparisons, not intentions.", 3,
    ),
  },
  {
    slug: "estimate-task",
    title: "Estimate a task honestly",
    prompt:
      "A task is \"add an audit log to the settings page\". Write the estimate breakdown: what is included, what is excluded, and the two unknowns that could double it.",
    kind: "general",
    weight: 1,
    rubric: R(
      "boundaries", "Included and excluded work are stated separately.", 3,
      "unknowns", "At least two concrete unknowns are named with their effect.", 3,
    ),
  },
  {
    slug: "write-regex-safely",
    title: "Write a constrained parser",
    prompt:
      "Write a function that parses 'v1.2.3-rc.4' into major/minor/patch/rc parts and rejects '1.2', 'v1.2.3.4' and empty input. Show the code and three assertions.",
    kind: "code",
    weight: 1,
    rubric: R(
      "correctness", "The parser handles all listed inputs correctly, including rejections.", 4,
      "clarity", "The code is readable without a comment explaining the regex.", 2,
    ),
  },
  {
    slug: "postmortem-blameless",
    title: "Draft a blameless postmortem",
    prompt:
      "A bad config pushed by one engineer took the site down for 20 minutes. Draft the postmortem outline: timeline, contributing factors, and action items — with no blame in the language.",
    kind: "general",
    weight: 2,
    rubric: R(
      "structure", "The outline has a timeline, contributing factors and dated action items.", 3,
      "blameless", "The language describes systems and processes, not the person's fault.", 4,
    ),
  },
  {
    slug: "concurrency-bug",
    title: "Diagnose a race condition",
    prompt:
      "Two workers process the same queue item occasionally. The code checks `SELECT ... WHERE status='new'` then updates to 'processing' in a second statement. Explain the race and give the minimal fix.",
    kind: "general",
    weight: 2,
    rubric: R(
      "mechanism", "The explanation identifies the check-then-act window between the two statements.", 4,
      "minimal_fix", "The fix is atomic (row lock / atomic UPDATE ... WHERE) without a rewrite.", 3,
    ),
  },
];

/** True when every seed task is well-formed (rubric valid, points positive). */
export function validateSeedCorpus(tasks: readonly SeedReferenceTask[]): string | null {
  const seen = new Set<string>();
  for (const t of tasks) {
    if (!t.slug || seen.has(t.slug)) return `duplicate or empty slug: ${t.slug}`;
    seen.add(t.slug);
    if (t.kind !== "general" && t.kind !== "code") return `bad kind for ${t.slug}`;
    if (!Number.isInteger(t.weight) || t.weight < 1 || t.weight > 5) return `bad weight for ${t.slug}`;
    if (!isEvalRubric(t.rubric)) return `bad rubric for ${t.slug}`;
  }
  return null;
}

export interface SeedResult {
  role: string;
  inserted: number;
  updated: number;
}

/**
 * Seed the reference tasks for one company and role. Idempotent: a task with
 * the same (companyId, role, slug) is updated, not duplicated.
 */
export async function seedReferenceTasks(
  db: Db,
  companyId: string,
  role: string,
  tasks: readonly SeedReferenceTask[],
): Promise<SeedResult> {
  const problem = validateSeedCorpus(tasks);
  if (problem) throw new Error(`seed corpus invalid: ${problem}`);
  let inserted = 0;
  let updated = 0;
  for (const task of tasks) {
    const existing = await db
      .select({ id: evalReferenceTasks.id })
      .from(evalReferenceTasks)
      .where(and(eq(evalReferenceTasks.companyId, companyId), eq(evalReferenceTasks.role, role), eq(evalReferenceTasks.slug, task.slug)))
      .limit(1);
    if (existing.length > 0) {
      await db
        .update(evalReferenceTasks)
        .set({ title: task.title, prompt: task.prompt, kind: task.kind, weight: task.weight, rubric: task.rubric, updatedAt: new Date() })
        .where(eq(evalReferenceTasks.id, existing[0]!.id));
      updated += 1;
    } else {
      await db.insert(evalReferenceTasks).values({
        companyId,
        role,
        slug: task.slug,
        title: task.title,
        prompt: task.prompt,
        kind: task.kind,
        weight: task.weight,
        rubric: task.rubric,
      });
      inserted += 1;
    }
  }
  return { role, inserted, updated };
}
