# Myrmidon

Myrmidon is a control plane for companies of AI agents: a task board, agents and
their runs, MCP tools, chats and routines. It is built for running a large fleet
of agents continuously: runs are not lost, agents are isolated from each other,
and the board can be maintained and upgraded without losing work.

> **Status:** work towards the first release (V1.0) is in progress. There are no
> releases yet and Myrmidon is not ready for production use.

## Relationship to Paperclip

- Myrmidon is based on [Paperclip](https://github.com/paperclipai/paperclip)
  **2026.916.1** and is distributed under the same **MIT** license. The original
  [LICENSE](../LICENSE) (Copyright (c) 2025 Paperclip AI) is kept unchanged; see
  [NOTICE](../NOTICE) for attribution and third-party notices.
- Myrmidon is **not affiliated with or endorsed by Paperclip AI**.
- Package names (`@paperclipai/*`), `PAPERCLIP_*` variables and the `paperclipai`
  CLI keep their names for compatibility and easy upstream updates. They do not
  name this product.
- Stable Paperclip releases are merged weekly. Every difference from upstream is
  listed in [DIVERGENCE.md](../docs/myrmidon/DIVERGENCE.md).
- Myrmidon sends no telemetry to Paperclip: it is off by default and can only be
  enabled with an explicit, operator-owned endpoint.

## What V1.0 adds

- **Run reliability:** environment leases are released, wakeups are not dropped,
  runs start with long task histories, one failing tool does not disable the
  whole MCP catalog.
- **Security:** agent runs do not inherit the server environment, agents cannot
  change their own settings, secret values are masked in logs and messages.
- **Operations:** maintenance mode, deploy by image digest with rollback, weekly
  upstream sync, CI with license and secret scanning.
- **Hermes agents:** board MCP tools inside runs, per-agent skills, per-agent
  model settings.

## Documentation

Project documents are in [`docs/myrmidon/`](../docs/myrmidon/) (in Russian):

- [README](../docs/myrmidon/README.md) — overview and status
- [ROADMAP](../docs/myrmidon/ROADMAP.md) — V1.0 scope and what comes next
- [CONVENTIONS](../docs/myrmidon/CONVENTIONS.md) — how we work
- [DIVERGENCE](../docs/myrmidon/DIVERGENCE.md) — differences from Paperclip
- [SETTINGS](../docs/myrmidon/SETTINGS.md) — `MYRMIDON_*` settings
- [CI](../docs/myrmidon/ci.md) — checks and the container image

Building and running is the same as upstream for now:
[doc/DEVELOPING.md](../doc/DEVELOPING.md), [doc/DOCKER.md](../doc/DOCKER.md).
Requires Node 24 (24.11 or newer) and pnpm 9.15.4. The container image will be
published as `ghcr.io/itkadr-git/myrmidon`.

The upstream Paperclip README is kept as-is in [the repository root](../README.md).
