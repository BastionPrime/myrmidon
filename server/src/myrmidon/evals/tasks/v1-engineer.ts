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
// changeNote. The initial release is 1.0.0 for the 24 tasks mirrored from the
// Part A seed draft (identical slugs so the same DB rows update in place),
// and 1.1.0 for the 12 tasks this corpus adds on top.

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

const INITIAL = "1.0.0";
const ADDED = "1.1.0";

/**
 * The `engineer` role corpus. Sorted by slug for stable diffs; the loader
 * re-sorts anyway, this order just keeps reviews readable.
 */
export const ENGINEER_TASKS_V1: VersionedReferenceTask[] = [
  // ---- 1.0.0: the 24 tasks mirrored from the Part A seed draft (same slugs,
  // same prompts, same rubrics) so seeding is idempotent on the same rows.
  {
    corpusVersion: INITIAL,
    changeNote: "initial release",
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
    corpusVersion: INITIAL,
    changeNote: "initial release",
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
    corpusVersion: INITIAL,
    changeNote: "initial release",
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
    corpusVersion: INITIAL,
    changeNote: "initial release",
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
    corpusVersion: INITIAL,
    changeNote: "initial release",
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
    corpusVersion: INITIAL,
    changeNote: "initial release",
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
    corpusVersion: INITIAL,
    changeNote: "initial release",
    slug: "plan-migration",
    title: "Plan a zero-downtime column add",
    prompt:
      "Plan adding a NOT NULL column to a 50M-row table used by a live service. List the steps in order and the failure mode each step guards against.",
    kind: "general",
    weight: 2,
    rubric: R(
      "steps", "The steps follow a safe order (add nullable, backfill, tighten) with no lock on the hot path.", 4,
      "failure_modes", "Each step names the failure mode it guards against (lock, partial backfill, deploy skew).", 2,
    ),
  },
  {
    corpusVersion: INITIAL,
    changeNote: "initial release",
    slug: "write-test-boundary",
    title: "Write tests at the boundary",
    prompt:
      "A module has 40 lines of pure logic and 10 lines of I/O. Explain which part you test with unit tests and which with an integration test, and why the split matters here.",
    kind: "general",
    weight: 1,
    rubric: R(
      "split", "The answer puts the pure logic in unit tests and the I/O surface in integration tests.", 3,
      "reasoning", "The answer explains why (speed vs coverage of the real failure mode).", 3,
    ),
  },
  {
    corpusVersion: INITIAL,
    changeNote: "initial release",
    slug: "incident-first-hour",
    title: "Run the first hour of an incident",
    prompt:
      "A production outage started 10 minutes ago; the cause is unknown. Write the first-hour checklist: what you do, in what order, and who you tell at each step.",
    kind: "general",
    weight: 3,
    rubric: R3(
      "order", "The checklist stabilizes first (roll back, feature flag, scale), diagnoses second.", 4,
      "communication", "The checklist names the stakeholders and update cadence (status page, owner, channel).", 3,
      "evidence_preservation", "The checklist preserves logs/metrics before destructive actions.", 3,
    ),
  },
  {
    corpusVersion: INITIAL,
    changeNote: "initial release",
    slug: "api-rate-limit-design",
    title: "Design a rate limiter",
    prompt:
      "Design a rate limiter for a public API: 100 requests per minute per API key, soft limit. Choose the algorithm, say where it lives, and describe the 429 response.",
    kind: "general",
    weight: 2,
    rubric: R(
      "algorithm", "The choice (token bucket / sliding window) fits per-key limits and is justified.", 3,
      "placement", "The limiter sits at the edge (gateway/first middleware), before expensive work.", 3,
    ),
  },
  {
    corpusVersion: INITIAL,
    changeNote: "initial release",
    slug: "read-stack-trace",
    title: "Read a stack trace",
    prompt:
      "A stack trace ends with `TypeError: Cannot read properties of undefined (reading 'items')` at `mapItems (report.ts:58)`, called from `renderReport (report.ts:112)`. Explain how you locate the defect and what the first fix candidate is.",
    kind: "general",
    weight: 1,
    rubric: R(
      "localization", "The answer maps the frame chain to the code and identifies where `undefined` enters.", 3,
      "fix_candidate", "The first fix candidate guards the data source (null check / default), not just the line.", 3,
    ),
  },
  {
    corpusVersion: INITIAL,
    changeNote: "initial release",
    slug: "write-ci-pipeline",
    title: "Write a CI pipeline",
    prompt:
      "Write the CI pipeline YAML sketch for a TypeScript monorepo: install once, typecheck, unit tests, build. Cache what can be cached. Explain one non-obvious line.",
    kind: "code",
    weight: 2,
    rubric: R(
      "correctness", "The pipeline installs once, restores caches and runs the three steps in a valid order.", 4,
      "explanation", "One non-obvious line (cache key, lockfile hash) is explained correctly.", 2,
    ),
  },
  {
    corpusVersion: INITIAL,
    changeNote: "initial release",
    slug: "negotiate-scope-319",
    title: "Push back on scope",
    prompt:
      "A stakeholder asks for \"one small field\" on an export screen; the change touches 4 tables and a migration. Draft the reply: the real cost, a cheaper first version, and a question that clarifies the need.",
    kind: "general",
    weight: 1,
    rubric: R(
      "cost_transparency", "The reply names the true cost (tables, migration, review) without jargon.", 3,
      "alternative", "The reply offers a cheaper first version that still answers the need.", 3,
    ),
  },
  {
    corpusVersion: INITIAL,
    changeNote: "initial release",
    slug: "choose-storage",
    title: "Choose storage for a workload",
    prompt:
      "A workload: 10k writes/sec of 200-byte rows, read by row id, 30-day retention, no transactions across rows. Recommend one storage and justify; name one thing that would change the choice.",
    kind: "general",
    weight: 2,
    rubric: R(
      "recommendation", "The answer picks one concrete store that fits the write volume and access pattern.", 3,
      "tradeoff", "The answer names a condition that would change the recommendation (transactions, queries).", 3,
    ),
  },
  {
    corpusVersion: INITIAL,
    changeNote: "initial release",
    slug: "write-runbook",
    title: "Write an operational runbook",
    prompt:
      "Write the runbook section for \"export service queue backlog grows\" symptom: detect, decide, act, verify. One paragraph per step, written for the on-call engineer at 03:00.",
    kind: "general",
    weight: 2,
    rubric: R3(
      "detect", "The step names the metric and the threshold that triggers the page.", 3,
      "act", "The action list is executable (commands or UI paths), with the safest action first.", 3,
      "verify", "The verification step states what returns to normal and what to watch next.", 2,
    ),
  },
  {
    corpusVersion: INITIAL,
    changeNote: "initial release",
    slug: "refactor-guard",
    title: "Refactor under a guard",
    prompt:
      "You must rename a function used in 60 files with no full test coverage. Describe the refactor procedure that makes it safe, step by step.",
    kind: "general",
    weight: 2,
    rubric: R(
      "safety_net", "The procedure builds a safety net first (compiler flags, codemod tests, grep) before mass edit.", 3,
      "procedure", "The steps are ordered: mechanical rename, compile, narrow test, commit.", 3,
    ),
  },
  {
    corpusVersion: INITIAL,
    changeNote: "initial release",
    slug: "explain-failure-domain",
    title: "Explain a failure domain",
    prompt:
      "Service A calls service B; B calls the database. The database restarts every night at 03:00. Explain what A's users see during the restart for three designs: no timeout, timeout with no retry, timeout with retry.",
    kind: "general",
    weight: 2,
    rubric: R(
      "correctness", "The answer maps each design to the user-visible outcome (hang, error, recovered).", 4,
      "clarity", "The three cases are separated and labeled.", 2,
    ),
  },
  {
    corpusVersion: INITIAL,
    changeNote: "initial release",
    slug: "write-error-message",
    title: "Write an error message",
    prompt:
      "A user pastes `export-failed-2173` into support chat. Rewrite the error as a user-facing message and the matching log line. State where the id comes from.",
    kind: "general",
    weight: 1,
    rubric: R(
      "user_message", "The user message names what failed and one actionable next step, without internals.", 3,
      "log_line", "The log line carries the id and enough context to locate the failure.", 3,
    ),
  },
  {
    corpusVersion: INITIAL,
    changeNote: "initial release",
    slug: "plan-rollback",
    title: "Plan the rollback before the release",
    prompt:
      "The change adds a cache layer in front of the database. Write the rollback plan: trigger conditions, steps, and what cannot be rolled back.",
    kind: "general",
    weight: 2,
    rubric: R3(
      "triggers", "The plan defines measurable rollback triggers (error rate, latency), not feelings.", 3,
      "steps", "The rollback steps are ordered and include cache invalidation.", 3,
      "limits", "The plan names what a rollback cannot undo (cache misses, TTL effects).", 2,
    ),
  },
  {
    corpusVersion: INITIAL,
    changeNote: "initial release",
    slug: "review-own-diff",
    title: "Review your own diff",
    prompt:
      "Your diff: 300 lines across 6 files, one new env var, one deleted test. List the self-review checks in the order you run them, and say why the deleted test matters.",
    kind: "general",
    weight: 1,
    rubric: R(
      "checks", "The checklist covers behavior, contracts, config and the deleted-test rationale.", 3,
      "order", "The order starts with the riskiest change (the deleted test / new env var).", 3,
    ),
  },
  {
    corpusVersion: INITIAL,
    changeNote: "initial release",
    slug: "estimate-task",
    title: "Estimate a task",
    prompt:
      "The task: \"add PDF export to the report screen\". The report uses a table component; PDF rendering is new to the codebase. Give the estimate with a range, the assumption list, and the first unknown to resolve.",
    kind: "general",
    weight: 1,
    rubric: R(
      "range", "The estimate is a range, not a single number, and the unit is stated.", 3,
      "assumptions", "The assumptions and the first unknown are concrete and checkable.", 3,
    ),
  },
  {
    corpusVersion: INITIAL,
    changeNote: "initial release",
    slug: "write-regex-safely",
    title: "Write a safe regex",
    prompt:
      "Write a regex that matches a version string like `v1.2.3` or `1.2.3-rc.4` and extracts the three numbers. Explain the failure mode the pattern avoids.",
    kind: "code",
    weight: 1,
    rubric: R(
      "correctness", "The pattern matches both forms and captures the numbers.", 4,
      "safety", "The explanation names the failure mode avoided (catastrophic backtracking / partial match).", 2,
    ),
  },
  {
    corpusVersion: INITIAL,
    changeNote: "initial release",
    slug: "postmortem-blameless",
    title: "Write a blameless postmortem",
    prompt:
      "A deploy script ran a destructive command against production; the operator typed the id from the wrong ticket. Write the postmortem outline: timeline, contributing factors, action items. One line on why the person is not the cause.",
    kind: "general",
    weight: 2,
    rubric: R(
      "structure", "The outline has timeline, contributing factors and dated action items.", 3,
      "blameless", "The answer reframes the person as a trigger in a system with no guard.", 3,
    ),
  },
  {
    corpusVersion: INITIAL,
    changeNote: "initial release",
    slug: "concurrency-bug",
    title: "Diagnose a concurrency bug",
    prompt:
      "Two workers process the same queue item occasionally. The code checks `SELECT ... WHERE status='new'` then updates to 'processing' in a second statement. Explain the race and give the minimal fix.",
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
