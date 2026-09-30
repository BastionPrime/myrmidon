# Deploying and rolling back Myrmidon

> Russian version: [deploy.ru.md](deploy.ru.md)

Deploys pin the image digest of `ghcr.io/itkadr-git/myrmidon`, not a tag: a tag can be moved,
a digest cannot. Only an image built by CI reaches production (the owner's decision): the
deploy script enforces it before anything else, see [CI-built images only](#ci-built-images-only).
The scripts live in [`scripts/myrmidon/deploy/`](../../scripts/myrmidon/deploy/)
and know nothing about a specific installation: everything comes from the settings file. An
example is [`deploy.env.example`](../../scripts/myrmidon/deploy/deploy.env.example); the real
settings file of an installation lives in a private deploy repository and never enters this one.

## What the host needs

- bash 4+, `docker` with the `compose` and `buildx` plugins, `curl`, `jq`, `git`;
- the scripts run from a clone of `itkadr-git/myrmidon` whose `origin` points at
  `github.com/itkadr-git/myrmidon`: the clone is how the image commit is checked against
  `main` (see below). From a directory without git, or from a clone of another repository,
  the deploy refuses;
- the Myrmidon server runs under docker compose, and the service image is set in a separate
  override file (`COMPOSE_OVERRIDE_FILE`). The script changes only the `image:` line in it;
- a database dump command (`DUMP_COMMAND`) and, for a rollback with a restore, a restore
  command (`RESTORE_COMMAND`). Both get the path in the `DUMP_FILE` variable;
- in `authenticated` mode, anonymous `/api/health` shows the commit but not the version. A
  board key in a file with mode `0600` at `HEALTH_TOKEN_FILE` is **required**: without it the
  version check at step 7 fails and the deploy counts as failed (by design — the version is
  always checked);
- how to count runs in progress: `RUNNING_RUNS_COMMAND` or `MAINTENANCE_MODE=api`. If the
  counter fails (an error or empty output), the deploy stops before the image changes. The
  wait can be skipped only explicitly: `ALLOW_UNKNOWN_RUNS=1`.

## Where to get the digest

In the summary of the `image` job of the **Myrmidon image** workflow (Actions → the run on the
commit or tag): the `Digest` line. Or:

```sh
docker buildx imagetools inspect ghcr.io/itkadr-git/myrmidon:1.0.0 --format '{{json .Manifest.Digest}}'
```

`--digest` accepts `sha256:<64 hex>` or the full reference
`ghcr.io/itkadr-git/myrmidon@sha256:<64 hex>`. The script does not take a tag (`1.0.0`, `main`,
`ghcr.io/itkadr-git/myrmidon:1.0.0`): a tag cannot prove the image is the one that passed CI.

The version and commit that `/api/health` must report come from the image labels
(`org.opencontainers.image.version`, `org.opencontainers.image.revision`). They can be set
explicitly: `--expect-version`, `--expect-commit`.

## CI-built images only

The owner's decision: only an image built by CI (the **Myrmidon image** workflow) from `main`
or from a `myr-v*` tag reaches production. A hotfix also goes through a PR, even an expedited
one, not through an image built on the spot. A hand-built image reaches production bypassing
the repository and review, and on the next deploy its content silently disappears: it is not
in the repository.

`deploy.sh` enforces this **before any action** (before `docker pull`, the dump and
maintenance) and on any "no" exits with the reason, changing nothing:

1. **The reference** is exactly `ghcr.io/itkadr-git/myrmidon@sha256:<64 hex>`: no tag without
   a digest, no other repository or registry, no uppercase in the digest. `MYRMIDON_IMAGE` in
   the settings file must equal `ghcr.io/itkadr-git/myrmidon`; any other value is a refusal.
2. **The image is in the registry.** Its manifest and config are read from the registry
   (`docker buildx imagetools inspect`) without pulling the layers. A locally built image is
   not there; an unreachable registry is a refusal too.
3. **CI labels.** The image carries `org.opencontainers.image.revision` (the full commit sha)
   and `org.opencontainers.image.source` equal to `https://github.com/itkadr-git/myrmidon`.
   CI sets these labels at build time.
4. **The commit is checked.** The script runs `git fetch origin main` in the clone that holds
   it and requires the label commit to be reachable from `origin/main`, or to carry a
   `myr-v<x>.<y>.<z>` tag in `origin` (`git ls-remote --tags`). An image built from a branch
   or from unreviewed code does not pass. No git, the script outside a clone, a foreign
   `origin`, a failed fetch — a refusal with a clear reason.

There is no bypass: no flag, no setting. `--force` (redeploying the same image) and
`--expect-*` do not skip the check. To deploy an image that does not pass, the image must go
through CI: a PR into `main`, a merge, a build.

`--dry-run` runs the same check (it only reads the registry and updates `origin/main` in the
clone), so a trial run shows the refusal in advance.

Scope. This protects against mistakes, not against malice: someone with write access to the
`ghcr.io/itkadr-git/myrmidon` package can push an image with foreign labels. So write access
to the package must belong only to the build workflow (a GitHub package setting; the script
does not check it).

## Deploy

```sh
scripts/myrmidon/deploy/deploy.sh --config /path/to/deploy.env --digest sha256:<64 hex> --dry-run
scripts/myrmidon/deploy/deploy.sh --config /path/to/deploy.env --digest sha256:<64 hex>
```

Order:

0. The image check (the section above). If it fails, the deploy does not start and nothing is
   touched.
1. `docker pull` of the image by digest. If it does not pull, the deploy does not start.
2. The current image from the override file is remembered as the previous one: the full
   reference goes to `$STATE_DIR/previous-image` (so the first switch from a vendor image
   works too), the fork digest also to `$STATE_DIR/previous-digest`.
3. A database dump by `DUMP_COMMAND` into `DUMP_DIR`. If the file is missing or smaller than
   `DUMP_MIN_BYTES`, the deploy refuses and the image does not change.
4. Entering maintenance mode (`MAINTENANCE_MODE`):
   - `api` — `POST /api/myrmidon/maintenance` per the contract of
     [design/maintenance-mode.md](design/maintenance-mode.md), section 7 (track 5, R3);
   - `hook` — your own `MAINTENANCE_ENTER_COMMAND` / `MAINTENANCE_EXIT_COMMAND`;
   - `pause` — while there is no maintenance API: pause for `MAINTENANCE_PAUSE_SEC` seconds.
5. Waiting until no runs are in progress: `RUNNING_RUNS_COMMAND` or, in `api` mode,
   `instance.runningRuns` from the API. A `RUNS_WAIT_TIMEOUT_SEC` timeout (or a broken
   counter) aborts the deploy before the image changes, and **maintenance is lifted before
   the abort exit**: the board does not stay in maintenance until someone lifts it by hand.
   A failed lift (maintenance already off) is a warning, not a second failure; the exit
   reason stays "the drain did not finish". A broken counter also aborts (except with
   `ALLOW_UNKNOWN_RUNS=1`).
6. The new `image:` line in the override and `docker compose up -d --no-deps <service>`: only
   the server service is recreated.
7. The `/api/health` check (`verify-health.sh`): `status` is `ok`, the version and commit
   match.
8. Leaving maintenance mode.

If step 7 fails, the script exits with an error, **maintenance stays on**, and the output
carries the rollback command and the dump path.

`--dry-run` changes nothing (does not pull the image, does not dump, does not touch files)
and prints the plan. The image check (step 0) does run in it: it only reads.

## Rollback

```sh
scripts/myrmidon/deploy/rollback.sh --config /path/to/deploy.env            # to the previous image
scripts/myrmidon/deploy/rollback.sh --config /path/to/deploy.env --to sha256:<64 hex>
scripts/myrmidon/deploy/rollback.sh --config /path/to/deploy.env --to-image ghcr.io/paperclipai/paperclip:2026.916.1
```

Without `--to`/`--to-image` the rollback takes the image remembered at the last deploy —
including the vendor image on the first switch to the fork. The rollback restores the image
and checks health against the old image's labels. **The database is not restored.**

A rollback is the emergency path and is **not blocked** by the CI-only check: the image
recorded by `deploy.sh` as previous is restored wherever it came from. But the target is
checked the same way `deploy.sh` checks a new image (reference, registry, labels, commit)
and, when it does not pass, the script prints `WARNING: rollback target is not a verified CI
image: <reason>` and continues. The warning is expected on the first rollback to a vendor
image, or to an image built by hand before this rule existed: it is not in the registry. This
way the next operator sees the rollback goes to an unverified image. Vendor migrations are
one-way: the old image usually works on the new schema, and a dump restore erases everything
written after it. If the old image does not start on the new schema, restore as a separate
explicit step:

```sh
scripts/myrmidon/deploy/rollback.sh --config /path/to/deploy.env --to sha256:<old> \
  --restore-dump /path/to/myrmidon-<time>-<digest>.dump
```

The script asks to type `RESTORE` (or takes `--yes-restore-database`), stops the server
service, runs `RESTORE_COMMAND`, then brings the old image up.

## Deploy from the interface

The board can start its own deploy: the instance settings ("Board update") verify a digest,
open a maintenance window, hand the switch to a host executor and follow it to health. The
rules are the script's rules, not a second policy:

- the same CI-image check (reference, registry, labels, commit on main or a myr-v* tag) runs
  BEFORE the maintenance window opens — a refused image changes nothing, not even run
  admission; there is no flag that skips it;
- one deploy at a time: while a job is open, a second one is a 409;
- the maintenance window is instance-wide, reason `deploy <digest prefix>`, and it is left
  when the job ends; on a failed health check it STAYS ON for the rollback (the same
  contract as step 7 of the script);
- the board never runs docker itself. The host half is
  `scripts/myrmidon/deploy/deploy-from-job.sh`, which polls the board API, waits for the
  window to be `on`, runs the same `deploy.sh` (dump, drain, health) and writes a small JSON
  report per job (`$STATE_DIR/job-<id>.json`). Mount that directory read-only into the board
  container as `MYRMIDON_DEPLOY_REPORTS_DIR`; the board reads it, it never writes there;
- the job is marked succeeded only when the board's own `/api/health` agrees with the
  reported version and commit — a lying report cannot close a failed deploy;
- a job stuck in one step longer than `MYRMIDON_DEPLOY_STEP_TIMEOUT_SEC` aborts itself and
  leaves the window.

### Enabling it

Everything is off by default (`MYRMIDON_DEPLOY_ENABLED` unset). To switch it on:

1. `MYRMIDON_DEPLOY_ENABLED=1` in the board environment;
2. `MYRMIDON_DEPLOY_HEALTH_URL` — the board's own health endpoint as the board container
   reaches it (for example `http://127.0.0.1:3100/api/health`);
3. `MYRMIDON_DEPLOY_REPORTS_DIR` — the mounted reports directory (the host's `$STATE_DIR`);
4. on the host: the executor (`deploy-from-job.sh --config <deploy.env>`), a timer or a
   terminal session. It needs `BOARD_API_URL` (and `BOARD_TOKEN_FILE` in `authenticated`
   mode — a board API key file, mode 0600, the same one `HEALTH_TOKEN_FILE` uses).

The board reads the registry and GitHub itself for the digest check. When the board
container cannot reach them, `MYRMIDON_DEPLOY_REGISTRY_INSPECT_URL` points at a read-only
inspect endpoint answering `?ref=<reference>` with the `imagetools inspect` JSON, and
`MYRMIDON_DEPLOY_GITHUB_HEADERS_JSON` adds headers to the GitHub calls (never a token
value in the environment of a public deployment file).

### When the button, when the script

The interface is for routine deploys: the digest comes from a green CI run on `main` or a
`myr-v*` tag, the board is reachable, the executor runs. The script stays the path for the
first deploy of an installation, for a broken board (it cannot deploy itself), and for every
case the interface refuses — which is exactly the case the script would refuse too.

## What to check after a deploy

- `/api/health`: `status: ok`, the version and commit as in the image summary; `maintenance`
  is off.
- The server log: migrations applied, no startup errors:
  `docker compose logs --since 10m <service>`.
- The interface opens, the agent list is in place, an issue opens.
- Runs start again: queued wakes are delivered, a new run goes through.
- The plugins (hindsight and the rest) are `ready` in the plugin settings.
- `$STATE_DIR/history.log` has the deploy line.

## The release staging host

Before a production deploy, a release is verified on a separate VM on a copy of the
production database.

**Resources.** Not less than the production installation in memory and in disk for the
database; less CPU is fine. Disk for the image (several GB), the database copy and its dump.

**Setup.**

1. A separate VM without access to the production services: its own networks, its own
   secrets, a different address.
2. The same compose as on the production installation, with the override file pinned to the
   digest under test.
3. The latest production dump restored into the staging database.
4. External integrations off before the server starts:
   - chats (Telegram and others) — bot tokens unset or replaced with test ones;
   - mail — sending off;
   - telemetry and the announcements feed — off (that is the default);
   - all agents paused, routines off — runs must not follow production issues;
   - model keys — test ones or empty.

**Smoke checks.**

1. `verify-health.sh --url <staging address>/api/health --expect-version … --expect-commit …`.
2. The log: all migrations applied, no re-application.
3. The agent list opens and matches production.
4. An issue with a long history opens.
5. A short run with a test adapter (`process` or `http` against a stub) reaches `succeeded`.
6. The plugins come up (hindsight is mandatory).
7. A deploy from the previous digest to the new one and a rollback back, by the scripts of
   this directory, pass on the staging host.

**You may deploy when:**

- every check above has passed;
- CI on the release commit is green, the image was built by the **Myrmidon image** workflow,
  the digest is recorded (`deploy.sh` will not deploy without it anyway: the image check is
  mandatory);
- there are no new errors in the server log on the staging host for the duration of the
  checks;
- the rollback on the staging host has passed and the server is healthy after it.
