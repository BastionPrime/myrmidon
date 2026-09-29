# syntax=docker/dockerfile:1.20
#
# G1: bot runtime image — a long-running hermes gateway (`hermes gateway run`,
# OpenAI-compatible API server on :8642) that the board talks to through the
# hermes_gateway adapter. See docs/myrmidon/CONVENTIONS.md and
# docs/myrmidon/ROADMAP.md (items C1/H3, owner decision 2026-09-28, "variant
# B") for the surrounding architecture: this image is the long-lived
# per-bot/per-project process; the board and a separate fleet manager own
# its lifecycle. The fuller design write-up behind C1/H3 is maintainer-side
# material, not part of this repository (ROADMAP.md says the same under C1).
#
# hermes-agent is NOT published as an installable PyPI wheel from this
# version on (its own setup.py refuses `bdist_wheel`/`sdist` outside a Nix
# build — "Hermes is distributed via the shell installer, Docker image, or
# Nix"). Editable installs (`uv sync`, `pip install -e .`) are the supported
# path, so this Dockerfile clones the pinned upstream tag and installs it
# editable; the source tree stays in the image (read-only for the runtime
# user) because bundled skills and other packaged assets are resolved by
# hermes relative to the installed module's __file__, not from wheel
# package-data.

# HERMES_VERSION is the `version =` field in hermes' pyproject.toml (the
# number it reports itself); HERMES_GIT_REF is the git tag that ships that
# version. The two do NOT share a numbering scheme: hermes-agent tags
# releases by date (vYYYY.M.D) while pyproject.toml's version field is a
# separate, independently-bumped 0.x.y counter. v2026.9.11 is the tag we
# confirmed (via the GitHub API, against every recent release tag) carries
# `version = "0.21.2"` — do not assume a future HERMES_VERSION bump maps to
# `v<that number>`; look the date tag up the same way and update both.
ARG HERMES_VERSION=0.21.2
ARG HERMES_GIT_REF=v2026.9.11
# The exact commit `HERMES_GIT_REF` must resolve to (confirmed via the GitHub API:
# `GET /repos/NousResearch/hermes-agent/commits/v2026.9.11`). A git tag is a mutable
# ref — upstream (or an MITM on the clone) moving it would otherwise silently ship a
# different tree under the same version/label check below. The builder stage fails
# loudly on a mismatch, before the shallow clone's `.git` is ever removed, so this
# check is only meaningful pinned here, not as a comment. Update both together when
# HERMES_GIT_REF moves to a new tag.
ARG HERMES_GIT_SHA=939e45c91d751fadd94dcd1b873ac3cb44846213
ARG HERMES_REPO=https://github.com/NousResearch/hermes-agent.git
# gateway/platforms/api_server.py uses aiohttp.web, but aiohttp is not a core
# dependency of hermes-agent — it only ships inside optional extras, most of
# which also pull in Telegram/Discord/Slack client libraries we do not need
# for an API-server-only bot. "sms" is the smallest extra that resolves to
# exactly aiohttp + its own transitive deps and nothing else, so installing
# through it (`uv sync --frozen --extra sms --extra mcp --extra hindsight`, see the
# builder stage below) gets aiohttp through the same hash-verified lockfile path as
# every other dependency in this image, instead of a separate unlocked `uv pip
# install`. See docker/bot-runtime/README.md.
ARG HERMES_AIOHTTP_VERSION=3.14.3

# Same uv build + digest hermes-agent's own upstream Dockerfile pins (its
# `uv_source` stage) — reusing a version we found already vetted against
# this exact pyproject.toml/uv.lock pair, rather than picking one blind.
FROM ghcr.io/astral-sh/uv:0.11.6-python3.13-trixie@sha256:b3c543b6c4f23a5f2df22866bd7857e5d304b67a564f4feab6ac22044dde719b AS uv_bin

FROM python:3.13-slim AS builder
ARG HERMES_VERSION
ARG HERMES_GIT_REF
ARG HERMES_GIT_SHA
ARG HERMES_REPO
ARG HERMES_AIOHTTP_VERSION

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

COPY --chmod=0755 --from=uv_bin /usr/local/bin/uv /usr/local/bin/uvx /usr/local/bin/

# build-essential/python3-dev: safety net for any core dependency without a
# manylinux wheel for cp313; discarded with this stage either way.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    git \
    python3-dev \
  && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 --branch "${HERMES_GIT_REF}" "${HERMES_REPO}" /opt/hermes-src
