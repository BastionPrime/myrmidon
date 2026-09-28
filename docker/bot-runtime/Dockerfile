# syntax=docker/dockerfile:1.20
#
# G1: bot runtime image — a long-running hermes gateway (`hermes gateway run`,
# OpenAI-compatible API server on :8642) that the board talks to through the
# hermes_gateway adapter. See docs/myrmidon/CONVENTIONS.md and
# containers-plan-senior (design decision "variant B", 2026-09-28) for the
# surrounding architecture: this image is the long-lived per-bot/per-project
# process; the board and a separate fleet manager own its lifecycle.
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
ARG HERMES_REPO=https://github.com/NousResearch/hermes-agent.git
# gateway/platforms/api_server.py uses aiohttp.web, but aiohttp is not a core
# dependency of hermes-agent — it only ships inside optional extras, most of
# which also pull in Telegram/Discord/Slack client libraries we do not need
# for an API-server-only bot. "sms" is the smallest extra that resolves to
# exactly aiohttp + its own transitive deps and nothing else, so installing
# through it (`uv sync --frozen --extra sms`, see the builder stage below)
# gets aiohttp through the same hash-verified lockfile path as every other
# dependency in this image, instead of a separate unlocked `uv pip install`.
# See docker/bot-runtime/README.md.
ARG HERMES_AIOHTTP_VERSION=3.14.3

# Same uv build + digest hermes-agent's own upstream Dockerfile pins
# (/opt/hermes-agent/src/Dockerfile, stage `uv_source`) — reusing a version
# we found already vetted against this exact pyproject.toml/uv.lock pair,
# rather than picking one blind.
FROM ghcr.io/astral-sh/uv:0.11.6-python3.13-trixie@sha256:b3c543b6c4f23a5f2df22866bd7857e5d304b67a564f4feab6ac22044dde719b AS uv_bin

FROM python:3.13-slim AS builder
ARG HERMES_VERSION
ARG HERMES_GIT_REF
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

# Fail the build loudly if the pinned tag and the pinned version disagree
# (wrong build-arg, moved tag, upstream renumbering) instead of silently
# shipping a different hermes than the labels claim.
RUN set -eu; \
    pinned="$(sed -n 's/^version = "\(.*\)"$/\1/p' pyproject.toml)"; \
    if [ "$pinned" != "${HERMES_VERSION}" ]; then \
      echo "HERMES_GIT_REF=${HERMES_GIT_REF} has pyproject version '$pinned' != HERMES_VERSION=${HERMES_VERSION}" >&2; \
      exit 1; \
    fi

# myrmidon(G1): apply our hermes client patches, if any (docker/bot-runtime/patches/*.patch).
# The directory is empty at 1.1.0 — see docker/bot-runtime/patches/README.md for how a patch
# is added and reviewed. This loop is scaffolding for when the first one lands. Copying the
# whole directory (not a *.patch glob) so the build does not fail when it holds only the README.
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

RUN uv sync --frozen --extra sms \
  && find /opt/hermes-src/.venv -name '__pycache__' -type d -prune -exec rm -rf {} +

FROM python:3.13-slim AS runtime
ARG HERMES_VERSION

LABEL org.opencontainers.image.title="myrmidon-hermes" \
      org.opencontainers.image.description="Bot runtime image: hermes gateway (API server) for a Myrmidon bot or project container" \
      org.opencontainers.image.source="https://github.com/itkadr-git/myrmidon" \
      org.opencontainers.image.licenses="MIT" \
      io.github.itkadr-git.myrmidon.base.hermes-version="${HERMES_VERSION}"

# ripgrep: hermes' file-search tool shells out to `rg`. git: workspace tools
# (status/diff/commit) for coding-agent bots. curl: HEALTHCHECK only.
# No media tools (ffmpeg, yt-dlp, ...): forbidden by docs/myrmidon/CONVENTIONS.md §8
# and out of scope — media handling is a separate service outside this image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    ripgrep \
    tini \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 10001 bot \
  && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/bot --shell /usr/sbin/nologin bot

COPY --from=builder --chown=root:root /opt/hermes-src /opt/hermes-src
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
RUN mkdir -p /data /workspace \
  && chown bot:bot /data /workspace

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH=/opt/hermes-src/.venv/bin:$PATH \
    HOME=/home/bot \
    HERMES_HOME=/data/hermes \
    HERMES_BUNDLED_SKILLS=/opt/hermes-src/skills \
    HERMES_WRITE_SAFE_ROOT=/data:/workspace \
    HERMES_DISABLE_LAZY_INSTALLS=1 \
    HERMES_LAZY_INSTALL_TARGET=/data/hermes/lazy-packages \
    NO_COLOR=1 \
    API_SERVER_ENABLED=true \
    API_SERVER_HOST=0.0.0.0 \
    API_SERVER_PORT=8642 \
    MYRMIDON_BOT_YOLO=1

USER 10001:10001
WORKDIR /workspace
VOLUME ["/data", "/workspace"]
EXPOSE 8642

# /health needs no auth (unlike /v1/capabilities, which is Bearer-gated) —
# see docker/bot-runtime/README.md and gateway/platforms/api_server.py.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${API_SERVER_PORT}/health" || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/bot-runtime-entrypoint"]
