# Stack registry

> Russian version: [stack-registry.ru.md](stack-registry.ru.md)

The stack registry is the board's single list of the components the deployment
runs on: the board itself, its upstream, the shared services around it. For
every component the registry records what the board server process can see
locally — a version, a commit, an image digest, or an honest «unknown» with a
reason. This is part A of the stack-update track (SUA); comparing against
external releases is part B (SUB), and the «Stack» screen described below is
part C (SUC).

## The «Stack» screen (Company section)

The registry the server caches is visible in the panel: **Company → Stack**
(route `/stack`, next to Activity in the sidebar Company section; an entry
`Stack` with the layers icon). It reads `GET /api/myrmidon/stack` — the cached
document, no probe runs on open — and renders one row per component with a
name filter above the table. Lagging components are sorted to the top, the
further behind first, then by name.

The two header lines under the title show when the local state was last
refreshed and when the releases were last checked (`never` before the first
run of each).

Columns:

| Column | What it shows |
|---|---|
| `Component` | The component name and, under it, how its local state is discovered (`Board build commit`, `Docker image`, `Container labels`, `Environment override`, `Operator set`, `Not visible from the board`) |
| `Release source` | Where the upstream latest comes from (`GitHub releases`, `GitHub tags`, `Registry`, `Package`, `Manual`) |
| `Ours` | Our running version, short commit (first 12 characters) and image digest joined with `·`; when none is known — `unknown` with the stored reason |
| `Runs on` | Where the component runs, if the probe recorded it; otherwise `unknown` |
| `Latest` | The latest upstream release from the release check; `unknown` before the first check |
| `Behind` | How many upstream releases we are behind; `unknown` when the check did not count it |
| `Patches` | The overall «is our carried patch closed upstream» verdict (`closed` / `open` / `unknown`, see [stack-registry.md](stack-registry.md#release-check-and-the-patch-closed-verdict)), the per-patch state line, and the collapsible *Notable lines* excerpt |
| `Actions` | *Schedule update* on lagging rows (see below) |

The *Notable lines* toggle expands the security/breaking lines captured from
the upstream release notes (top 5, each truncated) with a note when the
excerpt was truncated. A shield icon on the toggle marks excerpts that carry
security lines.

The screen never probes anything on its own: it renders the cache. Data is
loaded or re-loaded with the two buttons next to the filter:

- **Refresh data** — `POST /api/myrmidon/stack/refresh` (instance admin,
  [stack-registry.md](stack-registry.md)): rebuilds the local state, the
  cached document on success updates the table. While the request runs the
  button shows *Refreshing...*.
- **Check releases** — `POST /api/myrmidon/stack/check` (instance admin, part
  B): the same comparison the scheduled sweep runs, on demand; the table
  re-renders with the new latest, lag and notable lines. While the request
  runs the button shows *Checking releases...*.

A failed request — including the **503** a broken Docker probe or a network
failure produces — is shown in place as an error line (*The stack request
failed: <message>*); the page keeps the last rendered table and never crashes.
For what each failure means, see the failure rules in
[stack-registry.md](stack-registry.md) (the refresh) and the release-check
notes below.

## Scheduling an update

A row the release check counted as lagging (`Behind` is at least 1) carries a
**Schedule update** button. It opens a dialog with:

- a *Task title*, pre-filled `Update <component> to <latest>`;
- a *Plan*, pre-filled with the default update plan: the versions (ours as
  version/commit/digest or `unknown` with the reason, the upstream latest, the
  lag, the release source), the overall patch verdict with the reason and the
  per-patch state of every carried delta, the notable upstream lines, the
  canary-then-production rollout order, and the rollback step (redeploy the
  previous image digest, re-check health before resuming traffic).

Both fields are editable before anything happens. **Create draft task** posts
the existing `POST /api/companies/:id/issues` with `status: "backlog"` and the
title and description as edited — an unassigned backlog draft, no assignee, no
`draft` status exists on the board. On success the dialog shows
`Draft task created: <identifier>` (the issue identifier, or its id when no
identifier exists); a failure is shown in place (*The task could not be
created: <message>*).

Nothing is deployed by the dialog: it only creates the task. The draft becomes
an update only when someone assigns it, plans it and runs the regular deploy
flow.

The attention card a lagging component raises on the operator desk (part B
signal `stack_update`) does not link to this screen — the card's subject has
no `href`. The screen and the card are read from the same cache.

## Release check and the patch-closed verdict

The upstream side of the table (`Latest`, `Behind`, the notable lines, the
patch verdict) comes from the release check: the scheduled sweep behind
`MYRMIDON_STACK_CHECK_INTERVAL_SEC` (off by default; see
[SETTINGS.md](../SETTINGS.md)) or the manual `POST /api/myrmidon/stack/check`
(the **Check releases** button). For every component with a
`github-releases`/`github-tags` source it reads the anonymous release or tag
list, records the latest, the number of releases ahead of our version and the
notable note lines (security/breaking/CVE, top 5, each truncated), and
evaluates the «is our carried patch closed upstream» rule through the GitHub
compare API. A network or transport failure answers **503** and keeps the
previous cache; an HTTP error from a source is recorded per component. A
`stack_update` attention card (severity high when the excerpt has security
lines, medium otherwise) is raised for every lagging component and on a new
latest, deduplicated by `stack:<component>:<latest>`.

## What the registry contains

The component list is seeded in code (`server/src/myrmidon/stack-registry/domain.ts`,
`STACK_SEED`) and currently covers: `paperclip`, `myrmidon`, `hermes-agent`,
`litellm`, `ragflow`, `hindsight`, `langfuse`, `clickhouse`, `zabbix`,
`playwright-chromium-mcp`, `dockergate`, `media-tools`, `base-images`,
`proxmox-ve`, `node-os`.

Each component entry carries:

- `name`, `releaseSource`, `upstream` — neutral public coordinates of the
  component (no hosts, no internal identifiers);
- `localProbe` — how the local state is discovered: `health-commit` (the board
  itself, from the same snapshot `/api/health` uses), `docker-image` (image
  digests over the Docker unix socket), `env`, `manual`, `container-labels`,
  `none`;
- `local` — the probed state: `version`, `commit`, `digest`, `runningOn`,
  `checkedAt`, and `unknownReason` when the probe produced no value;
- `local.patches` — deltas we carry on top of upstream; starts empty, filled
  by part B.

## API

Both routes live under `/api`:

- `GET /api/myrmidon/stack` — returns the cached document. Any board actor
  with company access can read it; agents and anonymous callers get 403.
  Before the first refresh the route returns the seed view: every component
  with `local.unknownReason: "not refreshed yet"` and `refreshedAt: null`.
- `POST /api/myrmidon/stack/refresh` — rebuilds the local state and rewrites
  the cache. Instance admins only: agent tokens and non-admin board members
  get 403, nothing is written.

```sh
curl https://board.example.com/api/myrmidon/stack \
  -H "Authorization: Bearer ***"

curl -X POST https://board.example.com/api/myrmidon/stack/refresh \
  -H "Authorization: Bearer ***"
```

What a refresh collects:

- the board component (`myrmidon`) gets the build commit from the same
  server-info snapshot `/api/health` reports — one truth for the board
  version; if git metadata is unavailable, the component degrades to an honest
  unknown (`board build commit unavailable (<reason>)`);
- every `docker-image` component is probed through the Docker API
  (`GET /images/{ref}/json`, API version `v1.45`, 10-second timeout) over the
  unix socket; the first found repo tag becomes `version`, the first digest
  becomes `digest`;
- `manual`, `env`, `container-labels` and `none` components are reported as
  unknown with a fixed reason (for example `managed by the operator; no
  automatic probe`, `not visible from the board server process`).

Failure rules:

- a broken infrastructure probe — the Docker socket is unreachable or the
  daemon answers with an error — fails the whole refresh with **503** and
  keeps the previous cache; the response body carries the error and the last
  stored document;
- an image that is simply absent on the host is **not** a failure: the
  component is recorded as unknown (`image not present on the Docker host
  reachable from the board`) and the refresh succeeds.

## Storage

The cache lives in `instance_settings.general` under the `myrmidonStack` key —
no migration. Writes follow the maintenance-mode scheme (row lock plus
`jsonb_set`), and the vendor `updateGeneral` carries the key over unchanged,
so a settings save from the UI cannot drop the registry cache.

## Configuration

One variable, [`MYRMIDON_STACK_DOCKER_SOCKET`](../SETTINGS.md): the path to
the Docker unix socket the image probes use. Default `/var/run/docker.sock`;
read on every refresh, so a change takes effect on the next
`POST /api/myrmidon/stack/refresh` without a server restart. If the board
server cannot reach a Docker socket at all, leave the default — refreshes will
answer 503 and the seed view (or the last good cache) stays readable.

## Operator notes

- Run `POST /api/myrmidon/stack/refresh` after a deploy to update the board
  commit and the image digests; until the first refresh, the GET route shows
  the seed view with `unknownReason: "not refreshed yet"`.
- A 503 on refresh means the Docker probe failed, not that the registry is
  lost — check that the board container mounts the socket named by
  `MYRMIDON_STACK_DOCKER_SOCKET` and that the daemon answers.
- The registry never contacts external release feeds in part A — the release
  check (part B) reads them: on demand with the *Check releases* button or on
  the schedule behind `MYRMIDON_STACK_CHECK_INTERVAL_SEC`.
- The operator reads the registry more comfortably on the «Stack» screen
  (Company → Stack): the same data, the refresh/check buttons and update
  scheduling — see the sections above; curl stays for scripts.
- The board row is SUA in [../DIVERGENCE.md](../DIVERGENCE.md); the routes are
  mounted in `server/src/app.ts` (marked `myrmidon(SUA)`), the module is
  `server/src/myrmidon/stack-registry/`; the screen is marked `myrmidon(SUC)`
  in `ui/src/App.tsx` (route `/stack`) and lives in
  `ui/src/components/myrmidon/stack/`.
