# Bot runtime image (G1)

A container image that runs one long-lived `hermes gateway run` process,
serving its OpenAI-compatible API server (`platforms.api_server`) on
`:8642` for the board's `hermes_gateway` adapter to talk to. This is the
per-bot / per-project process described as "variant B" under item C1/H3 in
`docs/myrmidon/ROADMAP.md` — the board itself no longer spawns or owns
hermes processes; it reconciles a desired profile into this container's
volumes and talks to the running gateway over HTTP. The fuller design
write-up behind that decision is maintainer-side material and not part of
this repository (`ROADMAP.md` says the same under C1).

This image does **one** job: run the gateway. It does not run cron, a
dashboard, or any messaging platform other than `api_server`. It has no
Docker socket, no host mounts, and no media tools.

## What's in the image

- Base: `python:3.13-slim` in both build stages. The hermes venv is pinned to
  that stage's own interpreter (`uv sync --python /usr/local/bin/python3`,
  `UV_PYTHON_DOWNLOADS=never`): hermes' `.python-version` (3.11) would
  otherwise make `uv` download a managed CPython into the builder's `/root`
  and link the venv to it, and that link does not exist in the runtime
  stage. A build-time check in the runtime stage, run as the `bot` user,
  asserts that `/opt/hermes-src/.venv/bin/python` resolves outside `/root`
  and imports `hermes_state`.
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
  `uv sync --frozen --extra sms --extra mcp --extra hindsight` — the same
  hash-verified `uv.lock` path every other dependency in this image goes
  through, rather than a separate unlocked `uv pip install aiohttp==...`
  that could pull an untampered-looking but unverified wheel. A build-time
  check fails loudly if that extra ever stops being exactly
  `aiohttp==${HERMES_AIOHTTP_VERSION}`.
- `mcp` and `hindsight-client` (the `mcp` and `hindsight` extras), baked in
  rather than left to hermes' own lazy install
  (`tools/lazy_deps.py`/`HERMES_LAZY_INSTALL_TARGET`, below): every
  G2-compiled bot profile writes both an `mcp_servers` block and a
  `memory.provider=hindsight` config, and this image's sealed venv cannot
  reliably lazy-install into itself at runtime (see "Sealed image" below).
  Without these two extras hermes does not error — it silently disables
  MCP tools (`tools/mcp_tool.py`, gated on `importlib.util.find_spec('mcp')`)
  and hindsight memory (`plugins/memory/hindsight/__init__.py`,
  `is_available()`) — so the builder also runs
  `python -c 'import aiohttp, mcp, hindsight_client'` against the synced
  venv, to fail the build instead of shipping that silent regression. A second
  smoke imports every module a patch in `patches/` changes (`hermes_state`,
  `plugins.memory.hindsight`, `tools.environments.base`,
  `tools.environments.base_session_env`), because `git apply` only proves the
  hunks land, not that the patched module still imports.
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
It is copied into both the builder stage and the final runtime image: at
runtime, hermes' own lazy-install mechanism (`tools/lazy_deps.py`, see
"Sealed image" below) tries `uv pip install --target <dir>` before falling
back to `pip`/`ensurepip` — a fallback that would try (and fail) to write
into the sealed, read-only `/opt/hermes-src/.venv` in this image. Without
`uv` on `PATH`, every lazy-installable opt-in backend (a model provider not
already baked in, a web-search backend, TTS/STT, OTLP export, ...) would
silently break in this image the first time a bot profile picked one.

