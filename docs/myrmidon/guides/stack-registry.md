# Stack registry

> Russian version: [stack-registry.ru.md](stack-registry.ru.md)

The stack registry is the board's single list of the components the deployment
runs on: the board itself, its upstream, the shared services around it. For
every component the registry records what the board server process can see
locally — a version, a commit, an image digest, or an honest «unknown» with a
reason. This is part A of the stack-update track (SUA); comparing against
external releases and the update panel arrive in later parts.

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
- The registry never contacts external release feeds in part A; the
  `releaseSource` and `upstream` fields are informational until part B.
- The board row is SUA in [../DIVERGENCE.md](../DIVERGENCE.md); the routes are
  mounted in `server/src/app.ts` (marked `myrmidon(SUA)`), the module is
  `server/src/myrmidon/stack-registry/`.
