# Reference-task evals: the LLM judge and the threshold+repeat verdict (1.6 EVALS-A)

> Russian version: [reference-task-evals.ru.md](reference-task-evals.ru.md)

Changing a skill, a model or a role's instructions used to be a guess: nothing
measured whether the role got better or worse, and promotion relied on
eyeballing. The evals path makes the question computable: a seeded corpus of
neutral reference tasks for the pilot role, an LLM judge behind the company's
LLM gateway, scores stored per run, and a promote / confirm / regress verdict
where a drop beyond the threshold is only actionable after a confirmation run
repeats it.

The module lives in `server/src/myrmidon/evals/` (the 1.6 EVALS-A path). The
judge is one chat-completions call per task, on a free DashScope model by
default (the 1.6 wave rule: paid models are a deploy-repo concern). The judge
never executes code: for `code` tasks the CI pass rate arrives as a request
parameter and is folded into the score as a separate line, not measured here.

The judge contour mirrors the [OCR path](ocr.md): an OpenAI-compatible gateway
address plus the **name** of the company secret holding the key — the value
never appears in a setting, log or journal. All settings
(`MYRMIDON_EVALS_*`) are in [../SETTINGS.md](../SETTINGS.md). While the
contour is not configured, reads still work and mutations answer `503` with
the names of the missing settings.

## The API

The board API under `/api/myrmidon/companies/:companyId/evals`:

| Route | Who | What it does |
|---|---|---|
| `GET /tasks?role` | company read | Lists the reference tasks for the role (default `engineer`): `slug`, `title`, `prompt`, `kind`, `weight`, `rubric` |
| `POST /seed` | board only | Seeds the neutral corpus for the role (default `engineer`); idempotent on `(companyId, role, slug)` — a re-run updates prompt/rubric/weight in place, it never duplicates rows. Answer: `{role, inserted, updated}` |
| `POST /runs` | board only | Scores one run of one subject (see below) |
| `POST /runs/:runId/confirm` | board only | The confirmation run for a run that crossed the threshold |
| `POST /verdict` | board only | The lifecycle answer "promote this candidate or not" for a subject against its baseline |
| `GET /runs?role&limit` | company read | Lists the runs, newest first (`limit` defaults to 50) |
| `GET /runs/:runId` | company read | Reads one run back with its scores |

Reads need company access; the three run mutations need a board actor (they
spend real gateway calls — an agent actor gets `403`).

## What a run is

A run scores one **subject** — a skill version, an agent config, a draft — on
every reference task of the role:

1. **Seed the corpus first.** `POST /seed` writes the 24 neutral reference
   tasks for the pilot role `engineer` (general and code tasks, each with a
   two-criterion rubric; weights 1 = routine, 2 = consequential). Without
   seeded tasks a run answers `502` with `no reference tasks for role "<role>"`.
2. **Collect the answers.** The subject's answer text per task slug arrives in
   the `answers` object of `POST /runs`. Missing slugs score zero — the
   threshold then catches it. For `code` tasks pass `ciPassRate` (0–100): the
   CI pass rate is folded into the aggregate as one extra score line worth
   `ciPassRate`% of the task's rubric points, not as judge points.
3. **Judge.** One chat-completions call per task, temperature 0, a strict JSON
   answer `{"criteria": {"<name>": <points>}}`. The judge awards 0 to the
   criterion's full points per criterion. An unparseable response yields zero
   points for the task and a `parseError` flag — a flaky judge degrades the
   run visibly instead of inventing scores.
4. **Aggregate.** Per task: `rawScore` (points awarded) × `weight`; the run's
   `scorePercent` is `totalScore / maxScore × 100` with one decimal. Every
   run stores its full scores, the judge model id and the CI pass rate in
   `myrmidon_eval_runs`.

Set `baselineRunId` on a candidate run to compare against a baseline run of
the same role (a run without `baselineRunId` is a baseline run: no comparison,
verdict null).

## The verdict: threshold + repeat

A single bad run is not a verdict. The default tolerance is 5 percentage
points (overridable per run with `thresholdDrop`, 0–100); `dropPercent` is
baseline minus candidate, rounded to one decimal.

| Verdict | When | What it means |
|---|---|---|
| `promote` | no baseline, or the drop is within the threshold | the candidate may be promoted |
| `confirm` | a first run crossed the threshold | regression suspected — a confirmation run is required before anything is rolled back; the response carries `needsConfirm: true` |
| `regress` | the confirmation run crossed the threshold again | regression confirmed — do not promote, roll back |
| `error` | a confirmation run lost its baseline | no comparison possible |

A first crossing only *suspects*: it stays `confirm` until
`POST /runs/:runId/confirm` re-runs the same subject. The confirmation call
must carry the answers again in the body (`answers`, task slug → text) —
answers are not persisted with the run, and without them the route answers
`400` instead of silently scoring zero. When the repeat run lands within the
threshold, the suspicion did not repeat: the confirmation run itself ends
`promote` with the reason
"suspected regression did not repeat", and the candidate is retried from a
fresh run.

The verdict the skill lifecycle calls is `POST /verdict`
(`{role, subject, baselineRunId, thresholdDrop?}`): it takes the subject's
latest completed *first* run (a confirmation run is a re-run of the same
candidate, not a new one), plus its confirmation run if one exists, and
answers `{promote, reason, scores}`. This is the frozen seam the skill
lifecycle (`candidate → verified → deprecated`, with rollback) is designed to
call; the merged lifecycle module (1.6) does not wire it to the board yet, so
today the seam is exercised through this API.

## The journal

Every mutation writes one activity row by the system actor `myrmidon-evals`:
`evals.seeded` (role, inserted/updated), `evals.run_completed`
(role, subject, verdict, scorePercent, needsConfirm) and `evals.run_confirmed`
(role, subject, verdict, scorePercent). Answers are not persisted — only the
awarded points per criterion and the run aggregate live in `eval_runs.scores`
— the journal never sees them either.

## Langfuse export (optional, off by default)

Scores are always written locally to `myrmidon_eval_runs`. Set
`MYRMIDON_EVALS_LANGFUSE=true` plus a Langfuse ingestion base URL and public
key to also export each run's aggregate: one POST per run with a
`trace-create` event (`eval-run:<role>`) and a `score-create` event
(`eval-score-percent`, the verdict in the comment). Export failures never
fail the run — Langfuse is observability, not a gate.

## Related

- [../SETTINGS.md](../SETTINGS.md) — every `MYRMIDON_EVALS_*` variable
  (gateway address, key secret name, model, timeout, the Langfuse contour).
- [ocr.md](ocr.md) — the same gateway contour shape used by the OCR path.
