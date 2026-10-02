# Workspace hygiene: the local workspace volume

An execution workspace is a directory on the server host: a checkout, a branch, and its own
`node_modules`. On 30.09.2026 that directory tree filled the workspace volume to 100 % — 34 GB of
workspaces, many of them for branches that were already merged — and agents started failing with
"session storage could not be written". Nothing in the product measured a workspace and nothing
capped it.

This document describes the three parts that fix it. They are one feature, split by how they work:
a shared package store (A), the lifecycle of a workspace (B) and the disk quota with its signal (C).
Part C is what this document describes in detail, because it owns the measurement, the quota values
and the signal; parts A and B change how much a workspace costs and when it goes away.

## The problem in one line

Two decisions were left to each agent's own discipline before this feature: how big a workspace
becomes, and when it stops being needed. A workspace is created by provisioning and is removed by
nobody. The owner's decision was to move both under the orchestrator.

## The three parts

| Part | What it does | Where |
|---|---|---|
| A — shared package store | `pnpm install` writes packages into one store on the same volume and links them into `node_modules` by hardlink, so a fresh workspace costs hundreds of MB instead of 2.5–3.4 GB | `scripts/provision-worktree.sh`, `server/src/services/workspace-runtime.ts` (`MYRMIDON_WORKSPACE_PNPM_STORE_DIR`) |
| B — workspace lifecycle | A workspace whose branch is merged is archived after a short cooldown (`MYRMIDON_WORKSPACE_MERGED_COOLDOWN_MS`); a workspace that cannot be removed (unpushed commits, a dirty tree) is never removed and raises its own signal after `MYRMIDON_WORKSPACE_STUCK_SIGNAL_AFTER_MS` | `server/src/services/execution-workspaces.ts` |
| C — quota, measurement, signal | The sweep measures each workspace, stores the measurement in the workspace metadata, and signals a workspace that outgrows its quota so somebody cleans it up | `server/src/myrmidon/workspace-hygiene/**` |

The parts are independent: A makes workspaces smaller, B removes the ones nobody needs, C says which
one is too big while it is still there. A workspace that A and B never touch is exactly the one C
signals about.

## Part C: the sweep

`createWorkspaceHygieneScheduler` is called from the server's scheduler tick, next to the terminal
workspace reaper (`scheduleTerminalWorkspaceSweep`). One tick does one sweep:

1. Read the quotas in force from `instance_settings.general.workspaceHygiene` (environment first
   start, see below).
2. Take one page of workspaces (25 by default) in a rotating `(updatedAt, id)` order, with a frozen
   upper bound so a stream of new rows cannot keep the rotation from finishing.
3. Skip a workspace whose last measurement is younger than six hours, and any workspace that has no
   local directory (`cwd` empty, or `providerType` other than `local_fs`): a sandbox elsewhere is
   not on this host's disk.
4. Measure the directory (`measureWorkspaceSize`) and write the measurement into the workspace
   metadata (`metadata.workspaceHygiene`), keeping every other metadata key — the lifecycle flags
   live in the same object.
5. When the workspace is over its quota, write one line into the activity log. At most once per 24
   hours per workspace: the timestamp of the last signal is stored with the measurement.
6. When the sum of the measured workspaces of one company is over `MYRMIDON_WORKSPACE_TOTAL_QUOTA_MB`,
   write one line for that company, at most once per 24 hours (the newest line of the same action is
   the anchor).

The sweep never deletes anything. Removal is part B's job.

### What the measurement is, and what it is not

- It is the apparent size (`st_size`) of the files and symlinks under the workspace directory.
- A file with more than one hard link is counted once, so a hardlinked package store is not
  reported once per workspace that links to it.
- Directory inode sizes are not counted.
- A symlink is measured by itself and never followed: a link to `/` or a link loop cannot make the
  walk unbounded.
