# The maintenance banner

> Russian version: [maintenance-banner.ru.md](maintenance-banner.ru.md)

When a maintenance window is open, the banner at the top of the board shows
what is under maintenance and what it means for runs. This page describes how
the banner aggregates per-agent windows, a behaviour added in release 1.3.

For what a maintenance window is and how to open one, see
[../design/maintenance-mode.md](../design/maintenance-mode.md). The controls
live under Instance → General.

## What the banner shows

A maintenance window applies to a scope: the whole instance, a company, a
department or an agent. The banner shows each window as a line: the scope, the
state, since when, and the reason. While a window is on, new agent runs are
paused and wakes are queued; they are delivered when maintenance ends.

## How per-agent windows are grouped

Batch operations (for example a bot container template update) can open one
maintenance window per agent. Shown one per line, they would fill the banner.
Since 1.3 the banner groups them:

- Agent windows that are on or draining are grouped by reason into one line:
  the reason, the number of agents and the total queued wakeups. The individual
  agent ids are available on hover and in an expandable list ("Agent ids").
  Two windows join one group only when both their state kind and their
  normalized reason match; the line shows the earliest start time of the group.
- Agent windows that are already ending collapse into a single compact line:
  "Agent maintenance ending — agents: N".
- Instance, company and department windows are shown separately, one line each,
  as before.

## Reading the states

- **on** — the window is active; new runs are paused.
- **draining** — the window is waiting for runs already in flight to finish;
  the line shows how many are still running.
- **ending** — the window is closing.
