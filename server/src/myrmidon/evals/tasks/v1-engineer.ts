// server/src/myrmidon/evals/tasks/v1-engineer.ts
//
// myrmidon(1.6-EVALS-B): the versioned reference-task corpus for the pilot
// role `engineer` — Part B's half of the evals epic.
//
// 36 tasks (>= 20, <= 50, per the epic). Each task is one neutral prompt a
// working engineer must answer plus a rubric the judge scores the answer
// against. All data is neutral: no real agents, companies, hosts, board
// ticket ids or person names; example.com-style entities only. Weights:
// 1 = routine, 2 = consequential, 3 = rare-and-critical.
//
// Versioning: every task carries the corpusVersion of its last change and a
// changeNote. The first release was 1.0.0 for 24 tasks shared by slug with
// the Part A seed draft, plus 1.1.0 for 12 tasks this corpus added on top.
// In 1.2.0 the 24 shared tasks are re-mirrored byte-for-byte from the final
// Part A seed (branch myr/1.6-evals-a, ENGINEER_REFERENCE_TASKS in
// server/src/myrmidon/evals/seed.ts): the 1.0.0 release had rewritten
// their content while calling them a mirror, which would have made the two
// sources fight over the same (companyId, role, slug) rows. Part A's seed
// is now the single source of truth for those 24 tasks; this corpus is
// its versioned mirror, and a future edit to a shared task must land in
// Part A first and then be re-mirrored here with a version bump.

import type { VersionedReferenceTask } from "./corpus-versioning.js";

/** Shortest rubric builder: two criteria with points. */
function R(
  a: string,
  aDesc: string,
  aPoints: number,
  b: string,
  bDesc: string,
  bPoints: number,
): VersionedReferenceTask["rubric"] {
  return {
    criteria: [
      { name: a, description: aDesc, points: aPoints },
      { name: b, description: bDesc, points: bPoints },
    ],
  };
}

/** Builder for a three-criterion rubric. */
function R3(
  a: string,
  aDesc: string,
  aPoints: number,
  b: string,
  bDesc: string,
  bPoints: number,
  c: string,
  cDesc: string,
  cPoints: number,
): VersionedReferenceTask["rubric"] {
  return {
    criteria: [
      { name: a, description: aDesc, points: aPoints },
      { name: b, description: bDesc, points: bPoints },
      { name: c, description: cDesc, points: cPoints },
    ],
  };
}

const ADDED = "1.1.0";
const REMIRRORED = "1.2.0";
const REMIRROR_NOTE =
  "1.2.0 re-mirrored from the final Part A seed (myr/1.6-evals-a): prompt, rubric, weight and kind now match Part A exactly; the 1.0.0 release had rewritten this content while keeping the slug";

/**
 * The `engineer` role corpus. Sorted by slug for stable diffs; the loader
 * re-sorts anyway, this order just keeps reviews readable.
 */
