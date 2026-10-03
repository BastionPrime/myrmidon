# Stack updates

> Russian version: [stack-updates.ru.md](stack-updates.ru.md)

The stack-update cycle is how the board watches the releases of every component the
deployment runs on — the board itself, its upstream, the shared services around it — and
turns what it sees into a plan you can act on. One cached document holds the whole picture:
our side (what actually runs here), the upstream side (what the authors released), the
comparison between the two, and the verdict on the patches we carry. The operator surface
is the «Stack» screen (Company → Stack), the release-check sweep, and a backlog draft that
schedules an update.

The screen-by-column, button-by-button description of the «Stack» screen lives in
[guides/stack-registry.md](guides/stack-registry.md) — this document is the cycle around
it: where each number comes from, how the comparison works, what the patch-closed verdict
means, and what happens when the network is gone.

## The two sides of the table

### «Ours»: what actually runs here

The local side of every component is filled by a refresh (`POST /api/myrmidon/stack/refresh`
or the *Refresh data* button, instance admin). What a refresh records depends on the
component's probe:

- `health-commit` (the board itself): the build commit from the same server-info snapshot
  `/api/health` reports — one truth for the board version. When git metadata is
  unavailable the component is an honest `unknown`
  (`board build commit unavailable (<reason>)`).
- `docker-image`: image inspection over the Docker unix socket (the path in
  [`MYRMIDON_STACK_DOCKER_SOCKET`](SETTINGS.md)); the first repo tag becomes the version,
  the first digest becomes the digest, and the running location is recorded.
  An image absent on the host is `unknown`
  (`image not present on the Docker host reachable from the board`), not a failure.
- `container-labels`, `env`, `manual`, `none`: reported as `unknown` with a fixed reason
  (`no matching container labels found`, `no version override configured`,
  `managed by the operator; no automatic probe`, `not visible from the board server
  process`) — the local value of such a component is the operator's to know.

### «Latest»: what the authors released

The upstream side is filled by a release check (`POST /api/myrmidon/stack/check`, the
*Check releases* button, or the scheduled sweep). It covers the components whose release
source is `github-releases` or `github-tags`; `registry`, `package` and `manual` sources
stay `unknown` — the check does not read them. The check reads the anonymous, unauthenticated
release or tag list from public GitHub (30 entries per page, 10-second timeout, no tokens)
and records:

- the latest upstream release (the newest entry of the feed);
- how many releases we are behind — counted only when our version appears in that feed;
  an unknown or unmatched local version gives an honest `unknown`, never a guess;
- the notable lines of the release notes (below).

A refresh never wipes the upstream side: the release-check state is carried over by
component name, so re-reading the local state after a deploy keeps the last release
comparison.

## The comparison: lag and notable lines

### Behind

`Behind` is the number of upstream releases between ours and the latest. It is counted
only when the running version matches an entry of the release feed — a version that is
not part of the feed (a fork build, a digest-only component, an operator-set version)
reads `unknown`. A component with `Behind` ≥ 1 counts as lagging: it sorts to the top of
the screen and gets the *Schedule update* button.

### Notable lines

The release check keeps the release-note lines that mention security, vulnerabilities,
CVEs, breaking changes or deprecations: the five newest, each trimmed, with a note when
the excerpt was truncated. Lines are skipped, not the whole note: an ordinary release
with one security line still surfaces that line. An excerpt that carries any
security-marked line is flagged — on the screen with a shield icon, and on the attention
card with high severity.

## The patch-closed verdict

We carry deltas on top of some upstream components. Each recorded delta carries the
version we pin it on and the upstream commits that fix it (the `fixCommits` list, seeded
in the registry). On every release check each delta is evaluated against the range
between our version and the upstream latest through the GitHub compare API:

- `closed` — the compare range already contains a fix commit: the delta can be dropped
  on the next update;
- `open` — the fix commit is not in the range yet: the delta must be carried or re-based;
- `unknown` — the verdict could not be computed: no upstream release known yet, our
  version unknown, no fix commit recorded, or the compare range unavailable
  (a 404 or an HTTP error from the compare API).