WORKDIR /opt/hermes-src

# Fail the build loudly if the cloned tag does not resolve to the pinned commit
# (moved tag, upstream force-push, MITM on the clone) instead of silently building
# a different tree than the one HERMES_GIT_SHA records as reviewed. Must run before
# .git is removed below — it is the only place this ref's identity can be checked.
RUN set -eu; \
    actual="$(git rev-parse HEAD)"; \
    if [ "$actual" != "${HERMES_GIT_SHA}" ]; then \
      echo "HERMES_GIT_REF=${HERMES_GIT_REF} resolved to commit $actual, HERMES_GIT_SHA=${HERMES_GIT_SHA} disagrees" >&2; \
      exit 1; \
    fi

# Fail the build loudly if the pinned tag and the pinned version disagree
# (wrong build-arg, moved tag, upstream renumbering) instead of silently
# shipping a different hermes than the labels claim.
RUN set -eu; \
    pinned="$(sed -n 's/^version = "\(.*\)"$/\1/p' pyproject.toml)"; \
    if [ "$pinned" != "${HERMES_VERSION}" ]; then \
      echo "HERMES_GIT_REF=${HERMES_GIT_REF} has pyproject version '$pinned' != HERMES_VERSION=${HERMES_VERSION}" >&2; \
      exit 1; \
    fi

