# How we work on Myrmidon

> Русская версия: [CONVENTIONS.ru.md](CONVENTIONS.ru.md)

These rules apply to every session and every person. If a track contradicts this file, this
file wins. If something is covered neither here nor in the track, make a reasonable call and
record it in the PR under "Decisions without the owner".

## 1. The essentials

1. `main` only through a PR. Direct pushes and force pushes to `main` are forbidden by
   repository rule.
2. One topic — one branch — one small PR.
3. Every logic change comes with a test that fails without the change. Typecheck and vitest
   are mandatory before a PR. There is no "no new tests" rule (section 16).
4. Every change to vendor code is a line in [DIVERGENCE.md](DIVERGENCE.md).
5. The public repository contains no secrets and none of our internal addresses (section 9).
6. `itkadr-git/myrmidon-deploy` is read-only. The source of truth for our patches is
   `patches/<directory>/README.md` (section 10).
7. A track touches only its own files. Shared files follow the rules of section 12.
8. We send nothing to the vendor: no PRs, no issues, no comments in `paperclipai/paperclip`.

## 2. Repositories

| Repository | Contents | Session access |
|---|---|---|
| `itkadr-git/myrmidon` (public) | Product code: vendor history up to `v2026.916.1` plus our changes. Project documents live in `docs/myrmidon/` | Working: `claude/*` branches, PRs, merging own PRs |
| `itkadr-git/myrmidon-deploy` (private) | Our patches with descriptions, porting materials, everything about our deployment | Read-only |
| `paperclipai/paperclip` (vendor) | Code origin | Read-only (fetch) |

The **maintainer** runs the Myrmidon deployment and decides project questions outside
sessions. They set up the repository and CI, create routines and tokens, verify releases on
the staging installation and roll them out.

## 3. Branches

- Branch name: `claude/t<N>-<topic>` in lowercase Latin with hyphens, e.g.
  `claude/t2-p1-leases`, `claude/t1-ci-base`.
- A branch starts from fresh `main`. After a PR is merged, the next topic branches from fresh
  `main` again.
- If the platform has issued the session its own branch name and refuses pushes to any other,
  work in the issued branch. Topics then go one at a time: merge the PR, re-create the branch
  from fresh `main`, take the next topic.
- `sync/<tag>` branches exist only for vendor release ports (R2). Track sessions do not
  create them.

## 4. Commits

- Commit messages in English, in the vendor's style: `fix(heartbeat): release environment
  leases on cancel`.
- Porting someone else's vendor commit — only `git cherry-pick -x <sha>`, so the message
  keeps the line `(cherry picked from commit …)`.
- Commits contain no numbers of our board tasks and no names of our agents or servers.

## 5. Pull requests

- Small, one topic. If a PR grows beyond ~600 changed lines excluding tests and generated
  code, split it.
- Title in English, with the feature number and the track: `P1: release environment leases on
  cancel and pause (T2)`. On a squash merge the title becomes the commit message.
- Description in Russian, following the template:

```markdown
## Что
Одним-тремя пунктами: что меняется в поведении.

## Зачем
Какую проблему решает, номер функции (P1…), задача или PR вендора, если есть.

## Как проверено
- Тест-сторож: <путь>. Вывод на коде без правки (красный) и с правкой (зелёный) — хвосты логов.
- typecheck: <команда> — ок.
- Прочее: <что ещё запускалось>.

## Реестр отличий
Строка в DIVERGENCE.md, раздел «Трек N»: добавлена / изменена.

## Настройки
Новые переменные MYRMIDON_* (или «нет»); строка в SETTINGS.md.

## Миграции БД
Только аддитивные: новая таблица, столбец или индекс; номер — следующий свободный после миграций
вендора. Откат возвращает образ, но не базу — старый образ должен работать на новой схеме.
Иначе — «нет».

## Риски и что проверить на стенде
Что может сломаться и что эксплуатации проверить на живой установке.

