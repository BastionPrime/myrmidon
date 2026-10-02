#!/usr/bin/env bash
# scripts/myrmidon/dockergate/check-release-support.sh
#
# RELEASE-GATE (the 01.10 incident): the deploy now ships the board together
# with the matching dockergate (and fleetd) images of the same release. This
# helper answers one question for deploy.sh: given the board image reference,
# does the release tag it was built from name its component digests, so the
# deploy can roll them in the same run?
#
# Resolution, from strongest to weakest:
#   1. --from-file <release.json>  a file produced by the release workflow
#                                  (component digests recorded at build time);
#   2. --from-tag <myr-vX.Y.Z>     the component images carry the SAME release
#                                  tag (each workflow also tags by short sha);
#   3. --from-sha <short-sha>      the component images carry the tag
#                                  sha-<short> of the release commit.
#
# It prints, for the requested components (default: dockergate, fleetd):
#
#   dockergate=sha256:<64 hex>
#   fleetd=sha256:<64 hex>
#
# or nothing on stdout and a reason on stderr, exit 1. A digest is accepted
# only when the tag resolves in the registry (imagetools inspect), so a stale
# local tag file cannot name an image that is not there.
#
# myrmidon(TRACING-PINS): the LLM tracing pair --
# `langfuse`, `langfuse-worker` and `litellm` -- is not built per release. Its
# exact images are pinned in scripts/myrmidon/tracing/tracing-image-pins.json
# (the ONE source of truth, kept equal to the tested contract compose by
# scripts/myrmidon/tracing/tracing-release-pins.myrmidon.test.mjs). The three
# components resolve from that file, never from a release tag or sha:
#
#   --tracing-pins   print the pinned tracing images and exit, for example:
#                      langfuse=docker.langfuse.com/langfuse/langfuse:4.49.0
#
# Naming a tracing component in --components resolves it from the file too.
#
# This script is read-only; deploy.sh does the pulling and switching.
set -euo pipefail

log() { printf '[myrmidon-release-support] %s\n' "$*" >&2; }
die() { printf '[myrmidon-release-support] ERROR: %s\n' "$*" >&2; exit 1; }

source_file="" tag="" short_sha=""
components="dockergate,fleetd"
tracing_pins_only=0
while (($#)); do
  case "$1" in
    --from-file) source_file="$2"; shift 2 ;;
    --from-tag) tag="$2"; shift 2 ;;
    --from-sha) short_sha="$2"; shift 2 ;;
    --components) components="$2"; shift 2 ;;
    --tracing-pins) tracing_pins_only=1; shift ;;
    -h|--help) sed -n '2,39p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

declare -A MYR_COMPONENT_REPOSITORIES=(
  [dockergate]="ghcr.io/itkadr-git/myrmidon-dockergate"
  [fleetd]="ghcr.io/itkadr-git/myrmidon-fleetd"
  # myrmidon(TRACING-PINS): third-party images of the tracing pair (see the header).
  [langfuse]="docker.langfuse.com/langfuse/langfuse"
  [langfuse-worker]="docker.langfuse.com/langfuse/langfuse-worker"
  [litellm]="ghcr.io/berriai/litellm"
)

# myrmidon(TRACING-PINS): the components that resolve from the pins file, not from
# the registry. They are not built by the release workflows, so a release tag or
# sha never names them; the file is the one source of truth.
MYR_TRACING_COMPONENTS="langfuse,langfuse-worker,litellm"
TRACING_PINS_FILE="${MYR_TRACING_PINS_FILE:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../tracing/tracing-image-pins.json}"

command -v jq >/dev/null 2>&1 || die "jq is not installed"