- The walk is bounded by depth (24), by entries (20 000) and by wall time (2 s per workspace). When a
  cap is hit, the measurement is a lower bound and is flagged `truncated`; the quota decision uses it
  as it is, so a workspace that only looks big is never silently ignored.
- The whole sweep stops after 15 s and the rest of the page waits for the next rotation. Two
  overlapping ticks share one sweep.

The caps exist for the same reason the workspace file list has its own scan cap: these directories
hold `node_modules` with tens of thousands of entries, and the walk runs on the shared scheduler.

### The signal

Two activity actions, both with the actor `workspace_hygiene_sweep`, neither with a host path:

| Action | Entity | Details |
|---|---|---|
| `workspace.quota_exceeded` | `execution_workspace` | `workspaceId`, `workspaceName`, `sizeMb`, `quotaMb`, `measuredAt`, `hint` |
| `workspace.total_quota_exceeded` | `instance_settings` | `totalSizeMb`, `totalQuotaMb`, `measuredWorkspaces`, `hint` |

The hint names the two moves that free the disk: delete the workspaces whose work is already merged,
or re-provision, which takes `node_modules` from the shared store instead of keeping a private copy.

## The quotas

Both quotas are off by default: an instance that sets nothing is never signalled.

| Value | Where | Meaning |
|---|---|---|
| `workspaceQuotaMb` | `instance_settings.general.workspaceHygiene` | ceiling for one execution workspace |
| `totalQuotaMb` | the same row | ceiling for the sum of the measured workspaces of one company |

Precedence per value: the stored settings value when the row holds a canonical object, otherwise the
environment variable, otherwise the default (`off`). The stored object always carries both keys, each
`null` (off) or a positive integer; a hand-edited row that does not match is ignored as a whole.

| Environment variable | Default | Notes |
|---|---|---|
| `MYRMIDON_WORKSPACE_QUOTA_MB` | not set (off) | default for the first start; empty, `0`, negative or non-numeric means off |
| `MYRMIDON_WORKSPACE_TOTAL_QUOTA_MB` | not set (off) | the same |

Production values live in the closed `myrmidon-deploy`, not here.

### The API

`GET /api/myrmidon/workspace-hygiene` (any board member) reports:

- `quota` — both values in force and the source of each (`settings` / `env` / `default`);
- `workspaces` — what the sweep last measured, biggest first: `id`, `name`, `status`, `sizeBytes`,
  `sizeMb`, `measuredAt`, `overQuota`, `truncated` (up to 200 rows, from the stored measurements, so
  the read never walks a disk);
- `status` — measured workspaces, over-quota count, total size in MB, the time of the last sweep of
  this process and that sweep's own counters.

`PATCH /api/myrmidon/workspace-hygiene` (instance admin) takes any subset of
`{ "workspaceQuotaMb": number|null, "totalQuotaMb": number|null }`, writes the settings row, records
the change in the activity log for every company (`instance.workspace_hygiene.updated`, with the
previous and the next value) and returns the report above. Nothing has to be applied to a running
object: the sweep reads the quotas at the top of every tick, so the next tick uses the new value.

A settings panel in the UI is **not** part of this feature; the endpoint is the minimum a panel or a
script needs.

## Verifying a change

```sh
pnpm --filter @paperclipai/server exec vitest run src/myrmidon/workspace-hygiene
pnpm --filter @paperclipai/shared exec vitest run src/myrmidon-workspace-hygiene.test.ts
```

`server/src/myrmidon/workspace-hygiene/sweep.myrmidon.test.ts` holds the acceptance cases: an
over-quota workspace is signalled once a day (not once a tick), a fresh measurement is not repeated,
the rotation covers every page, the sweep gives up at its time budget, and the company total is
signalled once per window. `measure.myrmidon.test.ts` builds real trees for the caps and the hardlink
rule. `routes.myrmidon.test.ts` covers permissions, validation and the audit record.

## Divergence

Every file of the vendor this feature touches, and the reason, is in `DIVERGENCE.md` (`WH-C`). The
settings values are listed in `SETTINGS.md`.