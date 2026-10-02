# A task settles once its pull requests merge (TASK-PR-SYNC)

> Russian version: [task-pr-sync.ru.md](task-pr-sync.ru.md)

A task delivered by a pull request used to stay `in_progress` until a person
noticed the merge and closed the task by hand. The board now closes such a
task on its own: a periodic sweep watches the pull requests registered on the
task and, once they have all finished with at least one merged, settles the
task to `done`. The feature ships enabled and needs no configuration.

## Where the task's PRs come from

The sweep does not add a parallel store: it reads the task's own work
products — the same `pull_request` work products the board writes when an
agent or a run registers a delivering pull request
(`POST /api/issues/:id/work-products`, type `pull_request`, provider
`github`). A task can carry several PRs (one per part of the work); the sweep
resolves each one through the existing company-scoped GitHub resolver and
adds no token or credential of its own.

## What one pass does

A pass runs on the scheduler tick, at most once a minute
(`MYRMIDON_TASK_PR_SYNC_POLL_SEC`, default 60). One pass inspects up to
`MYRMIDON_TASK_PR_SYNC_BATCH_MAX` candidate tasks (default 50), oldest
`updatedAt` first, and never runs while the instance is under maintenance.
For each candidate it resolves every PR through the existing GitHub resolver,
refreshes the stored work-product row when the resolver moved its state, and
then decides:

| Task state after the pass | What the board does |
|---|---|
| Every PR terminal, at least one merged, no open post-deploy gate | Settles the task: status `done`, one neutral comment, an activity row, the task's pending execution workflow dissolved |
| Every PR terminal, none merged | Returns the task to `in_progress` with a comment, unless a comment newer than the closure already answered it |
| Some PR still open or in draft | Leaves the task alone (the work is not finished) |
| A PR state could not be resolved | Leaves the task alone (a resolver failure is never read as a merge) |
| An open post-deploy gate holds the task | Leaves the task alone until the gate resolves (see below) |

Terminal PR states are `merged` and `closed`; superseded (archived) rows are
ignored — a duplicate the replacement PR overtook must not keep the task
open. An old PR closed without merging followed by a merged replacement
settles the task: at least one merged PR is enough to call the work
delivered.

## The settle and return comments

The settle writes exactly one comment, from the `task_pr_sync` system actor:

```text
Delivered: PR itkadr-git/myrmidon#315 merged (8a5ac6f48c4823ac76b626aadb77830f18394a41); task closed by the periodic PR sync at 2026-10-02T15:57:20.000Z.
```

and the return path writes:

```text
Delivery pending: PR itkadr-git/myrmidon#315 was closed without merging; task returned to the assignee at 2026-10-02T15:57:20.000Z.
```

The merge sha is recorded on each merged work product
(`metadata.lastMergedSha`), so a re-run that somehow sees the same merge
again does not comment a second time. Settling goes through the same
`issueService.update` path the board's manual PATCH uses; no SQL is
hand-rolled.

## Post-deploy gates

A person may still have a decision to make after the merge. The sweep defers
the settle while the task carries an open post-deploy gate:

- a pending issue-thread interaction (a review or confirmation card),
- a pending or revision-requested approval,
- a monitor scheduled for the future (`executionPolicy.monitor.nextCheckAt`).

Once the gate resolves, the next pass settles the task.
`MYRMIDON_TASK_PR_SYNC_SETTLE_DISABLED` is the blunt instance-wide lever —
the sweep keeps reading and logging but never flips a task to `done` — for a
deliberate hold on every settle at once; it does not affect the per-task gate
check.

## Activity log

Every automatic action writes an activity row (actor `task_pr_sync`):

| Action | When |
|---|---|
| `myrmidon.task_pr_sync.settled` | The sweep closed a task (PR refs, merge shas and the previous status are in the details). |
| `myrmidon.task_pr_sync.returned` | The sweep returned a task to its assignee (closed PR refs and the previous status are in the details). |

## Wake guard (the admission half)

Before dispatching a run for an event-free wake, the board checks whether the
task's `pull_request` work products are already all terminal with at least
one merged and the task is not settled yet. When so, the wake is skipped
(a wakeup request with status `skipped` and reason
`wake_skipped_pr_settle_pending`) instead of burning a run that would only
race the settle: the sweep closes the task on its next tick. Wakes that carry
events — a human comment or an issue-thread interaction — are never
suppressed. Settings: `MYRMIDON_TASK_PR_SYNC_WAKE_GUARD_*` in
[../SETTINGS.md](../SETTINGS.md).

## Settings

The feature ships enabled; only an explicit off value disables it, so a typo
cannot silently extinguish the fix.

| Variable | Default | What it does |
|---|---|---|
| `MYRMIDON_TASK_PR_SYNC_ENABLED` | `1` (on) | Master switch of the sweep. `0`/`false`/`off`/`no` disables it (tasks stay busy until closed by hand) |
| `MYRMIDON_TASK_PR_SYNC_POLL_SEC` | `60` | Minimum spacing between two passes; the scheduler queue itself ticks more often |
| `MYRMIDON_TASK_PR_SYNC_BATCH_MAX` | `50` | How many candidate tasks one pass inspects at most |
| `MYRMIDON_TASK_PR_SYNC_SETTLE_DISABLED` | unset (settling on) | Instance-wide hold: the sweep reads and logs but never flips a task to `done` |
| `MYRMIDON_TASK_PR_SYNC_WAKE_GUARD_ENABLED` | `1` (on) | Master switch of the wake guard. `0`/`false`/`off`/`no` disables it (wakes dispatch runs as before) |
| `MYRMIDON_TASK_PR_SYNC_WAKE_GUARD_TTL_SEC` | `60` | How long a suppress decision stays cached for one task (the cache holds at most 1000 issues, least-recently-used eviction) |

Details and the full settings table: [../SETTINGS.md](../SETTINGS.md).