export const ENGINEER_TASKS_V1: VersionedReferenceTask[] = [
  // ---- 1.2.0: the 24 tasks re-mirrored from the final Part A seed so both
  // parts seed identical content on the same (companyId, role, slug) rows.
  // Part A's ENGINEER_REFERENCE_TASKS is the source of truth; this list
  // is its versioned mirror.
  {
    corpusVersion: REMIRRORED,
    changeNote: REMIRROR_NOTE,
    slug: "triage-incoming-issue",
    title: "Triage an incoming issue",
    prompt: "A ticket arrives: \"Users report the export button on the reports page returns a 500 error since this morning.\" Write the triage note: what you check first, in order, and what evidence you collect before proposing a fix.",
    kind: "general",
    weight: 1,
    rubric: R(
      "prioritization", "The note orders the checks by likelihood and cost, starting with the cheapest discriminating check.", 3,
      "evidence", "The note names the concrete artifacts to collect (logs, deploy diff, reproduction steps).", 3,
    ),
  },
  {
    corpusVersion: REMIRRORED,
    changeNote: REMIRROR_NOTE,
    slug: "write-repro-script",
    title: "Write a minimal reproduction script",
    prompt: "Write a minimal shell or Python script that reproduces: \"HTTP requests to example.com/api/v1/items intermittently return 429 even with no rate limit configured.\" The script must be safe to run and print a clear verdict line.",
    kind: "code",
    weight: 1,
    rubric: R(
      "minimality", "The script contains only the steps needed to reproduce and no unrelated scaffolding.", 3,
      "verdict", "The script prints an unambiguous pass/fail verdict a CI job could read.", 3,
    ),
  },
  {
    corpusVersion: REMIRRORED,
    changeNote: REMIRROR_NOTE,
    slug: "review-pr-comments",
    title: "Review a pull request",
    prompt: "You review a PR that adds a 300-line function with no tests and one TODO comment. Draft the review comment: the blocking points first, then the non-blocking notes, with the reason for each.",
    kind: "general",
    weight: 1,
    rubric: R(
      "blocking_first", "Blocking issues (no tests around complex logic) come first and are named as blocking.", 3,
      "actionable", "Each point says what to change, not only what is wrong.", 3,
    ),
  },
  {
    corpusVersion: REMIRRORED,
    changeNote: REMIRROR_NOTE,
    slug: "design-error-handling",
    title: "Design error handling for a flaky dependency",
    prompt: "A service calls a third-party API (example.com) that fails 2% of the time with a 503. Design the error handling: retries, backoff, fallback, and what the caller sees. State the limits of your design.",
    kind: "general",
    weight: 1,
    rubric: R(
      "strategy", "The design covers retry, backoff and a fallback path with concrete parameters.", 3,
      "limits", "The design states at least one condition where it fails or degrades.", 3,
    ),
  },
  {
    corpusVersion: REMIRRORED,
    changeNote: REMIRROR_NOTE,
    slug: "sql-index-advice",
    title: "Advise on a slow query",
    prompt: "A query `SELECT * FROM orders WHERE customer_id = ? AND status = 'paid' ORDER BY created_at DESC LIMIT 20` takes 4 seconds on 10M rows. Explain the likely cause and propose the fix, including what to verify before and after.",
    kind: "general",
    weight: 1,
    rubric: R(
      "diagnosis", "The explanation identifies a missing composite index / wrong plan as the likely cause.", 3,
      "verification", "The proposal says how to verify the fix (explain plan, timing).", 3,
    ),
  },
  {
    corpusVersion: REMIRRORED,
    changeNote: REMIRROR_NOTE,
    slug: "write-git-recovery",
    title: "Recover a lost commit",
    prompt: "A colleague says: \"I did a hard reset and lost my last commit.\" Give the exact commands to recover it, and one sentence on why they work.",
    kind: "code",
    weight: 1,
    rubric: R(
      "commands", "The commands are correct and complete (reflog or equivalent).", 4,
      "explanation", "The explanation of why the commit is recoverable is correct and short.", 2,
    ),
  },
  {
    corpusVersion: REMIRRORED,
    changeNote: REMIRROR_NOTE,
    slug: "plan-migration",
    title: "Plan a zero-downtime column add",
    prompt: "Plan adding a NOT NULL column to a 50M-row table used by a live service. List the steps in order and the failure mode each step guards against.",
    kind: "general",
    weight: 2,
    rubric: R(
      "steps", "The steps follow a safe order (add nullable, backfill, tighten) with no lock on the hot path.", 4,
      "failure_modes", "At least two steps name the failure mode they prevent.", 3,
    ),
  },
  {
    corpusVersion: REMIRRORED,
    changeNote: REMIRROR_NOTE,
    slug: "write-test-boundary",
    title: "Write a boundary test",
    prompt: "Write a unit test (any framework) for a function `parseDuration(text)` that must accept '1h30m', reject 'h', and return 0 for the empty string. Show only the test code.",
    kind: "code",
    weight: 1,
    rubric: R(
      "coverage", "The test covers all three named behaviors and asserts exact values.", 3,
      "isolation", "The test has no hidden order dependency or shared state.", 3,
    ),
  },
  {
    corpusVersion: REMIRRORED,
    changeNote: REMIRROR_NOTE,
    slug: "incident-first-hour",
    title: "Run the first hour of an incident",
    prompt: "At 09:10 the checkout API error rate jumps from 0.1% to 40%. Write the first-hour plan: what you do in the first 10 minutes, the next 20, and what you communicate meanwhile.",
    kind: "general",
    weight: 2,
    rubric: R(
      "stabilize_first", "The first actions reduce blast radius (rollback, feature flag, traffic shift) before root-causing.", 4,
      "communication", "The plan includes a stakeholder update with a concrete cadence.", 3,
    ),
  },
  {
    corpusVersion: REMIRRORED,
    changeNote: REMIRROR_NOTE,
    slug: "api-rate-limit-design",
    title: "Design a rate limiter",
    prompt: "Design a rate limiter for a public API: 100 requests/minute per key, 1000/hour per IP. Choose the algorithm, say where state lives, and explain the failure behavior when the state store is down.",
    kind: "general",
    weight: 1,
    rubric: R(
      "algorithm", "A concrete algorithm (token bucket / sliding window) with the tradeoff named.", 3,
      "fail_behavior", "The design says whether the limiter fails open or closed and why.", 3,
    ),
  },
  {
    corpusVersion: REMIRRORED,
    changeNote: REMIRROR_NOTE,
    slug: "read-stack-trace",
    title: "Read a stack trace",
    prompt: "Given `TypeError: Cannot read properties of undefined (reading 'map') at renderItems (Items.tsx:42) at ItemList (ItemList.tsx:18)` \u2014 write the debugging steps and the most likely fix.",
    kind: "general",
    weight: 1,
    rubric: R(
      "root_cause", "The steps trace the undefined value to its source before fixing.", 3,
      "fix_safety", "The fix handles the empty/undefined case instead of only the happy path.", 3,
    ),
  },
  {
    corpusVersion: REMIRRORED,
    changeNote: REMIRROR_NOTE,
    slug: "write-ci-pipeline",
    title: "Write a CI pipeline",
    prompt: "Write a CI pipeline (GitHub Actions) for a Node package: install, lint, typecheck, test, with caching. It must fail fast and not run the full suite twice on the same commit.",
    kind: "code",
    weight: 2,
    rubric: R(
      "correctness", "The YAML is structurally valid and the steps run in a sensible order.", 4,
      "efficiency", "Caching is present and redundant runs are prevented.", 3,
    ),
  },
  {
    corpusVersion: REMIRRORED,
    changeNote: REMIRROR_NOTE,
    slug: "negotiate-scope-319",
    title: "Answer a scope request",
    prompt: "A stakeholder asks to \"just also export to PDF\" in a ticket about fixing an export bug. Draft the reply that keeps the ticket scoped and offers a path for the new request.",
    kind: "general",
    weight: 1,
    rubric: R(
      "boundary", "The reply separates the new request from the fix without refusing outright.", 3,
      "path_forward", "The reply proposes a concrete next step for the new request.", 3,
    ),
  },
  {
    corpusVersion: REMIRRORED,
    changeNote: REMIRROR_NOTE,
    slug: "choose-storage",
    title: "Choose a storage engine",
    prompt: "A feature needs to store 500M key-value rows, read by key only, no transactions across rows, 10k reads/sec. Compare two storage options and state which you pick and the one condition that would flip the choice.",
    kind: "general",
    weight: 2,
    rubric: R(
      "comparison", "Two options are compared on the stated access pattern, not on generic pros/cons.", 4,
      "flip_condition", "A concrete condition that flips the decision is named.", 3,
    ),
  },
  {
    corpusVersion: REMIRRORED,
    changeNote: REMIRROR_NOTE,
    slug: "write-runbook",
    title: "Write a runbook step",
    prompt: "Write the runbook step \"restore the nightly backup to a verification environment\" so an on-call engineer who has never done it can follow it at 03:00. Include the verification and the abort condition.",
    kind: "general",
    weight: 2,
    rubric: R(
      "executable", "The step is a literal command sequence, not prose instructions.", 4,
      "abort_condition", "The step says when to stop and escalate instead of continuing.", 3,
    ),
  },
  {
    corpusVersion: REMIRRORED,
    changeNote: REMIRROR_NOTE,
    slug: "refactor-guard",
    title: "Refactor under a guard test",
    prompt: "You must rename a public function used in 40 files. Describe the exact sequence: the guard you write first, the mechanical rename, and how you prove nothing was missed.",
    kind: "general",
    weight: 1,
    rubric: R(
      "guard_first", "A failing/passing guard (grep, type, test) is written before the rename.", 3,
      "proof", "The proof of completeness is mechanical (compiler, grep count), not manual review only.", 3,
    ),
  },
  {
    corpusVersion: REMIRRORED,
    changeNote: REMIRROR_NOTE,
    slug: "explain-failure-domain",
    title: "Explain a failure domain",
    prompt: "A cache layer sits in front of the database. Explain what happens to latency and correctness when the cache hit rate drops from 95% to 50%, and which metric detects it first.",
    kind: "general",
    weight: 1,
    rubric: R(
      "mechanics", "The explanation traces the load shift to the database and its latency effect.", 3,
      "detection", "A specific first-detecting metric is named, not a vague \"monitoring\".", 3,
    ),
  },
  {
    corpusVersion: REMIRRORED,
    changeNote: REMIRROR_NOTE,
    slug: "write-error-message",
    title: "Write an operator-facing error",
    prompt: "Rewrite this log line so an on-call engineer can act on it: `ERROR: something went wrong in processor`. Keep it one line, include the entity id, the operation, and the next check.",
    kind: "general",
    weight: 1,
    rubric: R(
      "actionable", "The line names the entity, operation and a next check.", 4,
      "brevity", "The line stays one line with no secrets or noise.", 2,
    ),
  },
  {
    corpusVersion: REMIRRORED,
    changeNote: REMIRROR_NOTE,
    slug: "plan-rollback",
    title: "Plan a rollback",
    prompt: "A deploy just made things worse. Write the rollback checklist: what you verify first, the exact rollback steps, and what you do about data written since the deploy.",
    kind: "general",
    weight: 2,
    rubric: R(
      "order", "The checklist verifies the blast radius before acting.", 3,
      "data_plan", "The checklist addresses post-deploy data explicitly (keep, migrate or discard).", 4,
    ),
  },
  {
    corpusVersion: REMIRRORED,
    changeNote: REMIRROR_NOTE,
    slug: "review-own-diff",
    title: "Review your own diff",
    prompt: "Before handing your 12-file diff to review, list the five checks you run yourself, in the order that catches the most defects earliest.",
    kind: "general",
    weight: 1,
    rubric: R(
      "ordering", "The checks are ordered by defect-catching power (tests, contracts) not by convenience.", 3,
      "specificity", "The checks are concrete commands or comparisons, not intentions.", 3,
    ),
  },
  {
    corpusVersion: REMIRRORED,
    changeNote: REMIRROR_NOTE,
    slug: "estimate-task",
    title: "Estimate a task honestly",
    prompt: "A task is \"add an audit log to the settings page\". Write the estimate breakdown: what is included, what is excluded, and the two unknowns that could double it.",
    kind: "general",
    weight: 1,
    rubric: R(
      "boundaries", "Included and excluded work are stated separately.", 3,
      "unknowns", "At least two concrete unknowns are named with their effect.", 3,
    ),
  },
  {
    corpusVersion: REMIRRORED,
    changeNote: REMIRROR_NOTE,
    slug: "write-regex-safely",
    title: "Write a constrained parser",
    prompt: "Write a function that parses 'v1.2.3-rc.4' into major/minor/patch/rc parts and rejects '1.2', 'v1.2.3.4' and empty input. Show the code and three assertions.",
    kind: "code",
    weight: 1,
    rubric: R(
      "correctness", "The parser handles all listed inputs correctly, including rejections.", 4,
      "clarity", "The code is readable without a comment explaining the regex.", 2,
    ),
  },
  {
    corpusVersion: REMIRRORED,
    changeNote: REMIRROR_NOTE,
    slug: "postmortem-blameless",
    title: "Draft a blameless postmortem",
    prompt: "A bad config pushed by one engineer took the site down for 20 minutes. Draft the postmortem outline: timeline, contributing factors, and action items \u2014 with no blame in the language.",
    kind: "general",
    weight: 2,
    rubric: R(
      "structure", "The outline has a timeline, contributing factors and dated action items.", 3,
      "blameless", "The language describes systems and processes, not the person's fault.", 4,
    ),
  },
  {
    corpusVersion: REMIRRORED,
    changeNote: REMIRROR_NOTE,
    slug: "concurrency-bug",
    title: "Diagnose a race condition",
    prompt: "Two workers process the same queue item occasionally. The code checks `SELECT ... WHERE status='new'` then updates to 'processing' in a second statement. Explain the race and give the minimal fix.",
    kind: "general",
    weight: 2,
    rubric: R(
      "mechanism", "The explanation identifies the check-then-act window between the two statements.", 4,
      "minimal_fix", "The fix is atomic (row lock / atomic UPDATE ... WHERE) without a rewrite.", 3,
    ),
  },
  // ---- 1.1.0: the 12 tasks Part B adds to reach a 36-task corpus.
  {
    corpusVersion: ADDED,
    changeNote: "added in 1.1.0 to widen the corpus",
    slug: "arch-review-tradeoffs",
    title: "Review an architecture proposal",
    prompt:
      "A proposal introduces a message queue between the web app and the invoice service. Draft the review: two questions about failure modes, one about ordering, and one cheaper alternative.",
    kind: "general",
    weight: 2,
    rubric: R3(
      "failure_modes", "The questions target concrete failure modes (poison message, consumer death, redelivery).", 3,
      "ordering", "One question addresses ordering or idempotency of processing.", 2,
      "alternative", "A cheaper alternative (sync call with retry, cron batch) is named and bounded.", 2,
    ),
  },
  {
    corpusVersion: ADDED,
    changeNote: "added in 1.1.0 to widen the corpus",
    slug: "backfill-strategy",
    title: "Backfill data safely",
    prompt:
      "A new column `region` must be backfilled for 80M rows from an external mapping file. Write the backfill plan: batching, throttling, verification, and the undo path.",
    kind: "general",
    weight: 2,
    rubric: R3(
      "batching", "The plan processes in bounded batches with a pause between them.", 3,
      "verification", "The plan verifies row counts and sampled values before and after.", 2,
      "undo", "The plan can stop and revert partially applied batches.", 2,
    ),
  },
  {
    corpusVersion: ADDED,
    changeNote: "added in 1.1.0 to widen the corpus",
    slug: "cache-invalidation-choice",
    title: "Choose a cache invalidation",
    prompt:
      "A product list is cached for 5 minutes; a price change must appear within 30 seconds. Propose the invalidation approach, the consistency risk, and a guard for the risk.",
    kind: "general",
    weight: 2,
    rubric: R(
      "approach", "The proposal (event-driven purge / shorter TTL for price) meets the 30-second bound.", 3,
      "risk_guard", "The consistency risk is named with a guard (versioned keys, re-check on read).", 3,
    ),
  },
  {
    corpusVersion: ADDED,
    changeNote: "added in 1.1.0 to widen the corpus",
    slug: "feature-flag-rollback",
    title: "Ship behind a flag",
    prompt:
      "A risky parser rewrite ships Thursday. Describe the flag rollout: default state, ramp steps, kill switch metrics, and what you tell support.",
    kind: "general",
    weight: 2,
    rubric: R3(
      "rollout", "The ramp steps and the default-off start are stated.", 3,
      "kill_switch", "The kill switch names the metrics that flip it (error rate, latency, fallback count).", 3,
      "support", "Support gets a one-line instruction for the degraded path.", 2,
    ),
  },
  {
    corpusVersion: ADDED,
    changeNote: "added in 1.1.0 to widen the corpus",
    slug: "log-pii-scrub",
    title: "Scrub PII from logs",
    prompt:
      "A log line currently prints a full request body that may contain user emails. Write the scrubbing approach at the logging boundary, the config surface, and one test that proves it.",
    kind: "code",
    weight: 2,
    rubric: R(
      "boundary", "The scrub happens in the logger before the sink, not at every call site.", 3,
      "test", "The test asserts a masked value reaches the sink and the original does not.", 3,
    ),
  },
  {
    corpusVersion: ADDED,
    changeNote: "added in 1.1.0 to widen the corpus",
    slug: "idempotent-endpoint",
    title: "Make an endpoint idempotent",
    prompt:
      "A payment-charge endpoint receives the same request twice after a client retry. Design the idempotency: the key, the storage, the response on the second call, and the expiry.",
    kind: "general",
    weight: 3,
    rubric: R3(
      "key", "The idempotency key is caller-supplied and stable across retries.", 3,
      "storage_response", "The stored first result is returned (status and body) on the second call.", 3,
      "expiry", "The key expiry is stated with the reason (retry window vs audit).", 2,
    ),
  },
  {
    corpusVersion: ADDED,
    changeNote: "added in 1.1.0 to widen the corpus",
    slug: "zero-downtime-deploy",
    title: "Deploy without downtime",
    prompt:
      "The service holds long-lived WebSocket connections. Describe the deploy sequence that drains them without dropping users, and the one metric that proves the drain worked.",
    kind: "general",
    weight: 3,
    rubric: R(
      "sequence", "The sequence stops new accepts, drains existing connections, then swaps.", 4,
      "metric", "The proof metric (active connections per version, drain duration) is named.", 2,
    ),
  },
  {
    corpusVersion: ADDED,
    changeNote: "added in 1.1.0 to widen the corpus",
    slug: "dependency-upgrade-risk",
    title: "Assess a dependency upgrade",
    prompt:
      "A patch release of the ORM fixes a memory leak but touches the query builder. Write the upgrade assessment: what you read first, the test you add, and the go/no-go rule.",
    kind: "general",
    weight: 1,
    rubric: R(
      "assessment", "The assessment reads the changelog and the touched code path first.", 3,
      "go_no_go", "The rule is concrete (query plan regression in the smoke test = no-go).", 3,
    ),
  },
  {
    corpusVersion: ADDED,
    changeNote: "added in 1.1.0 to widen the corpus",
    slug: "onboarding-first-week",
    title: "Onboard a new engineer",
    prompt:
      "A new engineer starts Monday. Write the first-week plan: day-one setup, first small PR, and one document they must read before touching the build.",
    kind: "general",
    weight: 1,
    rubric: R(
      "setup", "Day one ends with the app running locally and one command proven.", 3,
      "first_pr", "The first PR is scoped to one file and lands within the week.", 3,
    ),
  },
  {
    corpusVersion: ADDED,
    changeNote: "added in 1.1.0 to widen the corpus",
    slug: "flaky-test-policy",
    title: "Handle a flaky test",
    prompt:
      "A test fails once per 50 runs with a 2-second sleep and no wait condition. Write the fix and the team policy that stops the next one from merging.",
    kind: "general",
    weight: 2,
    rubric: R(
      "fix", "The fix replaces the sleep with a wait on the observable condition.", 3,
      "policy", "The policy blocks merging on observed flakiness (quarantine + ticket).", 3,
    ),
  },
  {
    corpusVersion: ADDED,
    changeNote: "added in 1.1.0 to widen the corpus",
    slug: "secrets-rotation-plan",
    title: "Rotate a leaked secret",
    prompt:
      "A read-only API key was pasted into a public chat channel. Write the rotation runbook: order of steps, what you verify between steps, and the notification content (no secret values).",
    kind: "general",
    weight: 3,
    rubric: R3(
      "order", "The steps rotate-and-deploy before revoking the old key (no window with zero working keys).", 4,
      "verification", "Each step has a verification (new key serves traffic before the old one dies).", 2,
      "notification", "The notification names the field and length, never the value.", 2,
    ),
  },
  {
    corpusVersion: ADDED,
    changeNote: "added in 1.1.0 to widen the corpus",
    slug: "write-observability-plan",
    title: "Instrument a new endpoint",
    prompt:
      "A new endpoint aggregates three backend calls. Write the observability plan: which metrics, one trace, one log line, and the alert you do NOT want.",
    kind: "general",
    weight: 2,
    rubric: R3(
      "metrics", "The metrics cover the three calls and the aggregate (count, latency, failure).", 3,
      "trace_log", "One trace spans the three calls; the log line carries the correlation id.", 2,
      "alert_choice", "The un-wanted alert is named with the reason (noise, no action).", 2,
    ),
  },
];
