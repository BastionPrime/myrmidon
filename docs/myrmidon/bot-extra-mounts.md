# Bot containers: extra read-only mounts

A bot container gets exactly three volumes from the driver: `/data/hermes`,
`/workspace` and `/scratch`. Everything a bot needs beyond that — shared source
trees, templates, common tools — used to be copied into each bot's
`/workspace/shared`, so every source update had to be pushed to every bot again.

This feature lets a card mount an operator-approved host directory into the
container as an extra **read-only** volume. The bot sees the files where they
live on the host; nothing is copied, and the bot cannot write to them.

Russian version: [bot-extra-mounts.ru.md](bot-extra-mounts.ru.md).

## Instance setting: `MYRMIDON_BOT_MOUNT_SOURCES`

The whitelist of host directories a card may mount. A comma-separated list of
absolute paths:

```
MYRMIDON_BOT_MOUNT_SOURCES=/srv/shared/sources,/srv/shared/tools
```

* Unset or empty means **no extra mount is allowed** (fail-closed).
* A card can only name a directory from this list, and only by its exact path —
  there is no prefix rule, so naming `/srv/shared` does not allow
  `/srv/shared/sources`.
* The value is read at server start (`startBotContainers`, W2a). Changing it
  takes effect for the next reconcile pass; a bot whose mount set changes is
  recreated, because the bind list is part of the container template.

## Card setting: `adapterConfig.container.extraMounts`

```jsonc
{
  "container": {
    "enabled": true,
    "image": "ghcr.io/example/runtime@sha256:…",
    "memoryMb": 2048,
    "cpus": 1,
    "pidsLimit": 512,
    "extraMounts": [
      { "source": "/srv/shared/sources", "path": "/srv/shared/sources", "readOnly": true }
    ]
  }
}
```

* `source` — an absolute host directory; it must be listed in
  `MYRMIDON_BOT_MOUNT_SOURCES`.
* `path` — the absolute mount point inside the container.
* `readOnly` — optional, defaults to `true`. `false` is refused: a shared
  directory is never mounted writable.
* A missing `extraMounts` means the bot keeps its three fixed volumes only.

The driver builds the bind as `host:container:ro` and appends it after the three
fixed binds. The helper containers that prepare the volumes and apply the profile
never get an extra mount — they only touch the three bot volumes.

## What is refused, and why

| Rule | Reason |
|---|---|
| source is not in `MYRMIDON_BOT_MOUNT_SOURCES` | the card must not reach a host directory the operator did not name |
| source is relative, has `..`, `//`, a trailing `/`, a backslash, a control character, or is `/` | two spellings of one directory would compare unequal, and `/` would hand over the host |
| `readOnly` is `false` | extra mounts are read-only by design |
| `path` is relative, unsafe, or is `/data/hermes`, `/workspace`, `/scratch`, `/tmp`, or a path inside one of them | the driver's own mounts and the image's tmpfs must not be shadowed |
| the same `path` is used twice | Docker would refuse the create anyway |

A refused mount is an error of the reconcile pass (visible in the activity log);
the container is not created with it and the existing container is left alone.
Failure messages name the field, never a secret.

## dockergate

In production the board talks to the Docker daemon through
[dockergate](dockergate.md), which rebuilds every create body from its own
configuration and compares the bytes. Two things changed there:

* the configuration gained `mountSources` — the same list of host directories,
  enrolled on the dockergate side as well;
* a create body for a bot may now carry, after its three fixed binds, only
  read-only binds (`source:path:ro`) whose source is in `mountSources` and whose
  target is a safe container path. Anything else is denied with
  `mount_source_not_allowed` (source not enrolled) or `binds_mismatch`
  (not read-only, reserved target, duplicate target, wrong order).

The helper forms still require exactly the three binds.

## What the reviewer should check

* `buildBinds` appends `…:ro` for an allowlisted mount and throws for one that
  is not (server unit tests).
* `docker-driver` puts the extra mount into `HostConfig.Binds`, and
  `containerTemplateDrifted` reports a drift when the bind list changes (so a
  card edit recreates the bot).
* dockergate accepts an allowlisted read-only extra bind end to end and denies a
  source outside `mountSources` before anything reaches the daemon.

## Not in this change

* A writable extra mount (a shared directory that several bots write to needs its
  own design: ownership, locking, concurrent apply).
* Per-project (direction) defaults for `extraMounts`: the setting lives on the
  agent card, not on a project.
* A UI field for `extraMounts` in the card's Container section — the value is
  entered in `adapterConfig` for now.
* Mounting a single file (only directories are supported), and any mount whose
  source does not exist on the host (Docker would create it as root, 0755).