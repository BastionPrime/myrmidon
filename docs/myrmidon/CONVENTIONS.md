# How we work on Myrmidon

> Russian version: [CONVENTIONS.ru.md](CONVENTIONS.ru.md)

These rules apply to every session and every person. If a track contradicts this file, this
file wins.
If something is described neither here nor in the track, make a reasonable decision and record
it in the PR under "Decisions without the owner".

## 1. The essentials in short

1. Into `main` — only through a PR. Direct push and force push to `main` are forbidden by the
   repository rule.
2. One topic — one branch — one small PR.
3. Every change comes with a test that is red without the change. typecheck and vitest are
   mandatory before a PR.
4. Every change to vendor code — a row in [DIVERGENCE.md](DIVERGENCE.md).
5. The public repository contains no secrets and no internal addresses of ours (section 9).
6. `itkadr-git/myrmidon-deploy` is read-only. The source of truth about our patches is
   `patches/<directory>/README.md` (section 10).
7. A track touches only its own files. Shared files follow the rules of section 12.
8. We send nothing to the vendor: no PRs, no issues, no comments in `paperclipai/paperclip`.

## 2. Repositories

| Repository | What is in it | Session access |
|---|---|---|
| `itkadr-git/myrmidon` (public) | The product code: vendor history up to `v2026.916.1` plus our changes. Project documents are in `docs/myrmidon/` | Working: `claude/*` branches, PRs, merging our own PRs |
| `itkadr-git/myrmidon-deploy` (private) | Our patches with descriptions, transfer materials, everything about our deployment | Read-only |
| `paperclipai/paperclip` (vendor) | The code origin | Read-only (fetch) |

**The maintainer** is the one who runs the Myrmidon deployment and decides project questions
outside sessions. He sets up the repository and CI, creates routines and tokens, verifies
releases on the staging and rolls them out.

## 3. Branches

- Branch name: `claude/t<N>-<topic>` in Latin letters with hyphens, for example
  `claude/t2-p1-leases`, `claude/t1-ci-base`.
- A branch is created from a fresh `main`. After the PR is merged, the next topic branches
  from a fresh `main` again.
- If the platform assigned the session its own branch name and does not allow pushing to
  another one, work in the assigned branch. Topics then go in turn: merge the PR, rebuild the
  branch from a fresh `main`, take the next topic.
- `sync/<tag>` branches are only for vendor release transfers (R2). Track sessions do not
  create them.

## 4. Commits

- Commit messages are in English, in the vendor style: `fix(heartbeat): release environment
  leases on cancel`.
- Transferring someone else's vendor commit — only `git cherry-pick -x <sha>`, so that the
  message keeps the line `(cherry picked from commit …)`.
- Commits contain no numbers of our board tasks, no names of our agents and servers.

## 5. Pull request

- Small, one topic. If a PR has grown beyond ~600 lines of changes excluding tests and
  generated files, split it.
- The title is in English, with the feature number and the track: `P1: release environment
  leases on cancel and pause (T2)`. On a squash merge the title becomes the commit message.
- The description is in English, following the template:

```markdown
## What
One to three bullets: what changes in behavior.

## Why
What problem it solves, the feature number (P1…), the board task or the vendor PR, if any.

## How it was verified
- Watchdog test: <path>. Output on the code without the change (red) and with the change (green) — log tails.
- typecheck: <command> — ok.
- Other: <what else was run>.

## Divergence registry
Row in DIVERGENCE.md, section "Track N": added / changed.

## Settings
New MYRMIDON_* variables (or "none"); row in SETTINGS.md.

## DB migrations
Additive only: a new table, column or index; the number is the next free one after the
vendor migrations. Rollback restores the image but not the database — the old image must
work on the new schema.
Otherwise — "none".

## Risks and what to check on the staging
What can break and what operations should check on a live installation.

## Decisions without the owner
What you decided yourself and why (or "none").
```

