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
- `aiohttp`, pinned to the exact version hermes' own `messaging`/`slack`
  extras use at this release (`HERMES_AIOHTTP_VERSION`, default `3.14.3`).
  `gateway/platforms/api_server.py` is built on `aiohttp.web`, but aiohttp
  is not one of hermes' core dependencies — only its messaging-platform
  extras pull it in, and those extras also pull in
  `python-telegram-bot`/`discord.py`/`slack-bolt`, which this image does
  not need. Installing just `aiohttp` at the version those extras pin
  keeps the image to what an API-server-only bot actually uses, without
  guessing a version upstream hasn't tested.
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

## Why editable, not `pip install hermes-agent`

`hermes-agent`'s own `setup.py` (at `/opt/hermes-agent/src/setup.py` on the
host this image was designed against) explicitly refuses to build a wheel
or sdist outside a Nix build:

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
an honest note on what we could and could not verify about local
modifications on the reference host.

## Required environment

| Variable | Required | What |
|---|---|---|
| `API_SERVER_KEY` | yes | Bearer token for the gateway's API server. hermes itself refuses to start the API server without one at least 16 chars and not a known placeholder (`gateway/platforms/api_server.py: _api_key_passes_startup_guard`); the entrypoint checks length up front so a misconfigured container fails in one line. Generate with `openssl rand -hex 32`. |
| `MYRMIDON_BOT_YOLO` | no (default `1`) | `1`: sets `HERMES_YOLO_MODE=1` before exec — dangerous-command approvals bypassed, because this gateway has no attended operator to answer a prompt. `0`: leaves approvals to the profile's `config.yaml` (`approvals.mode`, default `smart`); on `api_server` (an "unattended platform" in hermes' own terms) an unanswered approval defaults to `deny`, not to a hang. See `docs/myrmidon/SETTINGS.md`. |

`API_SERVER_ENABLED`, `API_SERVER_HOST`, `API_SERVER_PORT`, `HERMES_HOME`
already have working defaults baked into the image (`true`, `0.0.0.0`,
`8642`, `/data/hermes`) — override only if the container topology needs
something else.

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

This Dockerfile and entrypoint were written by reading
`/opt/hermes-agent/src` and hermes' own upstream `Dockerfile`/tests, not
by running a build — this session's host forbids installing dependencies
or running Docker builds locally (CONVENTIONS.md, "Сборка и тесты"). CI
builds and, on `main`/tags, should also be given a live boot check before
this image is used for the Этап 2 pilot: start a container with a
generated `API_SERVER_KEY` and no provider configured, confirm `/health`
comes up and `hermes gateway run` does not need a configured model
provider just to serve `api_server` (untested assumption — see the PR's
"Риски и что проверить на стенде").