# Print <name>=<repo>:<tag> (or <repo>@<digest>) from the pins file.
resolve_pinned() {
  local name="$1" repo tag digest
  [[ -f "$TRACING_PINS_FILE" ]] || die "tracing pins file not found: $TRACING_PINS_FILE"
  repo="$(jq -r --arg n "$name" '.components[$n].repository // empty' "$TRACING_PINS_FILE")"
  [[ -n "$repo" ]] || die "tracing pins file does not name component '$name'"
  digest="$(jq -r --arg n "$name" '.components[$n].digest // empty' "$TRACING_PINS_FILE")"
  tag="$(jq -r --arg n "$name" '.components[$n].tag // empty' "$TRACING_PINS_FILE")"
  if [[ -n "$digest" ]]; then
    printf '%s=%s@%s\n' "$name" "$repo" "$digest"
  elif [[ -n "$tag" ]]; then
    printf '%s=%s:%s\n' "$name" "$repo" "$tag"
  else
    die "tracing pins file names no tag or digest for component '$name'"
  fi
}

is_tracing_component() {
  case ",$MYR_TRACING_COMPONENTS," in *",$1,"*) return 0 ;; *) return 1 ;; esac
}

# --tracing-pins is a pure file read: no registry and no docker daemon.
if ((tracing_pins_only)); then
  IFS=',' read -r -a want <<<"$MYR_TRACING_COMPONENTS"
  for name in "${want[@]}"; do resolve_pinned "$name"; done
  exit 0
fi

command -v docker >/dev/null 2>&1 || die "docker is not installed"

[[ -n "$source_file" || -n "$tag" || -n "$short_sha" ]] \
  || die "give one of --from-file, --from-tag or --from-sha"
[[ -z "$tag" || -z "$source_file" ]] || die "give --from-tag or --from-file, not both"
[[ -z "$short_sha" || -z "$source_file" ]] || die "give --from-sha or --from-file, not both"
[[ -z "$short_sha" || -z "$tag" ]] || die "give --from-sha or --from-tag, not both"

# Resolve one reference to its index digest. Empty on failure (reason logged).
resolve() {
  local repo="$1" ref="$2" digest err rc=0
  err="$(mktemp)"
  digest="$(docker buildx imagetools inspect "$repo:$ref" --format '{{json .Manifest.Digest}}' 2>"$err")" || rc=$?
  # {{json .Manifest.Digest}} prints a JSON string WITH quotes; strip them.
  digest="${digest#\"}"
  digest="${digest%\"}"
  if ((rc != 0)) || [[ -z "$digest" ]] || [[ "$digest" == "null" ]]; then
    log "$repo:$ref not found in the registry ($(tail -n1 "$err" 2>/dev/null || echo no reason))"
    rm -f "$err"
    return 1
  fi
  rm -f "$err"
  printf '%s\n' "$digest"
}

# From a release.json written by the release workflow.
resolve_from_file() {
  local f="$1" repo digest
  [[ -f "$f" ]] || die "release file not found: $f"
  local -a want
  IFS=',' read -r -a want <<<"$components"
  local missing=0
  for name in "${want[@]}"; do
    if is_tracing_component "$name"; then
      resolve_pinned "$name"
      continue
    fi
    repo="${MYR_COMPONENT_REPOSITORIES[$name]}"
    [[ -n "$repo" ]] || die "unknown component: $name"
    digest="$(jq -r --arg n "$name" '(.components[$n].digest // .[$n] // empty)' "$f" 2>/dev/null || true)"
    if [[ -z "$digest" ]]; then
      log "$f does not name component '$name'"
      missing=1
      continue
    fi
    printf '%s=%s\n' "$name" "$digest"
  done
  return "$missing"
}

# Component workflows tag both the release version and the short sha.
resolve_from_ref() {
  local ref="$1" name repo digest missing=0
  local -a want
  IFS=',' read -r -a want <<<"$components"
  for name in "${want[@]}"; do
    if is_tracing_component "$name"; then
      resolve_pinned "$name"
      continue
    fi
    repo="${MYR_COMPONENT_REPOSITORIES[$name]}"
    [[ -n "$repo" ]] || die "unknown component: $name"
    digest="$(resolve "$repo" "$ref")" || digest=""
    if [[ -z "$digest" ]]; then
      missing=1
      continue
    fi
    printf '%s=%s\n' "$name" "$digest"
  done
  return "$missing"
}

if [[ -n "$source_file" ]]; then
  resolve_from_file "$source_file"
elif [[ -n "$tag" ]]; then
  resolve_from_ref "$tag"
else
  resolve_from_ref "sha-$short_sha"
fi