- Release notes (GitHub Release) are in English.
- The vendor template (`.github/PULL_REQUEST_TEMPLATE.md`, section 10 of `AGENTS.md`) is not
  mandatory for our PRs: we use the template above.

## 6. Merging

A session merges its own PR when everything is done:

1. Tests are green. Until there is CI (track 1 builds it), tests are run in the session and
   their output is attached to the PR. Once CI exists, all its checks must be green.
2. The branch is updated from a fresh `main` (rebase and `push --force-with-lease` to your own
   branch; if the platform does not allow force push — merge `main` into the branch). After
   the update, tests are run again.
3. No conflicts.
4. The rows in DIVERGENCE.md and SETTINGS.md are in place.
5. The self-check for secrets and internal addresses has passed (section 9).
6. The PR touches only its own track's files or shared files under the rules of section 12.
7. A DB migration, if the PR has one, is additive, and its number is verified against the
   vendor migrations. Rollback restores the image but not the database: the old image must
   work on the new schema.

CI has two levels (details in [ci.md](ci.md)):

- Merging requires the fast CI level (`CI result` on the PR); the full level runs on `main`.
  A red `main` (an issue with the label `main-red`) is fixed by the track whose PR broke it;
- the embedded postgres does not start as root: run the server tests in the session as a
  regular user, otherwise they are silently skipped.

Merge method:

- our PRs — **squash**. For a PR with transferred vendor commits, the squash commit message
  keeps the lines `cherry picked from commit …`;
- a vendor release transfer PR (`sync/*`) — **only a merge commit**. Squashing such a PR
  severs the link to the vendor history, and every next transfer turns into solid conflicts.

Do not merge other people's PRs. Leave your own PR that is blocked by someone's unfinished
work open and note it in the report.

### Review of key files (owner decision of 28.09.2026)