The overall verdict per component is the aggregate: all deltas closed → `closed`; any
delta unknown → `unknown`; otherwise `open`. The verdict, its reason and the per-delta
state are shown in the *Patches* column of the screen and copied into the default update
plan, so the person planning the update knows exactly which deltas to re-check.

## The daily sweep and the manual check

The release check has two triggers running the same code:

- **The scheduled sweep** behind [`MYRMIDON_STACK_CHECK_INTERVAL_SEC`](SETTINGS.md).
  Off by default: unset, empty, `0`, negative or non-numeric all mean off — the board
  touches the network only when an operator sets the interval. A valid interval below
  60 seconds is lifted to 60 (never hammer the release sources). The sweep runs one check
  immediately on start, then on the interval; an overlapping run is skipped, and a failed
  sweep is logged and retried on the next tick.
- **The manual check** — `POST /api/myrmidon/stack/check` (instance admin) or the
  *Check releases* button: the same comparison, on demand, with the fresh document
  returned in the response.

## What a lagging component raises

Every component the check counts as lagging (`Behind` ≥ 1) or that got a new latest
release since the previous check surfaces on the operator desk («Waiting for me») as a
`stack_update` card: the component, the latest, our version, the lag, the patch verdict
and the release-note excerpt (bounded). Severity is high when the excerpt carries
security lines, medium otherwise. The card is deduplicated by
`stack:<component>:<latest>` — a check that does not change the latest does not raise a
new card — and it does not link to the «Stack» screen (the card's subject has no
`href`); the screen and the card read the same cached document.

## Scheduling an update

A lagging row on the screen carries *Schedule update*. The dialog opens with a default
plan — the versions (ours, latest, lag, release source), the patch verdict with every
delta's state, the notable upstream lines, the canary-then-production rollout order and
the rollback step — and both the title and the plan are editable. *Create draft task*
creates an **unassigned backlog task** through the regular issue-creation route; nothing
is deployed and nothing is assigned by the screen. The draft becomes an update when
someone picks it up, plans it and runs the regular deploy flow ([deploy.md](deploy.md)).

## Settings

Both variables, their defaults and failure behavior are in [SETTINGS.md](SETTINGS.md):

| Variable | Default | Meaning |
|---|---|---|
| `MYRMIDON_STACK_DOCKER_SOCKET` | `/var/run/docker.sock` | The Docker unix socket for the local image probes; read on every refresh, no restart needed |
| `MYRMIDON_STACK_CHECK_INTERVAL_SEC` | unset (off) | The release-check sweep interval; off unless set, minimum 60 s |

## When the network is down

Both write routes keep the previous cache on failure:

- a **transport** failure (no network, DNS, timeout) during a check fails the whole
  request with **503** — the previous cache stays intact and readable;
- an **HTTP error** from one release source (a repository gone, rate limited) is ordinary
  data: that component is recorded `unknown` with the status (`github 403`), the rest of
  the check succeeds;
- a broken Docker probe on refresh answers **503** the same way — the last good document
  survives, and the screen shows the error in place without losing the table.

A network outage never takes the board down: reads keep serving the last cached state,
and the next successful check or refresh brings the document back to date.

## Where the code lives

- `server/src/myrmidon/stack-registry/` — the registry: the seed and model
  (`domain.ts`), the local probes (`collector.ts`), the release check
  (`check.ts`, `releases.ts`), the attention cards (`attention.ts`), the settings
  (`settings.ts`), the routes (`routes.ts`), the cache (`store.ts`);
- `ui/src/components/myrmidon/stack/` — the «Stack» screen and its presentation helpers;
- the routes are mounted in `server/src/app.ts` (marked `myrmidon(SUA)`), the sweep in
  `server/src/index.ts` (marked `myrmidon(SUB)`), the screen in `ui/src/App.tsx`
  (marked `myrmidon(SUC)`, route `/stack`);
- the API and the storage (the `myrmidonStack` key of `instance_settings.general`) are
  documented in [guides/stack-registry.md](guides/stack-registry.md).