# myrmidon(G1): apply our hermes client patches (docker/bot-runtime/patches/*.patch) —
# see docker/bot-runtime/patches/README.md for what each one does and how a new one is
# added and reviewed. Copying the whole directory (not a *.patch glob) so the build
# does not fail if it ever holds only the README again.
COPY patches/ /tmp/patches/
RUN set -eu; \
    for p in /tmp/patches/*.patch; do \
      [ -e "$p" ] || continue; \
      echo "applying $p"; \
      git apply --whitespace=fix "$p"; \
    done

# Fail loudly if pyproject.toml's "sms" extra ever stops being exactly
# aiohttp pinned at HERMES_AIOHTTP_VERSION (a future hermes release could
# add a dependency to it, or repin aiohttp to a different version than the
# rest of the messaging extras) instead of silently installing whatever it
# resolves to.
RUN set -eu; \
    pinned_aiohttp="$(sed -n 's/^sms = \["aiohttp==\(.*\)"\]$/\1/p' pyproject.toml)"; \
    if [ "$pinned_aiohttp" != "${HERMES_AIOHTTP_VERSION}" ]; then \
      echo "pyproject.toml 'sms' extra pins aiohttp==$pinned_aiohttp, HERMES_AIOHTTP_VERSION=${HERMES_AIOHTTP_VERSION} disagrees" >&2; \
      exit 1; \
    fi

# myrmidon(G1): "mcp" and "hindsight" are baked in (not left to hermes' own lazy
# install) because a G2-compiled bot profile always writes mcp_servers and a
# memory.provider=hindsight config — without these two extras, hermes silently
# starts with both features disabled (tools/mcp_tool.py checks importlib.util.
# find_spec('mcp') and logs at debug on failure; plugins/memory/hindsight/__init__.py
# similarly no-ops) instead of a build- or start-time error. See README.md
# "Sealed image: lazy installs and the write-safe root" for why lazy-installing them
# at runtime instead is not a reliable fallback in this image.
#
# myrmidon(G1): the venv's `bin/python` is a symlink to whichever interpreter `uv sync`
# picked, and the runtime stage copies only /opt/hermes-src, so that interpreter must exist
# in the runtime stage too. hermes ships a `.python-version` (3.11, a dev-machine pin) that
# `uv sync` honours: when the stage's Python is not 3.11 it silently downloads a managed
# CPython into $HOME (/root/.local/share/uv/python/...) and links the venv to it — a path
# absent from the runtime stage and unreadable by the bot user, so the image died at start
# with "bad interpreter: Permission denied". pyproject.toml's `requires-python`
# (>=3.11,<3.14) admits this stage's Python 3.13, and hermes' own upstream Docker image
# runs Debian 13's system Python (3.13) the same way (its `uv sync` step sees only
# pyproject.toml + uv.lock, never `.python-version`), so the venv is pinned to the base
# image's interpreter. The builder and runtime stages MUST stay on the same
# `python:3.13-slim`, so that path is the same interpreter in both; the runtime-stage
# assertion below checks it. UV_PYTHON_DOWNLOADS=never turns any future mismatch into a
# build error instead of a dangling link.
ENV UV_PYTHON_DOWNLOADS=never
RUN uv sync --frozen --extra sms --extra mcp --extra hindsight --python /usr/local/bin/python3 \
  && find /opt/hermes-src/.venv -name '__pycache__' -type d -prune -exec rm -rf {} +

# Fail the build loudly if any of the three packages this image relies on being
# preinstalled (never lazily) fails to import from the synced venv, instead of only
# discovering it the first time a bot profile tries to use MCP tools or hindsight
# memory at runtime.
RUN /opt/hermes-src/.venv/bin/python -c 'import aiohttp, mcp, hindsight_client'

# myrmidon(G1): import smoke for every module a patch in patches/ changes
# (hermes_state: 04; plugins.memory.hindsight, which pulls in its settings
# module: 01 and 03; tools.environments.base and base_session_env: 02). `git apply`
# only proves the hunks land; a patch that applies cleanly but breaks a module's
# imports or top-level code would otherwise surface only when a bot starts.
# No bytecode is written, so the sealed tree stays as the build left it.
RUN PYTHONDONTWRITEBYTECODE=1 /opt/hermes-src/.venv/bin/python -c 'import hermes_state, plugins.memory.hindsight, tools.environments.base, tools.environments.base_session_env'

# myrmidon(G1): the runtime image only needs the installed package plus
# bundled skills (tools/skills_sync.py resolves skills/ relative to its own
# __file__, so that lookup is unaffected by anything removed below). Drop
# the shallow clone's git history (never needed after `git apply`/`uv sync`
# above — hermes-agent's version is a static pyproject.toml string, not
# derived from git at build time) and the top-level dev/build-only
# directories and lockfiles that are never imported at runtime, so the
# image does not ship the whole upstream checkout. `plugin-catalog/` is
# kept: hermes_cli/plugin_catalog.py reads it at runtime
# (get_bundled_catalog_dir()).
RUN rm -rf /opt/hermes-src/.git \
    /opt/hermes-src/tests \
    /opt/hermes-src/tests-js \
    /opt/hermes-src/evals \
    /opt/hermes-src/docs \
    /opt/hermes-src/contributors \
    /opt/hermes-src/nix \
    /opt/hermes-src/mcp-research-data \
    /opt/hermes-src/package-lock.json \
    /opt/hermes-src/flake.lock \
    /opt/hermes-src/flake.nix

FROM python:3.13-slim AS runtime
ARG HERMES_VERSION

# myrmidon.bot-runtime.contract: the G3 container driver
# (server/src/myrmidon/bot-containers/template.ts, BOT_RUNTIME_CONTRACT_LABEL)
# refuses to create a container from an image that does not declare a supported
# value here — see that file's docstring on BOT_RUNTIME_CONTRACT_LABEL for the
# full contract this image commits to (uid:gid, mounts, secrets via
# $HERMES_HOME/.env, read-only root, shell requirements).
LABEL org.opencontainers.image.title="myrmidon-hermes" \
      org.opencontainers.image.description="Bot runtime image: hermes gateway (API server) for a Myrmidon bot or project container" \
      org.opencontainers.image.source="https://github.com/itkadr-git/myrmidon" \
      org.opencontainers.image.licenses="MIT" \
      io.github.itkadr-git.myrmidon.base.hermes-version="${HERMES_VERSION}" \
      myrmidon.bot-runtime.contract="1"

# ripgrep: hermes' file-search tool shells out to `rg`. git: workspace tools
# (status/diff/commit) for coding-agent bots. curl: HEALTHCHECK only. openssh-client:
# key-based ssh from a bot (-i <tmp key>, -o UserKnownHostsFile=<writable dir>).
# No media tools (ffmpeg, yt-dlp, ...): forbidden by docs/myrmidon/CONVENTIONS.md §8
# and out of scope — media handling is a separate service outside this image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    openssh-client \
    ripgrep \
    tini \
  && rm -rf /var/lib/apt/lists/*

# myrmidon(G1): --home-dir /data/hermes (not /home/bot) — the G3 driver runs this
# image with ReadonlyRootfs: true (docker-driver.ts buildCreateContainerRequestBody),
# so anything under $HOME on the image's own filesystem (dotfiles a library writes on
# first use — pip/uv cache dirs, .gitconfig, …) would fail to write instead of no-op.
# /data/hermes is the one mount that is both writable and always present (it is
# HERMES_HOME); mirrors hermes' own upstream Dockerfile, which points its `hermes`
# user's home at its data volume for the identical reason (`useradd -m -d /opt/data`).
RUN groupadd --gid 10001 bot \
  && useradd --uid 10001 --gid 10001 --create-home --home-dir /data/hermes --shell /usr/sbin/nologin bot

COPY --from=builder --chown=root:root /opt/hermes-src /opt/hermes-src
# myrmidon(G1): uv is also needed at runtime, not just to build the image — hermes'
# own lazy-install mechanism (tools/lazy_deps.py, see the ENV block below) shells out
# to `uv pip install --target <dir>` first and only falls back to `pip`/`ensurepip`
# (which would try to write into the sealed, read-only /opt/hermes-src/.venv and
# fail) when uv is not on PATH. Without this, every lazy-installable opt-in backend
# (a non-baked-in model provider, a web-search backend, TTS/STT, OTLP export, ...)
# would be silently broken in this image the first time a bot profile picked one.
COPY --chmod=0755 --from=uv_bin /usr/local/bin/uv /usr/local/bin/uvx /usr/local/bin/
COPY --chmod=0755 entrypoint.sh /usr/local/bin/bot-runtime-entrypoint

# /opt/hermes-src is root-owned and not writable by `bot` — the venv, the
# hermes source and the bundled skills under it are effectively read-only
# for the runtime user without a separate read-only bind mount. Sealing it
# this way also seals hermes' own lazy-install mechanism
# (tools/lazy_deps.py — installs an opt-in backend's SDK, e.g. the native
# `anthropic` provider, `bedrock`, a web-search backend, on first use): with
# neither HERMES_LAZY_INSTALL_TARGET nor HERMES_DISABLE_LAZY_INSTALLS set,
# it defaults to installing straight into this read-only venv, which would
# fail with a raw `uv pip install` permission error the first time any bot
# profile picks such a feature, instead of hermes' own clean "no writable
# target configured" message. HERMES_WRITE_SAFE_ROOT scopes hermes' own
# write/patch tools (agent/file_safety.py) to the durable volume for the
# same "sealed, unattended container" reason. All three ENV vars below
# mirror hermes' own upstream Dockerfile, which seals its image the same
# way and redirects lazy installs and safe writes to its data volume for
# the identical reason.
#
# myrmidon(G1): /scratch is the third of the three mounts the bot-runtime contract
# fixes (template.ts BOT_VOLUME_MOUNTS: hermes -> /data/hermes, workspace ->
# /workspace, scratch -> /scratch) — created and chowned here so a manual `docker
# run` (no fleet driver) still gets a writable /scratch; the G3 driver's own
# prepare-volumes helper re-chowns all three from the host side regardless.
RUN mkdir -p /data /workspace /scratch \
  && chown bot:bot /data /workspace /scratch

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH=/opt/hermes-src/.venv/bin:$PATH \
    HERMES_HOME=/data/hermes \
    HERMES_BUNDLED_SKILLS=/opt/hermes-src/skills \
    HERMES_WRITE_SAFE_ROOT=/data:/workspace:/scratch \
    HERMES_DISABLE_LAZY_INSTALLS=1 \
    HERMES_LAZY_INSTALL_TARGET=/data/hermes/lazy-packages \
    NO_COLOR=1 \
    API_SERVER_ENABLED=true \
    API_SERVER_HOST=0.0.0.0 \
    API_SERVER_PORT=8642 \
    MYRMIDON_BOT_YOLO=1
# myrmidon(G1): HOME=$HERMES_HOME (/data/hermes), not /home/bot — see the useradd
# comment above; ENV cannot reference another ENV set earlier in the same
# instruction reliably across BuildKit versions, so the literal is repeated here.
ENV HOME=/data/hermes

USER 10001:10001
WORKDIR /workspace
VOLUME ["/data", "/workspace", "/scratch"]
EXPOSE 8642

# myrmidon(G1): build-time guard for the venv interpreter, run as the runtime user in the
# runtime stage (not in the builder, where /root is readable and the interpreter always
# exists): the venv's python must resolve outside /root and the hermes source must import
# through the editable install (cwd /workspace, so nothing is found via the working dir).
# A `bin/python` link into the builder's /root fails here, at build time, instead of when
# the first container starts.
RUN /opt/hermes-src/.venv/bin/python -c 'import os, sys; real = os.path.realpath(sys.executable); assert not real.startswith("/root/"), "venv python resolves into /root: " + real; import hermes_state'

# /health needs no auth (unlike /v1/capabilities, which is Bearer-gated) —
# see docker/bot-runtime/README.md and gateway/platforms/api_server.py.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${API_SERVER_PORT}/health" || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/bot-runtime-entrypoint"]

# ---------------------------------------------------------------------------
# Variant `runtime-node`: the `runtime` image plus Node.js and a fixed set of
# preinstalled packages, for the few bots whose work is node scripts
# (presentations/documents, diagram and image rendering). INTERIM measure until
# a per-task sandbox exists; the plain `runtime` target stays the default image
# and this stage is only built explicitly (`--target runtime-node`, published as
# ghcr.io/itkadr-git/myrmidon-hermes-node). Nothing else differs: same uid,
# same read-only root, same contract label, same entrypoint. See README.md,
# "Variant with Node.js".
#
# NODE_VERSION is an exact release of the pinned LTS major; NODE_SHA256 is the
# digest of the linux-x64 .tar.xz from that release's SHASUMS256.txt. Bump both
# together. The build fails on a digest mismatch.
# ---------------------------------------------------------------------------
FROM python:3.13-slim AS node_dist
ARG NODE_VERSION=22.23.3
ARG NODE_SHA256=df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de

# Fonts: @napi-rs/canvas draws text with system fonts only, and the slim base
# has none, so Cyrillic labels in a rendered diagram would come out as boxes.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    fonts-dejavu-core \
    fonts-liberation \
    xz-utils \
  && rm -rf /var/lib/apt/lists/*

RUN set -eu; \
    curl -fsSL -o /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"; \
    echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c -; \
    mkdir /opt/node; \
    tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1; \
    rm -rf /tmp/node.tar.xz /opt/node/include /opt/node/share /opt/node/CHANGELOG.md /opt/node/README.md; \
    /opt/node/bin/node --version | grep -x "v${NODE_VERSION}"

FROM node_dist AS node_tools
ENV PATH=/opt/node/bin:$PATH
WORKDIR /opt/node-tools
# package.json pins exact versions; package-lock.json pins every transitive
# package with an integrity hash, and `npm ci` refuses to run if they disagree.
# --ignore-scripts: the native packages (sharp, @napi-rs/canvas) ship prebuilt
# binaries as platform packages, no install script or compiler is involved.
COPY node-tools/package.json node-tools/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
  && rm -rf /root/.npm

FROM runtime AS runtime-node
LABEL org.opencontainers.image.title="myrmidon-hermes-node" \
      org.opencontainers.image.description="Bot runtime image, Node.js variant: hermes gateway plus Node.js and preinstalled document/image packages" \
      io.github.itkadr-git.myrmidon.variant="node"

COPY --from=node_dist --chown=root:root /opt/node /opt/node
COPY --from=node_tools --chown=root:root /opt/node-tools /opt/node-tools
COPY --from=node_dist --chown=root:root /usr/share/fonts/truetype /usr/share/fonts/truetype
COPY --chown=root:root node-tools/smoke.cjs /opt/node-tools/smoke.cjs

# The root filesystem is read-only at run time, so every place node or npm write
# to must be a mounted volume: the npm cache and the global prefix live under
# /scratch (wiped with the scratch volume, which is fine for a cache), $HOME is
# already /data/hermes. /opt/node-tools is sealed (root-owned) and reached from
# any working directory through NODE_PATH — this covers CommonJS `require()`
# only; ES module `import` ignores NODE_PATH, so an .mjs script imports these
# packages by absolute path or through `createRequire` (README.md).
#
# PATH must not hold any writable volume (/data, /workspace, /scratch, /tmp): the
# dockergate image check rejects it, since a bot could plant a binary there. So the
# global prefix's bin directory is deliberately not on PATH; bots use the packages
# preinstalled in /opt/node-tools.
ENV PATH=/opt/node/bin:$PATH \
    NODE_TOOLS_DIR=/opt/node-tools \
    NODE_PATH=/opt/node-tools/node_modules:/scratch/npm-global/lib/node_modules \
    NPM_CONFIG_CACHE=/scratch/npm-cache \
    NPM_CONFIG_PREFIX=/scratch/npm-global \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

USER 10001:10001

# Build-time check, run as the runtime user in the finished stage (not in the
# builder where everything is readable): every preinstalled package loads and
# does a small real job (pptx written to a temp file, a Cyrillic text rendered
# and re-encoded, a PDF built, pdfjs imported). Only /tmp is written to.
RUN node /opt/node-tools/smoke.cjs && npm --version
