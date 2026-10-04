# Automatic rollback by health after a deploy

> Russian version: [deploy-auto-rollback.ru.md](deploy-auto-rollback.ru.md)

This page is the operator guide for the automatic rollback that protects every
board deploy (release 1.4, the R5-C track). When a deploy's post-switch health
check fails, the board does not wait for a human: the host executor switches the
image back to the one the deploy remembered before the switch, verifies the
previous image is healthy again, and closes the job — all without a person.

For the deploy flow itself (digest, maintenance window, the host executor), see
[../deploy.md](../deploy.md). The upgrade notes of every release repeat the
short version of the same contract.

## When it fires

The rollback is triggered by exactly one thing: the **health check after the
image switch**. The deploy verifies the version and commit that `/api/health`
reports against the image labels; a mismatch, an unreachable health endpoint or
a failing host executor at that step is a failed health check.

- with the rollback **on** (the default) a failed health check moves the job to
  `rolling_back` — the failure is not terminal yet;
- with the rollback **off** (`MYRMIDON_DEPLOY_AUTO_ROLLBACK=0` on the board AND
  `AUTO_ROLLBACK=0` in `deploy.env` — both sides must agree) a failed health
  check ends the job `failed_health` and the maintenance window stays open: the
  rollback is the operator's tool, the 1.3.x manual contract.

Everything before the switch is unaffected: a refused digest (the CI-image
check), a window that cannot open or a step timeout abort the job without
rolling anything back — nothing was switched, so there is nothing to restore.

## What the job does

The board itself never runs docker. It moves the job through statuses and the
host executor (`scripts/myrmidon/deploy/deploy-from-job.sh`) does the switching,
reporting each phase into `$STATE_DIR/job-<id>.json`:

| Step | Job status | Report phase | What happens |
| --- | --- | --- | --- |
| Health failed | `rolling_back` | `health-failed` (or the executor jumps straight to `rolling-back`) | The failure reason is recorded on the job; the window stays on — it covers the rollback switch too |
| Rollback runs | `rolling_back` | `rolling-back` | `rollback.sh` re-pulls and re-creates the service on the remembered previous image (the emergency path: the CI-image check of the rollback target only warns) |
| Rollback healthy | `auto_rolled_back` | `rolled-back` | The previous image passed its own health check; the maintenance window leaves; the board serves traffic again — no human took part |
| Rollback failed | `failed_rollback` | `rollback-failed` | The window STAYS ON for the operator; the job keeps both the deploy's reason and the rollback's |

The board does not trust the host report alone: the job is marked succeeded
(or the rollback closed) only when the board's own `/api/health` agrees with the
reported version and commit.

The whole path is idempotent and driven by the reconciliation tick
(`MYRMIDON_DEPLOY_TICK_SEC`, default 5 s). A tick that misses the intermediate
phases (the rollback takes seconds, the tick is 5 s) still lands on the right
terminal status by following the report's final phase.

## Where the reason is recorded

- **The job** — `failureReason` on the job and the step log hold the deploy's
  failure (for example `host executor failed: health-failed — health did not
  match`); a failed rollback adds its own line on top. Visible in the
  "Board update" panel of the instance settings and in
  `GET /api/myrmidon/deploy-jobs` (history).
- **The activity log** — every transition writes an `activity_log` row
  (`myrmidon.deploy_jobs.rolling_back`, `...auto_rolled_back`,
  `...failed_rollback`) with the digest, status and reason in the details.
- **The executor log** — `$STATE_DIR/job-<id>.log` on the host holds the
  `deploy.sh` and `rollback.sh` output; `rollback-failed` details point at it.

## The card to the owner

A `failed_rollback` job keeps the maintenance window on: the instance is paused
and the operator is the only one who can act. The board itself does not create a
task for the owner — the board is in maintenance, its agents are paused, and a
task from a paused board would not be picked up. The surfaces that do fire:

- the maintenance banner at the top of the board names the window and its
  reason (`deploy <digest prefix>`), so every board member sees why the board
  is paused;
- the "Board update" panel shows the `failed_rollback` job, its failure reason
  and the abort-free terminal state;
- the daily Telegram digest (when the owner enabled it, see
  [owner-telegram-cards.md](owner-telegram-cards.md)) lists the open attention
  items, including the maintenance state.

If the board cannot come back even on the previous image, the runbook is the
script's: follow [../deploy.md](../deploy.md) ("Rollback", "What to check after
a deploy") from the host.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `MYRMIDON_DEPLOY_AUTO_ROLLBACK` (board) | `1` (on) | The board half of the switch; `0` restores the manual contract |
| `AUTO_ROLLBACK` (deploy.env, host) | `1` (on) | The host half; the executor runs `rollback.sh` on a failed health check only when both sides agree |
| `MYRMIDON_DEPLOY_HEALTH_POLL_SEC` / `MYRMIDON_DEPLOY_HEALTH_TIMEOUT_SEC` | 5 s / 300 s | The health-check window after the switch |
| `MYRMIDON_DEPLOY_STEP_TIMEOUT_SEC` | 1800 s | A step stuck longer aborts the job — including a stuck rollback |

Both halves of the switch are read from the environment; they are host- and
board-startup settings, not runtime-changeable interface settings, because the
two sides must agree and the board cannot write the host's `deploy.env`. Full
rows: [../SETTINGS.md](../SETTINGS.md).

The same protection for the bot fleet (canary and waves) is a separate switch,
`MYRMIDON_BOT_CANARY_AUTO_ROLLBACK` — see the bot canary notes in
[../deploy.md](../deploy.md).
