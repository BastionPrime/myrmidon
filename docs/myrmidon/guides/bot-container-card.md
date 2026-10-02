# Bot container: the agent card's Container section

> Russian version: [bot-container-card.ru.md](bot-container-card.ru.md)

An agent with the `hermes_gateway` adapter can run inside a Docker container
managed by the board. The card's **Container** section holds the settings and
shows the live state of that container.

## What the section holds

| Field | What it sets |
|---|---|
| **Enabled** | Whether the board creates and maintains a container for this agent. |
| **Image** | The container image. Must be on the instance's allowlist. |
| **Memory, MB** | Container memory limit. |
| **CPUs** | Container CPU limit. |
| **PIDs limit** | Maximum number of processes inside the container. |
| **Group** | Container group (not supported yet; shows a warning). |

Additional read-only host directories can be mounted via the JSON card setting
`adapterConfig.container.extraMounts` — see
[bot-extra-mounts.md](../bot-extra-mounts.md).

The section is absent for adapters other than `hermes_gateway` and when the
agent is being created.

## Concurrent runs limit

The card's scheduling policy (`runtimeConfig.heartbeat.maxConcurrentRuns`) sets
how many runs of this agent may be active at once. The board normalizes the
value to the range 1–50 (default: the platform's built-in default) and writes
it into the bot's `config.yaml` as `gateway.api_server.max_concurrent_runs`.

The **Concurrent runs limit** block compares what the board asks for with what
the bot's gateway was actually given:

- **Board** — the card's normalized value.
- **Gateway** — the value recorded in the container's applied-profile marker
  (`applied.json`), or **not reported yet** when the marker does not carry the
  number (a container created before this recording existed, or an unreadable
  marker). The next reconcile pass rewrites the marker without restarting the
  gateway.

When the two values differ, the block shows a **Diverged from the board** badge.
Divergence means the gateway is running with a different limit than the card
asks for; the next profile apply (reconcile or **Apply now**) brings them back
into sync.

### Gateway not managed by the board

For an agent whose gateway runs outside the board's containers (containers
switched off on the card, or the instance has no bot containers), the block
shows **Gateway: not managed by the board**. The board cannot read or apply
the external gateway's own limit; it can only show the card's value.

If the board's limit is above 1 and runs of this agent have recently been
answered with HTTP 429 by the external gateway, the block also shows a
warning: the gateway is holding runs back below what the card asks for.

## Apply now

The **Apply now** button forces an immediate reconcile pass for this agent's
container: the profile is recompiled from the current card and written to the
container. Use it after editing the card when you do not want to wait for the
next periodic reconcile.

The pass — whether started by **Apply now** or by the periodic sweep — re-reads
the agent's card at pass time, inside the per-bot lock, and builds the spec
from that fresh card rather than from a snapshot taken earlier. A card edit
followed by **Apply now** cannot be undone by a reconcile pass that started
before the edit: passes of the same bot are ordered by the lock, and the later
pass sees the card as it is at that moment, so the applied template is always
the current one.

A card that can no longer be read at pass time fails the pass (**error**)
instead of silently falling back to the older snapshot; the next pass retries.
A card that has stopped qualifying for a container (containers switched off,
a different adapter, invalid limits) makes the pass **not applicable** — the
same answer as if such a card had been passed to **Apply now**.

The bot image canary drives its rollout image through this same pass: the
rollout's image replaces the card's image for that pass (`specImage`), while
limits and mounts still come from the freshly read card — the override
survives the fresh read. See [design/bot-canary.md](../design/bot-canary.md)
(Russian).

## Status and errors

The section shows the container's state as a label: **Running**, **Stopped**,
**Unhealthy**, or **Not created yet**. The image name is shown next to it.

When the container runtime does not answer, the section shows
**Container status unavailable: …** and the **Concurrent runs limit** block
disappears entirely — no comparison is possible without an applied state to
read.
