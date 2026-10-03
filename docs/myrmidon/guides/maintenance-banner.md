# The maintenance banner

> Russian version: [maintenance-banner.ru.md](maintenance-banner.ru.md)

When a maintenance window is open, the plaque at the top of the board shows
what is under maintenance and what it means for runs. The plaque is
informational only — opening and ending windows happens under Instance →
General; see [../design/maintenance-mode.md](../design/maintenance-mode.md)
for what a maintenance window is and how to open one.

This page describes the aggregated plaque introduced in release 1.6.1. Before
it, the banner rendered one line per window (grouping only per-agent windows
of one kind, since 1.3); now the banner is always a single collapsed plaque.

## The collapsed plaque

However many windows are open — one per agent in a batch container update,
plus instance/company/department ones — the banner stays one collapsible
plaque at the top of the layout, refreshed every 30 s. It shows the windows
that concern the current company: instance-wide windows everywhere, narrower
ones only in their own company. The summary line carries:

- the total number of open windows;
- the number of kinds they group into (scope type + state + reason);
- the aggregate state: `ending` when every window is ending, `draining` while
  any window is still draining runs in flight (with the total count of runs
  still running, or the past-timeout variant), otherwise `on`;
- an ends-by bound (the `maintenanceBanner.endsBy` string, `{{time}}`
  placeholder) — the latest drain deadline across all windows that are not
  ending. The phrase is omitted when no deadline is known.

The collapsed summary never shows agent ids — counts only.

## The expanded details

Expanding the plaque lists one row per kind of window: its scope, state,
earliest start time and reason, plus the window count and the total queued
wakeups of that kind. Two windows share a row only when scope type, state and
normalized reason all match; per-agent identifiers are stripped from the
reason before grouping, so one line of a batch update covers the whole batch.
For agent rows the individual agent ids appear on hover and in an "Agent ids"
line inside the expanded row — never in the collapsed summary.

## Reading the states

- **on** — the window is active; new runs are paused and wakes are queued
  (they are delivered when maintenance ends).
- **draining** — the window is waiting for runs already in flight to finish;
  the label shows how many are still running, or how many are past the
  timeout when the drain timed out.
- **ending** — the window is closing.