The builder stage clones the tag into `/opt/hermes-src`, but the runtime
image does not ship that clone unmodified: after `uv sync`, the Dockerfile
removes `.git` (the shallow clone's history — never needed once `git
apply`/`uv sync` above are done, since hermes-agent's version is a static
`pyproject.toml` string, not derived from git at build time) and the
top-level dev/build-only directories and lockfiles that nothing in the
installed package imports at runtime (`tests/`, `tests-js/`, `evals/`,
`docs/`, `contributors/`, `nix/`, `mcp-research-data/`, `package-lock.json`,
`flake.lock`, `flake.nix`). `plugin-catalog/` is kept — it is read at
runtime by `hermes_cli/plugin_catalog.py`.

## Patches

`patches/*.patch` are applied (`git apply`) against the cloned tag before
`uv sync`. Four are ported: a hindsight `reflect` timeout/retry fix (01), a
session-snapshot secret redaction (02), the configured `retain_async` in the
explicit hindsight retain tool (03), and a bounded retry of state-database
reads that find the database locked (04). See `patches/README.md` for what
each does and why.

A reference checkout carries further local modifications. A plain tree diff of
it against the pinned tag (no repository history is needed) gives a closed
list, and `patches/README.md` decides every file on it: ported (above), or not
needed in this image with the reason — the `reasoning_content` storage
optimization in `agent/chat_completion_helpers.py` (storage only, not a fix),
the CLI query-label escape in `cli.py` (this image never runs that path), and
the browser tool's socket-directory files `tools/browser_tool.py` and
`tools/browser_tool_session.py` (the image ships no browser). As of that
comparison nothing is left as an open gap.

## Required environment

| Variable | Required | What |
|---|---|---|
| `API_SERVER_KEY` | yes, but never as container `Env` | Bearer token for the gateway's API server. hermes itself refuses to start the API server without one at least 16 chars and not a known placeholder (`gateway/platforms/api_server.py: _api_key_passes_startup_guard`); the entrypoint checks length up front so a misconfigured container fails in one line. Per the bot-runtime contract (below), the G3 driver never sets container `Env` — the entrypoint reads it from `${HERMES_HOME}/.env` (`API_SERVER_KEY="..."`, parsed as data, never sourced) when it is not already in the process environment. Generate with `openssl rand -hex 32`. |
| `MYRMIDON_BOT_YOLO` | no (default `1`) | `1`: sets `HERMES_YOLO_MODE=1` before exec — dangerous-command approvals bypassed, because this gateway has no attended operator to answer a prompt. `0`: leaves approvals to the profile's `config.yaml` (`approvals.mode`, default `smart`); on `api_server` (an "unattended platform" in hermes' own terms) an unanswered approval defaults to `deny`, not to a hang. See `docs/myrmidon/SETTINGS.md`. |

`API_SERVER_ENABLED`, `API_SERVER_HOST`, `API_SERVER_PORT`, `HERMES_HOME`,
`HERMES_DISABLE_LAZY_INSTALLS`, `HERMES_LAZY_INSTALL_TARGET`,
`HERMES_WRITE_SAFE_ROOT` already have working defaults baked into the
image (`true`, `0.0.0.0`, `8642`, `/data/hermes`, `1`,
`/data/hermes/lazy-packages`, `/data:/workspace:/scratch`) — override only
if the container topology needs something else.

## Bot-runtime contract

The image declares `myrmidon.bot-runtime.contract="1"` (an OCI label,
`docker/bot-runtime/Dockerfile`'s runtime-stage `LABEL`). The G3 container
driver (`server/src/myrmidon/bot-containers/template.ts`,
`assertBotRuntimeContract`) refuses to create a bot container from an image
that does not declare a value it supports, before anything is created — an
image that exists but was built for a different contract would otherwise
only fail after the container starts, then crash-loop under its restart
policy. Contract "1" (see that file's docstring on
`BOT_RUNTIME_CONTRACT_LABEL` for the authoritative text) commits this image
to: uid:gid `10001:10001`, `HERMES_HOME=/data/hermes` and `/workspace` as
the working directory; every secret read from `${HERMES_HOME}/.env`, never
from the container's own environment; nothing written outside `/data/hermes`,
`/workspace`, `/scratch`, `/tmp` and any volume the image declares itself
(the driver runs the container with a read-only root filesystem); and a
POSIX shell with `find`, `mv -T`, `mkdir -p`, `rm`, `chmod`, `chown`,
`dirname`.

## Volumes

- `/data` — `HERMES_HOME=/data/hermes`: config, `.env`, `sessions/`,
  `state.db`. Must be owned by uid `10001` before the container starts
  (this image does not chown it — that is the fleet manager's job, since
  it is the one process with the privilege to do it; see item C1 in
  `docs/myrmidon/ROADMAP.md` on why `docker.sock` and that privilege live
  there and not here — the fuller rationale is maintainer-side material,
  not part of this repository). `HOME` is also set to `/data/hermes`
  (not the default `/home/bot`): the driver runs this image with a
  read-only root filesystem, so anything a library would write under
  `$HOME` on first use needs to land on a mounted, writable path instead —
  mirrors hermes' own upstream Dockerfile, which points its user's home at
  its data volume for the identical reason.
- `/workspace` — the bot/project's working directory (`terminal.cwd`).
  Same ownership requirement.
- `/scratch` — scratch space for the coding-agent tools' own temp files,
  outside `/workspace` and `/data/hermes`. Same ownership requirement; part
  of `HERMES_WRITE_SAFE_ROOT` alongside the other two.

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
