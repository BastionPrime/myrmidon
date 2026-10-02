# Run stall detection (progress-based run liveness)

> Russian version: [run-stall.ru.md](run-stall.ru.md)

A run whose own recorded progress has not moved for a while is interrupted by
the server itself, its task goes back to `todo`, and the assignee is woken so
the work resumes through the normal wake path. This is the self-healing half
of run liveness: the board no longer waits for the hard run timeout to notice
a run that will never move again.

The feature ships enabled. Its settings are the `MYRMIDON_RUN_STALL_*`
variables, listed with defaults and ranges in
[../SETTINGS.md](../SETTINGS.md).

## What counts as progress

Only recorded progress counts — never the run's own duration. The newest of
these timestamps is the run's progress anchor:

- the newest stdout/stderr flush (`heartbeat_runs.last_output_at`);
- the newest action the board classified as useful work
  (`heartbeat_runs.last_useful_action_at`);
- the newest appended run event of any type
  (`heartbeat_run_events.created_at`);
- for a just-claimed run that has recorded nothing yet, the claim timestamps
  (`process_started_at` / `started_at`) anchor the clock until the first
  progress lands.

A run working for hours with fresh progress is left alone; only silence
longer than the threshold (20 minutes by default) stalls it. A run that
carries no timestamp at all is "cannot judge" and is never interrupted by
this sweep.

## What happens when a run stalls

Once per scan pass (at most once a minute; the scheduler queue ticks every
15 seconds, and one pass inspects at most 50 runs, stalest progress first):

1. The run is re-read immediately before the interrupt, so progress recorded
   while the pass was working keeps the run alive.
2. A run inside an open maintenance window is skipped.
3. The run is cancelled through the same path maintenance mode uses, with the
   error code `run_stalled`. The code is exempted from the
   `legacy_execution_requires_reconciliation` hold exactly like the
   maintenance interrupt code, and the cancel goes with immediate recovery
   suppressed — the sweep itself re-opens the work:
   - the task the run was executing goes back to `todo` — but only a task in
     `in_progress` with no live execution stage (a task in review, blocked,
     or in a terminal state keeps its status);
   - the assignee is woken with reason `run_stalled`, with the task bound to
     the wake. If the task already has a live run or a queued wake covering
     it, no second wake is issued; if the wake is refused by admission
     (pause, limits, coalescing), the task stays in `todo` and the normal
     wake path picks it up.
4. An activity log row `myrmidon.run_stall.interrupted` is written with the
   measured silence, the threshold and whether the task was returned and the
   assignee woken. A run whose interrupt fails is retried by the next pass.

A nonzero count of stall interrupts on a healthy board means runs really are
stalling and the sweep is doing its job, not that the server is broken.

## Metrics

The module exposes `countRunStallInterrupts`, a read-only count of runs the
sweep interrupted inside a window (24 hours by default, optionally scoped to
one company). No new table and no schema change: the count is a query over
the runs the sweep marked with the `run_stalled` error code. The function is
the data source for the health page of the follow-up team-liveness part; it
is not wired to an HTTP endpoint yet.

## Settings

| Variable | Default | What it does |
|---|---|---|
| `MYRMIDON_RUN_STALL_ENABLED` | on | Master switch. `0`/`false`/`off`/`no` disables the sweep (vendor behavior: a silent run lives until the hard run timeout). Unset or unrecognized — enabled |
| `MYRMIDON_RUN_STALL_THRESHOLD_SEC` | `1200` (20 min) | Silence window after which a running run with no recorded progress is interrupted. Range 60–86400; out of range or non-numeric — the default |
| `MYRMIDON_RUN_STALL_CHECK_INTERVAL_SEC` | `60` | Minimum spacing between two scan passes. Below 15 — 15; non-numeric — the default |
| `MYRMIDON_RUN_STALL_PAGE_SIZE` | `50` | How many running runs one pass inspects at most. Range 1–200; out of range or non-numeric — the default |

Details and the full settings table: [../SETTINGS.md](../SETTINGS.md).
