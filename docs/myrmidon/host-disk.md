# Host disk usage: the signal before the disk is full

On 03.10.2026 the host disk of the board filled to 100 % and the board fell over before anything
warned about it. Part E of BOT-DISK is the earliest warning: the board measures the fill level of
its own host disk on every scheduler tick, and when it crosses a threshold — 85 % by default —
the attention queue gets one signal with the numbers and the biggest consumers.

The parts of BOT-DISK are one feature, split by what they do: A makes workspaces smaller, B
removes the ones nobody needs (see [workspace-hygiene.md](workspace-hygiene.md)), C caps the
per-workspace quota, E says the disk itself is filling up while all of that is still not enough.

## The problem in one line

The board can see every workspace and every budget, but the one number that actually kills the
server — the fill level of the host disk — was visible only on the host, by ssh, after the fact.

## How it works

`createHostDiskScheduler` runs from the server's scheduler tick, next to the workspace hygiene
sweep. One tick does one measurement:

1. Read the threshold in force from `instance_settings.general.hostDisk` (environment first
   start, see [SETTINGS.md](SETTINGS.md)).
2. `statfs` the data root (`MYRMIDON_HOST_DISK_DATA_ROOT`, `/data` by default): capacity, free
   bytes, used percent.
3. Push the sample into a ring (24 by default) and compute the growth rate per hour: the slope
   between the oldest and the newest sample of the window. After a restart the first hour has no
   growth number yet; the signal says "not enough samples" instead of inventing one.
4. When usage crosses the threshold, walk the consumer directories
   (`MYRMIDON_HOST_DISK_CONSUMER_PATHS`) with the same bounded walk the workspace measurement
   uses (depth, entries, wall time; never following a symlink) and write one line into the
   activity log — at most once per 6 hours, anchored on the newest line of the same action.
5. The attention feed adds one `host_disk_alert` row for the whole instance while the threshold
   stays crossed: fill level, free space, growth per hour, biggest consumers, ranked critical at
   95 % and high below.

The sweep is a signal, not a reaper: it never deletes anything.

## The settings, without a restart

The threshold changes on the Instance → General page («Host disk») or through
`GET`/`PATCH /api/myrmidon/host-disk`, and applies on the next measurement: the sweep re-reads
the stored value at the top of every tick. Precedence: the stored settings row, then the
environment variable, then the default (85). A hand-edited row that does not validate is ignored
as a whole.

## What the measurement is, and what it is not

- `statfs` reports the filesystem of the data root as the server process sees it. When the board
  runs in a container with host bind mounts, that is the host disk; a volume driver that reports
  a different filesystem reports its own numbers, which is still the disk that fills first from
  the server's point of view.
- The consumer sizes are the apparent sizes of a bounded walk — a lower bound for a directory
  the walk could not finish. A ranking does not need to be exact; the numbers in the signal are
  rounded to whole gigabytes.

## Where the code lives

| What | Where |
|---|---|
| shared settings, samples, growth | `packages/shared/src/myrmidon-host-disk.ts` |
| measurement (`statfs`, bounded walk) | `server/src/myrmidon/host-disk/measure.ts` |
| the sweep and the signal interval | `server/src/myrmidon/host-disk/sweep.ts` |
| read/patch service | `server/src/myrmidon/host-disk/service.ts`, `routes.ts` |
| wiring, scheduler step | `server/src/myrmidon/host-disk/index.ts` |
| the attention item | `server/src/services/attention.ts` (`host_disk_alert`) |
| the settings panel | `ui/src/components/myrmidon/HostDiskSettingsPanel.tsx` |