A PR that touches key files of the core is merged only after a review. The list of files is in
`.github/workflows/myrmidon-hot-files-review.yml` (wakes and continuations, the tool gateway,
masking, the run context, tasks, chats, the hermes adapter, the DB, the deploy scripts, the
Dockerfile, workflows). All actions in the repository come from one account, GitHub approval
does not work here, so the review is recorded with the `review-approved` label: it is set by
the reviewer role (a model of a different family than the author's) or by the maintainer —
after reading the diff and checking that the test is red without the change. A new push drops
the label, the review is done again. The `hot files review` check is mandatory.

## 7. Tests

- **For every code change — a vitest test that is red without it.** The proof is in the PR:
  a run of the test on the code without the change (for example, `git stash` of the untested
  part or the sources from `main`) and with the change. For our scripts, `node:test` instead
  of vitest (below). For CI changes, the proof is a link to a red run in a draft PR with a
  deliberate error.
- **typecheck is mandatory:** `pnpm -r typecheck` or, better, `pnpm --filter <package>
  typecheck` for the affected packages.
- Narrow run: `pnpm exec vitest run <test path>`. A full `pnpm test:run` — before the last PR
  of the step, if time allows.
- Our tests live in separate files `<module>.myrmidon.test.ts` next to the vendor ones. We
  edit vendor test files only when we change the behavior they check. The change is minimal
  and listed in DIVERGENCE.md.
- Tests of our scripts (`scripts/myrmidon/**`) use the built-in `node:test`, files
  `*.test.mjs`. Track 1 CI runs them as a separate check: `node --test` over
  `scripts/myrmidon/`.
- No live network and no keys in tests. Embedded postgres (as the vendor has) is allowed.
- Test names and data are in English and neutral: `agent-a`, `company-a`, `example.com`,
  addresses from `192.0.2.0/24`.

## 8. How we change vendor code

The goal is for the weekly vendor transfer to pass with a minimum of conflicts.

- **Minimal footprint.** New logic lives in new files: `server/src/myrmidon/<topic>/…`,
  `packages/<package>/src/myrmidon-<topic>.ts`, `ui/src/components/myrmidon/…`. In a vendor
  file — only the call site.
- **A mark on every change in a vendor file** — a comment `// myrmidon(<ID>): <why, in
  English>`, for example `// myrmidon(P1): release leases before promotion`. The transfer bot
  finds our pieces by this mark.
- **Comments, logs and error texts are in English.** No numbers of our board tasks, no names
  of agents, companies and servers.
- **Settings** are environment variables `MYRMIDON_<AREA>_<NAME>`, read in the feature module.
  We do not touch `server/src/config.ts` (the exception is track 1, telemetry). Default
  values:
  - a defect fix is enabled;
  - values tailored to our deployment (windows, limits, addresses) are disabled or neutral.

  Our production values live in `myrmidon-deploy`. Every setting is a row in
  [SETTINGS.md](SETTINGS.md).
- **New APIs** go under `/api/myrmidon/…`, so as not to collide with future vendor paths.
- **DB migrations are additive only.** We add a table, a column or an index; deletion,
  renaming, type change and data rewriting are forbidden. The reason is rollback:
  `rollback.sh` restores the image but not the database, so the old image must work on the new
  schema. Vendor migration numbers grow every week: we take the next free number and check it
  again before merging; duplicate numbers are caught by `check:migrations`. We generate a
  migration with the stock `pnpm --filter @paperclipai/db generate`: a handwritten schema
  snapshot breaks the next migration. We still prefer to store state in the existing JSON
  fields: `instance_settings.general`, `adapterConfig`, `metadata`. A non-additive migration —
  stop the step, describe it in the PR and in the report; the decision is the maintainer's.
- **Dependencies** are not added without need. If a new dependency is unavoidable — a
  justification in the PR, a license from the allowed list (track 1), `pnpm-lock.yaml` is
  updated only by `pnpm install`.
- We do not change the names of packages, the CLI and the `PAPERCLIP_*` variables.
- A change to a vendor package from `node_modules` is made through the vendor mechanism
  `pnpm.patchedDependencies` (`patches/*.patch`). Substituting files is unacceptable.
- We do not add media tools to the image: ffmpeg, yt-dlp, generators. That is a separate
  service outside the fork.

## 9. Openness: what must not be in the public repository

**Forbidden** in code, tests, documents, commits and PR descriptions:

- secrets: tokens, keys, passwords, connection strings, certificates and private keys;
- our addresses: domains, IPs (including private networks), ports of our services;
- names of our hosts and paths on our servers;
- names of our companies, agents, bots and people;
- numbers of our board tasks, run, agent and company identifiers, chat ids;
- our gateway model list.

**Allowed:**

- the placeholders `example.com`, `192.0.2.0/24`, `198.51.100.0/24`, `localhost`, `127.0.0.1`;
- names of patch directories and files from `myrmidon-deploy` in the `docs/myrmidon/`
  documents (for example, `P1-ope2544-heartbeat-lease`). They must not appear in code, tests
  and commits.

**Self-check before a PR** — review your diff for matches:

```sh
git diff origin/main...HEAD | grep -nEi \
  '(password|passwd|secret|token|api[_-]?key)\s*[:=]|BEGIN [A-Z ]*PRIVATE KEY|\b10\.[0-9]+\.[0-9]+\.[0-9]+\b|\b172\.(1[6-9]|2[0-9]|3[01])\.[0-9]+\.[0-9]+\b|\b192\.168\.[0-9]+\.[0-9]+\b'
```

Examine every match. If `myrmidon-deploy` has a file with a list of forbidden patterns, run
the diff through it as well. Track 1 will add such a check to CI.

If a secret or an internal address is already in the public repository, do not fix it with a
quiet commit: it will not disappear from the history. Immediately write about it in the report
marked "urgent".

## 10. The private repository `myrmidon-deploy`

- Read only. Do not push, do not open PRs there. If a patch README is wrong or incomplete,
  write about it in the report.
- `patches/<directory>/README.md` is the **source of truth** about the patch: what it does,
  why, how it was verified, when to remove it. Next to it are:
  - the diff against vendor 2026.916.1: the built JS (`*-dist.patch`) and, where present, the
    TS source (`*-src.patch`);
  - our files (`ours/`) and the vendor originals (`vendor/`);
  - tests (`tests/`) and reference materials (`ref/`).
- Files from there are **not copied as is**: they contain Russian comments, our task numbers,
  internal addresses. We transfer the logic, write the code in TypeScript on top of the
  current `main`, with English comments and neutral test data.
- A change that exists only in the built JS is rewritten in the `*.ts` source. We do not put
  `dist` files into the repository.
- If something the track promises is missing in `myrmidon-deploy`, do not invent it. Build it
  from the track description and note it in the report.

Patch directories as of 27.09.2026 (the exact list is `ls patches/`):

| Feature | Directory in `myrmidon-deploy/patches/` | Track |
|---|---|---|
| P1 | `P1-ope2544-heartbeat-lease` | 2 |
| P2 | `P2-ope2365-card-addressee-wake` | 2 |
| P3 | `P3-ope2313-continuation-cap` | 2 (the hermes part — 3) |
| P4 | `P4-ope2469-hermes-execute` | 3 |
| P5 | `P5-ope2317-checkout-fail-fast` | 3 |
| P6 | `P6-ope2422-github-broker` | 3 |
| P7 | `P7-ope2583-telegram-omission` | 4 |
| P7b | `P7b-chat-synthetic-id` (including vendor commit #13654) | 4 |
| P8 | `P8-ope2579-telegram-2gb` | 4 |
| P9 | `P9-ope2732-tool-gateway` (`v1` — the live version, `v2` — the "do not drop the connection" candidate) | 3 |
| P10 | `P10-ope310-sse-405` | 3 |
| P11 | `P11-ope2847-db-backup-catchup` | 2 |
| Telemetry | `T1-telemetry-off` | 1 |

S2, S4, S5, M1, H1, H4, X2, R1–R4 have no patches: that is new work per the track description.

## 11. Vendor commits that are not in our base

1. Take them from the vendor's public repository:
   `git fetch https://github.com/paperclipai/paperclip.git <sha or refs/pull/<N>/head>`.
2. If the session network does not allow that, use the `*.patch` file from `myrmidon-deploy`
   via `git am`: for commits that do not apply to `v2026.916.1` as is, there are versions
   transferred onto the tag (`*-rebased-on-916.1.patch`, they already contain the line
   `(cherry picked from commit …)`). `git am -3` does not help here: the fork history has no
   original vendor master objects. If after `git am` the commit message has no line
   `(cherry picked from commit <full sha>)` — add it (`git commit --amend`).
3. If neither is available, note it in the report and move to the next step.
4. The transfer is `git cherry-pick -x`. In DIVERGENCE.md the ID is `vendor:<short sha>`, in
   the "How to remove" field: "goes away by itself on the transfer of the vendor tag that
   contains this commit".

## 12. File map and track intersections

A track changes only the files of its list (the "Track files" section in `tracks/N.md`). If a
change in someone else's file is needed, first find a way to get by with a new file. If that
fails — the change is minimal (one call site with the `myrmidon(<ID>)` mark), and it is
described in the PR.

**Unavoidable intersections:**

| File | Tracks | Who is first |
|---|---|---|
| `packages/adapters/hermes/src/server/execute.ts` | 2 (vendor #13891, 4 lines; X2 — only if needed), 3 (P4, the main transfer), 4 (H1 — only if a call site is needed), 6 (S2, M1) | 2 → 3 → 4 and 6 (and 2 for X2). After P4 is merged, other tracks only add call sites here |
| `packages/adapters/{claude,codex,cursor,gemini,grok,kimi,opencode,pi}-local/src/server/execute.ts` | 2 (vendor #13891), 4 (H4, stdin), 6 (S2, environment) | 2 first, then 4 and 6 in any order |
| `packages/adapter-utils/src/server-utils.ts` | 2 (vendor #13891). 4 and 6 — only if there is no other way | 2 first; 4 and 6 put their code into new files |
| `packages/adapters/hermes/src/server/config-schema.ts` | 3 (P4 — only if it moves the patch fields into the form), 6 (M1, model fields) | 3 → 6 |
| `packages/adapter-utils/src/execution-target.ts` | 2 (vendor #13793), 6 (S2, call sites) | 2 → 6 |
| `server/src/routes/openapi.ts` | 2 (P11, the health response schema), 4 (vendor #13654), 5 (if it registers its API) | 4 → 5; 2 — in any order with them, rebase |
| `server/src/services/heartbeat.ts` | 2 (P1), 3 (P9, run connection selection), 5 (R3, call sites), 6 (S5, a call site) | 2 and 3 in any order; 5 and 6 — after them where possible |
| `server/src/modules/run-dispatch/**` | 2 (P2), 5 (R3, a call site) | 2 → 5 |
| `server/src/index.ts`, `server/src/routes/health.ts` | 2 (P11), 5 (R3) | In any order |
| `server/src/services/issues.ts`, `server/src/routes/issues.ts` | 3 (P5), 6 (S5, a call site) | 3 → 6 |
| `server/src/services/chat-channels.ts` | 4 (P7), 6 (S5, a call site) | 4 → 6 |
| `pnpm-lock.yaml` | 4 (P8). Others — only for a forced new dependency | 4 |
| `package.json` at the root | 1 (scripts) | 1. Other tracks do not touch it: they run their scripts directly (`node scripts/myrmidon/…`) |
| `.github/workflows/**` | 1 | 1. If a track needs a new CI check, it writes about it in the report |
| `docs/myrmidon/DIVERGENCE.md`, `docs/myrmidon/SETTINGS.md` | All | Each track writes only in its own section |
| `docs/myrmidon/tracks/N.md` | Only track N, the "State" section | — |

**The rule:** whoever merged first is right. The rest update their branch from a fresh `main`
and resolve the conflict on their side, keeping the other change. Do not throw away someone
else's code while resolving a conflict. If it is unclear how to combine them, stop this step,
describe it in the PR and in the report, move to the next one.

Sessions do not edit `README.md`, `ROADMAP.md`, `CONVENTIONS.md` and `SESSION-PROMPTS.md` in
`docs/myrmidon/`. Proposals for them go into the report.

## 13. Working in a cloud session

- **Start:** `node -v` (24.x required, not lower than 24.11). If pnpm is the wrong version:
  `corepack enable && corepack prepare pnpm@9.15.4 --activate`. Then
  `pnpm install --frozen-lockfile`.
- **Long commands** (over 2 minutes) are run in the background with output to a file, and the
  file is checked. Do not run the full test suite without need: the spend limit is shared
  across all sessions.
- **Do not build the image locally:** the session disk is not enough. CI builds the image.
- **There are no secrets in the session,** and there is no need to ask for them. Tests must
  not require live keys.
- **Questions.** Do not wait for an answer. Decide yourself within these documents and record
  the decision in the PR. If the decision is irreversible or goes beyond the track, skip the
  step, move to the next one, and put the question in the report.
- **Report:**
  - in every PR — the description per the template;
  - in the last PR of each step — an updated "State" section in your `tracks/N.md`;
  - at the end of the work — a final message in the session: the list of PRs (merged / open),
    which readiness criteria are met, what is postponed and why, what operations should check
    on a live installation, open questions.

## 14. The vendor's `AGENTS.md`

The code rules from `AGENTS.md` apply:

- section 5, items 1–4 and 7;
- section 6 — the schema change procedure and the migration generation, with our restriction
  "additive migrations only" (section 8 of this file);
- sections 7–9;
- section 11, except the PR template requirement;
- the `DESIGN.md` design system and `pnpm check:token-gates` for changes in `ui/`.

Do not apply:

- section 5, items 5–6 — plans and artifacts in Paperclip tasks;
- section 10 — the vendor PR template, we have our own (section 5 of this file).
