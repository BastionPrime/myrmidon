# Bot runtime image (G1)

A container image that runs one long-lived `hermes gateway run` process,
serving its OpenAI-compatible API server (`platforms.api_server`) on
`:8642` for the board's `hermes_gateway` adapter to talk to. This is the
per-bot / per-project process described as "variant B" in
`containers-plan-senior-2026-09-28.md` §1.1 — the board itself no longer
spawns or owns hermes processes; it reconciles a desired profile into this
container's volumes and talks to the running gateway over HTTP.

This image does **one** job: run the gateway. It does not run cron, a
dashboard, or any messaging platform other than `api_server`. It has no
Docker socket, no host mounts, and no media tools.

## What's in the image

- Base: `python:3.13-slim`.
- `hermes-agent`, pinned to a git tag (`HERMES_VERSION`/`HERMES_GIT_REF`
  build args, default `0.21.2` / `v2026.9.11`), installed **editable** from
  a clean clone of `https://github.com/NousResearch/hermes-agent` — see
  "Why editable, not pip install" below. hermes tags releases by date
  (`vYYYY.M.D`); `v2026.9.11` is the tag we confirmed (via the GitHub API,
  checking `pyproject.toml` on every recent release tag) actually carries
  `version = "0.21.2"` — the two numbers do not share a scheme, so a future
  version bump needs the same lookup, not an assumed `v<version>`.
- `aiohttp`, pinned to the exact version hermes' own optional extras use at
  this release (`HERMES_AIOHTTP_VERSION`, default `3.14.3`).
  `gateway/platforms/api_server.py` is built on `aiohttp.web`, but aiohttp
  is not one of hermes' core dependencies — most of the extras that pull it
  in also pull in `python-telegram-bot`/`discord.py`/`slack-bolt`, which
  this image does not need. `pyproject.toml`'s `sms` extra resolves to
  exactly `aiohttp==3.14.3` and nothing else, so the build installs through
  `uv sync --frozen --extra sms` — the same hash-verified `uv.lock` path
  every other dependency in this image goes through, rather than a
  separate unlocked `uv pip install aiohttp==...` that could pull an
  untampered-looking but unverified wheel. A build-time check fails loudly
  if that extra ever stops being exactly `aiohttp==${HERMES_AIOHTTP_VERSION}`.
- Bundled skills (`skills/` in the hermes source tree — 14 categories at
  `0.21.2`/`v2026.9.11`), read-only. They are **not** shipped via PyPI package-data
  (hermes' `pyproject.toml` package-data list does not include `skills/**`
  at all — see "Why editable, not pip install"); the editable install
  keeps the full source tree in the image, which is what
  `tools/skills_sync.py`'s `get_bundled_skills_dir()` call resolves
  against via `Path(__file__).parent.parent / "skills"`. We also set
  `HERMES_BUNDLED_SKILLS` explicitly to the same path as a second,
  independent way to find it, in case some other bundled-asset lookup
  turns out not to route through that one call site.
- `tini` as PID 1 (`ENTRYPOINT`), `git`, `ripgrep`, `curl` (health check
  only), `ca-certificates`. No `ffmpeg`, no media tools — forbidden by
  `docs/myrmidon/CONVENTIONS.md` §8; media handling is a separate service
  outside this fork.
- Non-root user, uid/gid `10001`.

## Sealed image: lazy installs and the write-safe root

`/opt/hermes-src` (the venv, the hermes source tree and the bundled skills
under it) is root-owned and read-only for the `bot` user — not a pure
security win on its own, since hermes has its own runtime mechanisms that
assume a writable install by default:

- `tools/lazy_deps.py` installs an opt-in backend's SDK (the native
  `anthropic` provider, `bedrock`, `vertex`, `azure_identity`, the
  `exa`/`firecrawl`/`parallel` web-search backends, TTS/STT, OTLP export,
  …) the first time a bot profile actually uses it. Left unconfigured, it
  installs straight into the (read-only) venv and fails with a raw `uv pip
  install` permission error at that moment, instead of hermes' own clean
  "no writable install target configured" message.
- `agent/file_safety.py`'s write/patch guard (`HERMES_WRITE_SAFE_ROOT`) is
  inert when unset — hermes' built-in file-write tools would then have no
  application-level path scoping beyond raw container filesystem
  permissions (the separate `~/.ssh`/credential-file denylist in the same
  module stays active regardless).

hermes' own upstream `Dockerfile` seals its image the identical way and
sets three `ENV` vars for exactly these two reasons; this image sets the
same three, pointed at the durable `/data` volume instead of upstream's
`/opt/data`:

| Variable | Value | What |
|---|---|---|
| `HERMES_DISABLE_LAZY_INSTALLS` | `1` | Blocks a lazy install into the sealed venv; still allowed when a durable target is configured (below) — see `tools/lazy_deps.py::_allow_lazy_installs()`. |
| `HERMES_LAZY_INSTALL_TARGET` | `/data/hermes/lazy-packages` | Redirects a lazy install to this directory instead (created on first use, under the already-writable `HERMES_HOME`) and appends it to `sys.path` — appended, not prepended, so a lazy package can only add modules, never shadow or downgrade a core one. |
| `HERMES_WRITE_SAFE_ROOT` | `/data:/workspace` | Scopes hermes' own write/patch tools to the durable volume and the workspace, matching upstream's equivalent setting for the same sealed-image posture. |

