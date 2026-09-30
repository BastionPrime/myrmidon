# Per-agent sandbox: overhead measurement and the decision record

> Russian version: [sandbox-per-agent.ru.md](sandbox-per-agent.ru.md)

Revision of 30.09.2026, for release 1.3, item S3-A. This document records the
facts behind the per-agent sandbox question, the measurement method, and the
decision that the owner issued. It is not the sandbox implementation: the
implementation item (S3-B) is superseded by this decision and stays in the
"Later" section as a marker.

## 0. Summary

- Once the fleet moved into containers, a question arose: does an agent need a
  separate sandbox, and in what form. Two candidates: a separate uid per profile
  inside the project container (process multiplexing) or a separate container
  per bot.
- A measurement on the live development fleet shows: **container overhead is
  ~0.34 MiB; one idle node runtime process costs ~10.04 MiB** (9.70 MiB on top
  of the empty-container floor). The cost is driven by the agent runtime, not
  by the number of containers.
- Practical conclusion behind the decision: memory is no longer an argument
  against "one container per bot". The choice of form is a question of
  privilege isolation and operations, not of memory.
- Decision: a separate per-agent sandbox is not needed — the container itself
  is a sufficient isolation boundary. The target form is one container per
  bot (option B). The topic returns after 1.4.

## 1. Context

Before the move to containers, agents ran as profiles on the host, and profile
isolation rested on filesystem permissions. Moving to containers changes the
boundary: a container is already a kernel isolation boundary (cgroups,
namespaces), and the question "do we need a second boundary inside it" became
open.

The release 1.3 plan records this question as a separate process item: ask the
owner whether a per-agent sandbox is needed after the move to containers, and
in which form, with a memory measurement for each option. Implementation is not
part of the release.

## 2. Two sandbox forms

### Option A: a separate uid per profile in the project container

All profiles of a direction live in one project container; each profile gets
its own uid, with permissions on the working directory and `HERMES_HOME` set to
0600/0700.

Advantages:

- one image and one container per direction;
- total memory = the sum of runtimes, with no multiplying factor;
- a shared page cache of the image for all profiles of the direction.

Disadvantages:

- isolation only at the unix-permissions level: profiles see each other's
  processes, the shared PID namespace does not separate them;
- CPU/memory limits are shared across the container: one heavy profile affects
  its neighbours;
- a mistake in directory permissions gives side-by-side profiles access to
  each other's files.

### Option B: one container per bot

Each agent gets its own container from the same image, with CPU/memory limits
per container.

Advantages:

- kernel isolation between bots: separate cgroups, separate PID namespaces,
  separate limits; kill/restart of one bot does not touch its neighbours;
- direct per-agent memory/CPU telemetry with no nested counters;
- rollback and update of a single bot, independently of its neighbours.

Disadvantages:

- each bot runs its own copy of the runtime process (see the measurement:
  ~10.04 MiB per idle process, 9.70 MiB on top of the container floor);
- more entities to operate: as many containers as there are bots.

## 3. Measurement method and results

The measurement was taken on the live development fleet (working containers of
development team sessions, node:24-alpine image, cgroup v2, `memory.current`).
The controlled part: clean containers from the same image with different
numbers of runtime processes, three repeats per point; containers were
recreated between points.

Figures:

- one container, 0 processes: **352,256 bytes (~0.34 MiB)** — the container
  floor (cgroup structures, page tables, mounted layers);
- one container, 1 process: **10,526,720 bytes (~10.04 MiB)**;
- one container, 2 processes: **20,692,992 bytes (~19.73 MiB)**;
- one container, 3 processes: **30,851,072 bytes (~29.42 MiB)**;
- three containers with 1 process each: **10,326,016 bytes (~9.85 MiB) each** —
  identical across all three.

Conclusions from the figures:

1. Container overhead ≈ 0.34 MiB — three hundredths of the cost of one idle
   runtime. Against the working loads (see below) this is noise.
2. Memory in option A grows linearly with the number of profiles — and in
   option B likewise with the number of bots; there is no skew towards A:
   **the per-bot memory difference between the options is ≈ 0.34 MiB plus the
   share of unused shared pages**.
3. Idle runtimes (~10 MiB) are the lower bound; working containers with real
   sessions show 131–771 MiB depending on load, so the real memory consumer is
   the agent session itself, not the sandbox form.

Live fleet (working session containers, same image): idle ~131 MiB, an active
session 612→771 MiB over half an hour of work. The production migration waves
are still under way, so this figure is an order-of-magnitude guide: on fleets
of dozens of bots it multiplies by the number of bots regardless of the option.

## 4. Decision

Decision (issued by the owner): **a separate per-agent sandbox is not needed —
the container is a sufficient isolation boundary. The target form is one
container per bot (option B). The topic returns after 1.4.**

Target parameters for B (guidelines, to be refined after the migration waves):
the per-container memory limit follows the bot's actual working set from wave
telemetry; the image floor is not counted in the limit (image pages are
shared). The CPU limit guideline is 1.0 per container; the average consumption
of an idle container was not measured in this pass (the pass covered memory
only), so the concrete value is refined from wave telemetry together with the
memory limit.

## 5. What this document does not cover

The sandbox implementation item (S3-B) — agent access only to its own
`HERMES_HOME` and workspace — is **superseded by this decision** and stays in
the "Later" section as a marker. Network isolation and the egress proxy are a
separate release 1.3 item and are not discussed here.