## Решения без владельца
Что решил сам и почему (или «нет»).
```

- The vendor template (`.github/PULL_REQUEST_TEMPLATE.md`, section 10 of `AGENTS.md`) is not
  required for our PRs: use the template above.

## 6. Merging

A session merges its own PR when everything below holds:

1. **A PR goes to review only with green CI.** Run the tests locally before pushing; the
   reviewer returns a red PR without reviewing it (section 16). CI exists and runs (see
   [ci.md](ci.md)): every PR-level check must be green.
2. The branch is updated from fresh `main` (rebase and `push --force-with-lease` to your own
   branch; if the platform forbids force pushes, merge `main` into the branch). After the
   update the tests are run again.
3. No conflicts.
4. The lines in DIVERGENCE.md and SETTINGS.md are in place.
5. The self-check for secrets and internal addresses has passed (section 9).
6. The PR touches only files of its own track, or shared files under the rules of section 12.
7. A database migration in the PR is additive, and its number is checked against vendor
   migrations. Rollback restores the image, not the database: the old image must keep working
   on the new schema.

CI has two levels (details in [ci.md](ci.md)):

- Merging requires the fast CI level (the `CI result` check on the PR); the full level runs
  on `main`. A red `main` (an issue labelled `main-red`) is fixed by the track whose PR broke
  it;
- embedded postgres does not start as root: run server-side tests in a session as a regular
  user, otherwise they are silently skipped.

Merge method:

- our PRs — **squash**. For PRs with ported vendor commits the squash message keeps the
  `cherry picked from commit …` lines;
- vendor release port PRs (`sync/*`) — **merge commit only**. Squashing such a PR severs the
  link to vendor history, and every next port turns into solid conflicts.

Do not merge other people's PRs. Leave your own PR that is blocked by someone else's
unfinished work open and note it in the report.

### Review of key files (owner's decision 28.09.2026)

A PR that touches key core files is merged only after review. The file list lives in
`.github/workflows/myrmidon-hot-files-review.yml` (wake-ups and continuations, the tool
gateway, masking, run context, tasks, chats, the hermes adapter, the DB, deploy scripts,
Dockerfile, workflows). All repository actions run under a single account, so GitHub approval
does not work here; instead review is recorded with the `review-approved` label, set by the
reviewer role (adm-dev-review, a model of a different family than the author's) or by the
maintainer — after reading the diff and checking that the test fails without the change. A
new push drops the label and the review starts over. The required check is `hot files
review`.

## 7. Tests

- **Every code change gets a vitest test that fails without it.** Proof goes in the PR: a run
  of the test on the code without the change (for example, `git stash` of the untested part,
  or sources from `main`) and with the change. For our scripts, `node:test` replaces vitest
  (below). For CI changes the proof is a link to a red run in a draft PR with a deliberate
  error.
- **Typecheck is mandatory:** `pnpm -r typecheck`, or at least `pnpm --filter <package>
  typecheck` for the touched packages.
- Narrow run: `pnpm exec vitest run <test path>`. Full `pnpm test:run` — before the last PR
  of a step, time permitting.
- Our tests live in separate `<module>.myrmidon.test.ts` files next to the vendor ones. We
  edit vendor test files only when we change the behavior they verify. Such an edit is
  minimal and is recorded in DIVERGENCE.md.
- Tests of our scripts (`scripts/myrmidon/**`) use the built-in `node:test`, in `*.test.mjs`
  files. Track 1 CI runs them as a separate check: `node --test` over `scripts/myrmidon/`.
- No live network and no keys in tests. Embedded postgres (as the vendor does) is allowed.
- Test names and test data are in English and neutral: `agent-a`, `company-a`,
  `example.com`, addresses from `192.0.2.0/24`.

## 8. How we change vendor code

The goal is to keep the weekly vendor port as conflict-free as possible.

- **Minimal footprint.** New logic goes into new files: `server/src/myrmidon/<topic>/…`,
  `packages/<package>/src/myrmidon-<topic>.ts`, `ui/src/components/myrmidon/…`. A vendor file
  gets only a call site.
- **A marker on every edit inside a vendor file** — a comment `// myrmidon(<ID>): <why, in
  English>`, e.g. `// myrmidon(P1): release leases before promotion`. The porting bot finds
  our pieces by this marker.
- **Comments, logs and error texts in English.** No numbers of our board tasks, no names of
  agents, companies or servers.
- **Settings** are environment variables `MYRMIDON_<AREA>_<NAME>`, read in the feature's
  module. Do not touch `server/src/config.ts` (exception: track 1, telemetry). Default
  values:
  - a defect fix is enabled;
  - values for our deployment (windows, limits, addresses) are disabled or neutral.

  Our production values live in `myrmidon-deploy`. Every setting is a line in
  [SETTINGS.md](SETTINGS.md).
- **New APIs** go under `/api/myrmidon/…`, so they cannot collide with future vendor paths.
- **Database migrations are additive only.** Add a table, a column or an index; dropping,
  renaming, type changes and data rewrites are forbidden. The reason is rollback:
  `rollback.sh` restores the image but not the database, so the old image must keep working
  on the new schema. Vendor migration numbers grow every week: take the next free number and
  check it again before merging; duplicate numbers are caught by `check:migrations`. Generate
  migrations with the regular `pnpm --filter @paperclipai/db generate`: a hand-written schema
  snapshot breaks the next migration. We still prefer storing state in existing JSON fields:
  `instance_settings.general`, `adapterConfig`, `metadata`. A non-additive migration — stop
  the step, describe it in the PR and in the report; the decision belongs to the maintainer.
- **Dependencies** are not added without need. If a new dependency is unavoidable — justify
  it in the PR, pick a license from the allowed list (track 1), and update `pnpm-lock.yaml`
  only via `pnpm install`.
- Do not rename packages, the CLI or `PAPERCLIP_*` variables.
- Patching a vendor package from `node_modules` goes through the vendor mechanism
  `pnpm.patchedDependencies` (`patches/*.patch`). Replacing files is not allowed.
- No media tools in the image: ffmpeg, yt-dlp, generators. That is a separate service outside
  the fork.

## 9. Openness: what must not appear in the public repository

**Forbidden** in code, tests, documents, commits and PR descriptions:

- secrets: tokens, keys, passwords, connection strings, certificates and private keys;
- our addresses: domains, IPs (including private networks), ports of our services;
- names of our hosts and paths on our servers;
- names of our companies, agents, bots and people;
- numbers of our board tasks, run identifiers, agent and company IDs, chat IDs;
- our gateway model list.

**Allowed:**

- placeholders `example.com`, `192.0.2.0/24`, `198.51.100.0/24`, `localhost`, `127.0.0.1`;
- names of patch directories and files from `myrmidon-deploy` in `docs/myrmidon/` documents
  (e.g. `P1-ope2544-heartbeat-lease`). They must not appear in code, tests or commits.

**Self-check before a PR** — look through your diff for matches:

```sh
git diff origin/main...HEAD | grep -nEi \
  '(password|passwd|secret|token|api[_-]?key)\s*[:=]|BEGIN [A-Z ]*PRIVATE KEY|\b10\.[0-9]+\.[0-9]+\.[0-9]+\b|\b172\.(1[6-9]|2[0-9]|3[01])\.[0-9]+\.[0-9]+\b|\b192\.168\.[0-9]+\.[0-9]+\b'
```

Investigate every match. If `myrmidon-deploy` has a file with forbidden patterns, run the
diff against it as well. Track 1 will add such a check to CI.

If a secret or an internal address is already in the public repository, do not fix it with a
quiet commit: history will not lose it. Immediately write it up in the report marked
"urgent".

## 10. The private `myrmidon-deploy` repository

- Read only. Do not push, do not open PRs there. If a patch README is wrong or incomplete,
  write that in the report.
- `patches/<directory>/README.md` is the **source of truth** for a patch: what it does, why,
  how it was verified, when to drop it. Next to it:
  - the diff against vendor 2026.916.1: built JS (`*-dist.patch`) and, where available, the
    TS source (`*-src.patch`);
  - our files (`ours/`) and the vendor originals (`vendor/`);
  - tests (`tests/`) and reference material (`ref/`).
- **Do not copy files from there as-is**: they contain Russian comments, our task numbers and
  internal addresses. Port the logic; write the code in TypeScript on top of current `main`,
  with English comments and neutral test data.
- A change that exists only in built JS is rewritten in the `*.ts` source. `dist` files are
  not committed.
- If something the track promises is missing in `myrmidon-deploy`, do not invent it. Build it
  from the track description and note it in the report.

Patch directories as of 27.09.2026 (exact list: `ls patches/`):

| Feature | Directory in `myrmidon-deploy/patches/` | Track |
|---|---|---|
| P1 | `P1-ope2544-heartbeat-lease` | 2 |
| P2 | `P2-ope2365-card-addressee-wake` | 2 |
| P3 | `P3-ope2313-continuation-cap` | 2 (hermes part — 3) |
| P4 | `P4-ope2469-hermes-execute` | 3 |
| P5 | `P5-ope2317-checkout-fail-fast` | 3 |
| P6 | `P6-ope2422-github-broker` | 3 |
| P7 | `P7-ope2583-telegram-omission` | 4 |
| P7b | `P7b-chat-synthetic-id` (including vendor commit #13654) | 4 |
| P8 | `P8-ope2579-telegram-2gb` | 4 |
| P9 | `P9-ope2732-tool-gateway` (`v1` — live version, `v2` — "don't drop the connection" candidate) | 3 |
| P10 | `P10-ope310-sse-405` | 3 |
| P11 | `P11-ope2847-db-backup-catchup` | 2 |
| Telemetry | `T1-telemetry-off` | 1 |

S2, S4, S5, M1, H1, H4, X2, R1–R4 have no patches: they are new work from the track
description.

## 11. Vendor commits missing from our base

1. Fetch from the vendor's public repository:
   `git fetch https://github.com/paperclipai/paperclip.git <sha or refs/pull/<N>/head>`.
2. If the session network blocks that, use a `*.patch` file from `myrmidon-deploy` via
   `git am`: for commits that do not apply to `v2026.916.1` as-is, versions rebased onto the
   tag live there (`*-rebased-on-916.1.patch`, already containing the line
   `(cherry picked from commit …)`). `git am -3` does not help here: the fork's history has
   no objects from the vendor's master. If a commit message after `git am` lacks the line
   `(cherry picked from commit <full sha>)` — add it (`git commit --amend`).
3. If neither is available, note it in the report and move to the next step.
4. Port with `git cherry-pick -x`. In DIVERGENCE.md the ID is `vendor:<short sha>`; in the
   "How to drop" field: "goes away by itself when a vendor tag containing this commit is
   ported".

## 12. File map and track intersections

A track changes only files from its own list (the "Track files" section in `tracks/N.md`).
If you need a change in someone else's file, first look for a way to manage with a new file.
If that fails — make the edit minimal (a single call site with a `myrmidon(<ID>)` marker) and
describe it in the PR.

**Unavoidable intersections:**

| File | Tracks | Who goes first |
|---|---|---|
| `packages/adapters/hermes/src/server/execute.ts` | 2 (vendor #13891, 4 lines; X2 — only if needed), 3 (P4, the main port), 4 (H1 — only if a call site is needed), 6 (S2, M1) | 2 → 3 → 4 and 6 (and 2 for X2). After P4 is merged, other tracks add only call sites here |
| `packages/adapters/{claude,codex,cursor,gemini,grok,kimi,opencode,pi}-local/src/server/execute.ts` | 2 (vendor #13891), 4 (H4, stdin), 6 (S2, environment) | 2 first, then 4 and 6 in any order |
| `packages/adapter-utils/src/server-utils.ts` | 2 (vendor #13891). 4 and 6 — only if there is no other way | 2 first; 4 and 6 put their code in new files |
| `packages/adapters/hermes/src/server/config-schema.ts` | 3 (P4 — only if it moves patch fields into the form), 6 (M1, model fields) | 3 → 6 |
| `packages/adapter-utils/src/execution-target.ts` | 2 (vendor #13793), 6 (S2, call sites) | 2 → 6 |
| `server/src/routes/openapi.ts` | 2 (P11, health response schema), 4 (vendor #13654), 5 (if it registers its API) | 4 → 5; 2 in any order with them, rebase as needed |
| `server/src/services/heartbeat.ts` | 2 (P1), 3 (P9, run connection selection), 5 (R3, call sites), 6 (S5, call site) | 2 and 3 in any order; 5 and 6 preferably after them |
| `server/src/modules/run-dispatch/**` | 2 (P2), 5 (R3, call site) | 2 → 5 |
| `server/src/index.ts`, `server/src/routes/health.ts` | 2 (P11), 5 (R3) | Any order |
| `server/src/services/issues.ts`, `server/src/routes/issues.ts` | 3 (P5), 6 (S5, call site) | 3 → 6 |
| `server/src/services/chat-channels.ts` | 4 (P7), 6 (S5, call site) | 4 → 6 |
| `pnpm-lock.yaml` | 4 (P8). Others — only for a forced new dependency | 4 |
| Root `package.json` | 1 (scripts) | 1. Other tracks do not touch it: they run their scripts directly (`node scripts/myrmidon/…`) |
| `.github/workflows/**` | 1 | 1. If a track needs a new CI check, it writes that in the report |
| `docs/myrmidon/DIVERGENCE.md`, `docs/myrmidon/SETTINGS.md` | All | Each track writes only in its own section |
| `docs/myrmidon/tracks/N.md` | Only track N, the "Status" section | — |

**Rule:** whoever merges first is right. Everyone else updates their branch from fresh
`main` and resolves the conflict on their side, keeping the other change. Do not throw away
someone else's code while resolving a conflict. If it is unclear how to combine the changes,
stop that step, describe it in the PR and in the report, and move to the next one.

Sessions do not edit `README.md`, `ROADMAP.md`, `CONVENTIONS.md` or `SESSION-PROMPTS.md` in
`docs/myrmidon/`. Proposals for them go into the report.

## 13. Working in a cloud session

- **Start:** `node -v` (24.x required, no lower than 24.11). If pnpm is the wrong version:
  `corepack enable && corepack prepare pnpm@9.15.4 --activate`. Then
  `pnpm install --frozen-lockfile`.
- **Long commands** (over 2 minutes) run in the background with output to a file; check the
  file. Do not run the full test suite without need: the spend limit is shared across all
  sessions.
- **Do not build the image locally:** session disk is not enough. CI builds the image.
- **There are no secrets in the session,** and asking for them is pointless. Tests must not
  require live keys.
- **Questions.** Do not wait for an answer. Decide yourself within these documents and record
  the decision in the PR. If a decision is irreversible or exceeds the track's scope, skip the
  step, move to the next one and raise the question in the report.
- **Report:**
  - in every PR — a description following the template;
  - in the last PR of each step — an updated "Status" section in your `tracks/N.md`;
  - at the end of the work — a final message in the session: the list of PRs (merged /
    open), which readiness criteria are met, what is postponed and why, what operations
    should verify on the live installation, open questions.

## 14. The vendor's `AGENTS.md`

Code rules from `AGENTS.md` apply:

- section 5, items 1–4 and 7;
- section 6 — schema edit order and migration generation, with our restriction "additive
  migrations only" (section 8 of this file);
- sections 7–9;
- section 11, except the PR template requirement;
- the `DESIGN.md` design system and `pnpm check:token-gates` for changes in `ui/`.

Do not apply:

- section 5, items 5–6 — plans and artifacts live in Paperclip tasks;
- section 10 — the vendor PR template; we have our own (section 5 of this file).

## 15. Releases (owner's decision 30.09.2026)

Releases ship when ready. Any green `main` carrying user value can be tagged — even daily. A
minor version number marks that the headline items have landed; it does not wait for the
whole list. Daytime deploys are allowed.

## 16. Review, tasks and tests (owner's decisions 30.09.2026)

- **Green CI before review.** A PR goes to review only with green CI. Run the tests locally
  before pushing. The reviewer returns a red PR without reviewing it.
- **Direct dispatch to engineers.** The lead does not hold executable tasks: ready items go
  straight to engineers. The lead keeps decomposition, acceptance and umbrella tasks.
- **New logic needs tests.** There is no "no new tests" rule.