## Why editable, not `pip install hermes-agent`

`hermes-agent`'s own `setup.py` explicitly refuses to build a wheel or
sdist outside a Nix build:

> pip/PyPI and Homebrew are no longer supported distribution methods for
> Hermes Agent [...] Hermes is distributed via the shell installer, Docker
> image, or Nix. [...] If you are developing, use an editable install
> instead: `uv sync` / `uv pip install -e .`.

So `pip install hermes-agent==0.21.2` from PyPI cannot be relied on for
this hermes release (whether or not PyPI currently happens to serve a
stale wheel from an older release is not something to depend on).
`docker/hermes-gateway-smoke/` in this repo does exactly that, pinned to
`0.17.0` by default — an older release, from before this restriction, and
not what this image should copy. This Dockerfile instead clones the
pinned tag and does what hermes' own upstream `Dockerfile` does for its
Python half: `uv sync --frozen`, which installs the project editable —
the officially supported path, and the one that reliably resolves bundled
skills through `__file__`, not PyPI package-data.

`uv` itself is copied (not `pip install`ed) from
`ghcr.io/astral-sh/uv:0.11.6-python3.13-trixie`, pinned to the exact
digest hermes' own upstream `Dockerfile` uses for the same
`pyproject.toml`/`uv.lock` pair — reusing a version we found already
vetted against this exact hermes release, not one guessed independently.

## Patches

`patches/*.patch` are applied (`git apply`) against the cloned tag before
`uv sync`. Empty at 1.1.0 — see `patches/README.md` for the mechanism and
an honest note that a reference checkout carries **multiple** local
modifications, spanning more than one area, not captured here yet (a
known gap wider than a single change, flagged for a maintainer/later
Этап, not silently dropped — at least one of them is security-relevant
and should not wait for a full survey to be ported).

## Required environment

| Variable | Required | What |
|---|---|---|
| `API_SERVER_KEY` | yes | Bearer token for the gateway's API server. hermes itself refuses to start the API server without one at least 16 chars and not a known placeholder (`gateway/platforms/api_server.py: _api_key_passes_startup_guard`); the entrypoint checks length up front so a misconfigured container fails in one line. Generate with `openssl rand -hex 32`. |
| `MYRMIDON_BOT_YOLO` | no (default `1`) | `1`: sets `HERMES_YOLO_MODE=1` before exec — dangerous-command approvals bypassed, because this gateway has no attended operator to answer a prompt. `0`: leaves approvals to the profile's `config.yaml` (`approvals.mode`, default `smart`); on `api_server` (an "unattended platform" in hermes' own terms) an unanswered approval defaults to `deny`, not to a hang. See `docs/myrmidon/SETTINGS.md`. |

`API_SERVER_ENABLED`, `API_SERVER_HOST`, `API_SERVER_PORT`, `HERMES_HOME`,
`HERMES_DISABLE_LAZY_INSTALLS`, `HERMES_LAZY_INSTALL_TARGET`,
`HERMES_WRITE_SAFE_ROOT` already have working defaults baked into the
image (`true`, `0.0.0.0`, `8642`, `/data/hermes`, `1`,
`/data/hermes/lazy-packages`, `/data:/workspace`) — override only if the
container topology needs something else.

## Volumes

- `/data` — `HERMES_HOME=/data/hermes`: config, `.env`, `sessions/`,
  `state.db`. Must be owned by uid `10001` before the container starts
  (this image does not chown it — that is the fleet manager's job, since
  it is the one process with the privilege to do it; see
  containers-plan-senior §1.4 on why the socket and that privilege live
  there and not here).
- `/workspace` — the bot/project's working directory (`terminal.cwd`).
  Same ownership requirement.

## Health check

`GET /health` (no auth — unlike `GET /v1/capabilities`, which is
Bearer-gated and would need the key threaded into the `HEALTHCHECK`
command for no real benefit at this stage). `/health` only confirms the
aiohttp server accepted the connection and hermes' process is alive; it
does not confirm a model provider is configured or that a run would
actually succeed — that needs a live-run check on a stand, not a
container health check.

## What's not verified yet

This Dockerfile and entrypoint were written by reading a reference
`hermes-agent` checkout and hermes' own upstream `Dockerfile`/tests, not
by running a build — this session's host forbids installing dependencies
or running Docker builds locally (CONVENTIONS.md, "Сборка и тесты"). CI
builds and, on `main`/tags, should also be given a live boot check before
this image is used for the Этап 2 pilot: start a container with a
generated `API_SERVER_KEY` and no provider configured, confirm `/health`
comes up and `hermes gateway run` does not need a configured model
provider just to serve `api_server` (untested assumption — see the PR's
"Риски и что проверить на стенде").
