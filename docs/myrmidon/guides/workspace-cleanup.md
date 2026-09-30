# Workspace cleanup after merge

> Russian version: [workspace-cleanup.ru.md](workspace-cleanup.ru.md)

The execution-workspace service owns the git working copies that agent runs
use. A reaper archives a copy after its issue tree becomes terminal. This page
describes the two hygiene rules added in release 1.3: a short cooldown for
copies whose branch is already merged, and a daily signal for a terminal copy
the reaper cannot delete.

## The short cooldown for merged copies

The vendor reaper waits one cooldown
(`PAPERCLIP_WORKSPACE_REAPER_COOLDOWN_DAYS`, seven days by default) after an
issue tree becomes terminal before it archives the working copy, whether or not
the branch was merged. A merged copy therefore stayed on disk for a week.

A copy whose delivery state is `merged_via_pr` or `merged_by_ancestry` now uses
a much shorter cooldown: `MYRMIDON_WORKSPACE_MERGED_COOLDOWN_MS`, 30 minutes by
default. Set it to `0` to archive a merged copy on the next sweep. A
non-numeric or negative value falls back to the 30-minute default. Every other
terminal copy keeps the seven-day cooldown.

The protection for unmerged work is unchanged: a copy with a dirty tree, an
unpushed or an unconfirmed commit is never archived, under neither cooldown.

## The stuck-copy signal

A terminal copy that the reaper cannot delete (a dirty tree, or undelivered
work) used to be skipped in silence; only the sweep counters showed it.

A copy that stays undeletable for longer than
`MYRMIDON_WORKSPACE_STUCK_SIGNAL_AFTER_MS` (24 hours by default) now writes one
activity-log row per day: action `execution_workspace.issue_terminal_archive_blocked`,
actor `workspace_terminality_reaper`. The repeat is throttled through the
copy's `metadata` (no schema migration), and the row carries no host paths.
Set the variable to `0` to signal as soon as the copy becomes terminal; a
non-numeric or negative value falls back to the 24-hour default.

## What the operator should do

- Watch for `execution_workspace.issue_terminal_archive_blocked` rows. Each one
  means a terminal working copy is sitting on disk and the reaper cannot remove
  it.
- Open the copy, resolve what blocks the archive (commit and push the work, or
  clean the dirty tree), and let the next sweep archive it.
- If merged copies pile up, lower `MYRMIDON_WORKSPACE_MERGED_COOLDOWN_MS` (to
  `0` for the fastest cleanup). Do not lower it at the cost of the unpushed-work
  guard — that guard is independent and stays in force.
