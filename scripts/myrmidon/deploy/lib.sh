#!/usr/bin/env bash
# Shared helpers for deploy.sh, rollback.sh and verify-health.sh.
# Sourced, not executed. Requires bash 4+, docker (with compose), curl, jq.
# shellcheck disable=SC2034  # variables are used by the sourcing scripts

MYR_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { printf '[myrmidon-deploy] %s\n' "$*" >&2; }
die() { printf '[myrmidon-deploy] ERROR: %s\n' "$*" >&2; exit 1; }

# Runs a command, or prints it in dry-run mode.
run() {
  if [[ "${DRY_RUN:-0}" == "1" ]]; then
    printf '[dry-run] %s\n' "$*" >&2
    return 0
  fi
  "$@"
}

plan() { printf '  %s\n' "$*" >&2; }

require_cmd() {
  local cmd
  for cmd in "$@"; do
    command -v "$cmd" >/dev/null 2>&1 || die "required command not found: $cmd"
  done
}

valid_digest() { [[ "$1" =~ ^sha256:[0-9a-f]{64}$ ]]; }

# --- CI-only images ----------------------------------------------------------
# Only images built by the "Myrmidon image" workflow from main or from a myr-v*
# tag reach production. deploy.sh refuses anything else before it changes
# anything; rollback.sh only warns (it is the emergency path). There is
# deliberately no flag or setting that skips these checks.
MYR_CI_IMAGE="ghcr.io/itkadr-git/myrmidon"
MYR_CI_SOURCE="https://github.com/itkadr-git/myrmidon"
MYR_CI_ORIGIN_RE='(^|[/@])github\.com[:/]itkadr-git/myrmidon(\.git)?/?$'
MYR_NET_TIMEOUT_SEC=90
CI_CHECK_REASON=""
CI_IMAGE_REVISION=""
CI_IMAGE_VERSION=""

# Runs a network command with a time limit, so a dead registry or remote cannot hang the script.
with_timeout() {
  if command -v timeout >/dev/null 2>&1; then
    timeout "$MYR_NET_TIMEOUT_SEC" "$@"
  else
    "$@"
  fi
}

# Explains, in one line, why a reference is not exactly $MYR_CI_IMAGE@sha256:<64 hex>.
image_ref_problem() {
  local ref="$1" repo digest
  if [[ -z "$ref" ]]; then
    echo "no image given: pass the digest of an image built by CI as sha256:<64 hex>"
  elif [[ "$ref" == *@* ]]; then
    repo="${ref%@*}"
    digest="${ref#*@}"
    if [[ "$repo" != "$MYR_CI_IMAGE" ]]; then
      echo "image '$repo' is not $MYR_CI_IMAGE: only images built by CI in this repository are deployed"
    else
      echo "digest '$digest' must be sha256: followed by 64 lowercase hex characters"
    fi
  elif [[ "$ref" == sha256:* ]]; then
    echo "digest '$ref' must be sha256: followed by 64 lowercase hex characters"
  else
    echo "'$ref' has no digest (it is a tag or a name); tags can be moved. CI images are referenced as $MYR_CI_IMAGE@sha256:<64 hex>, the digest is in the CI run summary"
  fi
}

# Sets `digest` from a bare sha256:<64 hex> or from $MYR_CI_IMAGE@sha256:<64 hex>; dies on anything else.
parse_digest_arg() {
  local arg="$1"
  if valid_digest "$arg"; then
    digest="$arg"
  elif [[ "$arg" == "$MYR_CI_IMAGE@"* ]] && valid_digest "${arg#"$MYR_CI_IMAGE@"}"; then
    digest="${arg#"$MYR_CI_IMAGE@"}"
  else
    die "$(image_ref_problem "$arg")"
  fi
}

# Checks that a commit is on origin/main or carries a release tag myr-v<x>.<y>.<z>, using the git
# clone that holds these scripts. Sets CI_CHECK_REASON and returns 1 when it cannot say yes.
commit_is_reviewed() {
  local rev="$1" clone url tags sha name
  local tag_re='^refs/tags/myr-v[0-9]+\.[0-9]+\.[0-9]+(\^\{\})?$'
  if ! command -v git >/dev/null 2>&1; then
    CI_CHECK_REASON="git is not installed, so commit ${rev:0:12} cannot be checked against main; run the script from a git clone of itkadr-git/myrmidon"
    return 1
  fi
  if ! clone="$(git -C "$MYR_SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null)" || [[ -z "$clone" ]]; then
    CI_CHECK_REASON="the deploy scripts are not inside a git clone, so commit ${rev:0:12} cannot be checked against main; run them from a clone of itkadr-git/myrmidon"
    return 1
  fi
  if ! url="$(git -C "$clone" remote get-url origin 2>/dev/null)" || [[ ! "$url" =~ $MYR_CI_ORIGIN_RE ]]; then
    CI_CHECK_REASON="remote 'origin' of the clone does not point to github.com/itkadr-git/myrmidon, so main cannot be trusted"
    return 1
  fi
  if ! GIT_TERMINAL_PROMPT=0 with_timeout git -C "$clone" fetch --quiet --no-tags origin '+refs/heads/main:refs/remotes/origin/main' >/dev/null 2>&1; then
    CI_CHECK_REASON="git fetch origin main failed (no network or no access?), so commit ${rev:0:12} cannot be checked against main"
    return 1
  fi
  if git -C "$clone" merge-base --is-ancestor "$rev" refs/remotes/origin/main >/dev/null 2>&1; then
    return 0
  fi
  if ! tags="$(GIT_TERMINAL_PROMPT=0 with_timeout git -C "$clone" ls-remote --tags origin 'refs/tags/myr-v*' 2>/dev/null)"; then
    CI_CHECK_REASON="commit ${rev:0:12} is not on origin/main and the release tags of origin could not be read"
    return 1
  fi
  # An annotated tag is listed twice; the line ending in ^{} carries the commit.
  while read -r sha name; do
    if [[ "$sha" == "$rev" && "$name" =~ $tag_re ]]; then
      return 0
    fi
  done <<<"$tags"
  CI_CHECK_REASON="commit ${rev:0:12} of the image is neither on origin/main nor tagged myr-v*: it was built from a branch or from code that never went through a PR"
  return 1
}

# The whole check for one image reference (registry, labels, commit). Returns 0 when
# the image is a CI image; otherwise sets CI_CHECK_REASON and returns 1.
check_ci_image() {
  local ref="$1" out err rc=0 labels revision image_source
  CI_CHECK_REASON="" CI_IMAGE_REVISION="" CI_IMAGE_VERSION=""

  if [[ "$ref" != *@* || "${ref%@*}" != "$MYR_CI_IMAGE" ]] || ! valid_digest "${ref#*@}"; then
    CI_CHECK_REASON="$(image_ref_problem "$ref")"
    return 1
  fi

  # Reads the manifest and config from the registry without pulling the layers. A
  # locally built image is not there.
  err="$(mktemp)"
  out="$(with_timeout docker buildx imagetools inspect "$ref" --format '{{json .Image}}' 2>"$err")" || rc=$?
  if ((rc != 0)); then
    out="$(tail -n1 "$err")"
    out="${out#ERROR: }"
    CI_CHECK_REASON="$ref cannot be read from the registry (never pushed there, deleted, or the registry is unreachable): ${out#"$ref": }"
    rm -f "$err"
    return 1
  fi
  rm -f "$err"

  labels="$(jq -c '[.. | objects | select(has("Labels")) | .Labels | select(type == "object")] | first // {}' <<<"$out" 2>/dev/null)" || labels="{}"
  revision="$(jq -r '."org.opencontainers.image.revision" // ""' <<<"$labels" 2>/dev/null)" || revision=""
  image_source="$(jq -r '."org.opencontainers.image.source" // ""' <<<"$labels" 2>/dev/null)" || image_source=""
  CI_IMAGE_VERSION="$(jq -r '."org.opencontainers.image.version" // ""' <<<"$labels" 2>/dev/null)" || CI_IMAGE_VERSION=""

  if [[ ! "$revision" =~ ^[0-9a-f]{40}$ ]]; then
    CI_CHECK_REASON="$ref has no org.opencontainers.image.revision label with a full commit sha, so it was not built by the CI image workflow"
    return 1
  fi
  if [[ "$image_source" != "$MYR_CI_SOURCE" ]]; then
    CI_CHECK_REASON="$ref has org.opencontainers.image.source '${image_source:-<none>}', expected $MYR_CI_SOURCE: it was not built by the CI image workflow"
    return 1
  fi
  CI_IMAGE_REVISION="$revision"
  commit_is_reviewed "$revision"
}

# Loads the settings file (see deploy.env.example) and applies defaults.
load_config() {
  local file="$1"
  [[ -n "$file" ]] || die "--config <file> is required (see scripts/myrmidon/deploy/deploy.env.example)"
  [[ -f "$file" ]] || die "config file not found: $file"
  # shellcheck disable=SC1090
  source "$file"
  : "${MYRMIDON_IMAGE:=ghcr.io/itkadr-git/myrmidon}"
  : "${COMPOSE_DIR:?COMPOSE_DIR is required}"
  : "${COMPOSE_SERVICE:?COMPOSE_SERVICE is required}"
  : "${COMPOSE_FILES:=docker-compose.yml}"
  : "${COMPOSE_OVERRIDE_FILE:=docker-compose.myrmidon-image.yml}"
  : "${HEALTH_URL:?HEALTH_URL is required}"
  : "${HEALTH_TIMEOUT_SEC:=300}"
  : "${HEALTH_TOKEN_FILE:=}"
  : "${STATE_DIR:=$COMPOSE_DIR/.myrmidon-deploy}"
  : "${DUMP_DIR:=$STATE_DIR/dumps}"
  : "${DUMP_COMMAND:=}"
  : "${DUMP_MIN_BYTES:=1}"
  : "${RESTORE_COMMAND:=}"
  : "${MAINTENANCE_MODE:=pause}"
  : "${MAINTENANCE_API_URL:=}"
  : "${MAINTENANCE_TOKEN_FILE:=$HEALTH_TOKEN_FILE}"
  : "${MAINTENANCE_DRAIN_TIMEOUT_SEC:=1800}"
  : "${MAINTENANCE_ENTER_COMMAND:=}"
  : "${MAINTENANCE_EXIT_COMMAND:=}"
  : "${MAINTENANCE_PAUSE_SEC:=0}"
  : "${RUNNING_RUNS_COMMAND:=}"
  : "${RUNS_WAIT_TIMEOUT_SEC:=1800}"
  : "${ALLOW_UNKNOWN_RUNS:=0}"
  : "${POLL_INTERVAL_SEC:=5}"
  case "$MAINTENANCE_MODE" in
    api|hook|pause) ;;
    *) die "MAINTENANCE_MODE must be api, hook or pause (got $MAINTENANCE_MODE)" ;;
  esac
  if [[ "$MAINTENANCE_MODE" == "api" && -z "$MAINTENANCE_API_URL" ]]; then
    die "MAINTENANCE_MODE=api needs MAINTENANCE_API_URL"
  fi
  OVERRIDE_PATH="$COMPOSE_DIR/$COMPOSE_OVERRIDE_FILE"
  PREVIOUS_FILE="$STATE_DIR/previous-digest"
  PREVIOUS_IMAGE_FILE="$STATE_DIR/previous-image"
  HISTORY_FILE="$STATE_DIR/history.log"
}

compose() {
  local args=(compose --project-directory "$COMPOSE_DIR")
  local f
  IFS=':' read -r -a _files <<<"$COMPOSE_FILES"
  for f in "${_files[@]}"; do args+=(-f "$COMPOSE_DIR/$f"); done
  args+=(-f "$OVERRIDE_PATH")
  docker "${args[@]}" "$@"
}

# Digest currently pinned in the override file, or empty.
current_digest() {
  [[ -f "$OVERRIDE_PATH" ]] || return 0
  grep -Eo '@sha256:[0-9a-f]{64}' "$OVERRIDE_PATH" | head -n1 | cut -c2- || true
}

# Full image reference currently in the override file (any repository, tag or
# digest), or empty. myrmidon(R4): lets the first deploy remember a vendor image.
current_image() {
  [[ -f "$OVERRIDE_PATH" ]] || return 0
  sed -nE 's/^[[:space:]]*image:[[:space:]]*([^[:space:]#]+).*/\1/p' "$OVERRIDE_PATH" | head -n1
}

# Writes the override file: the only line that changes between deploys is `image:`.
write_override_ref() {
  local ref="$1" tmp
  tmp="$(mktemp "$OVERRIDE_PATH.XXXXXX")"
  {
    echo "# Managed by scripts/myrmidon/deploy. Only the image line changes."
    echo "services:"
    echo "  $COMPOSE_SERVICE:"
    echo "    image: $ref"
  } >"$tmp"
  mv -f "$tmp" "$OVERRIDE_PATH"
}

write_override() { write_override_ref "$MYRMIDON_IMAGE@$1"; }

auth_header_args() {
  local file="$1"
  if [[ -n "$file" ]]; then
    [[ -r "$file" ]] || die "token file not readable: $file"
    printf '%s\n' "-H" "Authorization: Bearer $(tr -d '\r\n' <"$file")"
  fi
}

http_get() {
  local url="$1" token_file="${2:-}"
  local -a auth=()
  mapfile -t auth < <(auth_header_args "$token_file")
  curl -fsS --max-time 10 "${auth[@]}" "$url"
}

http_post_json() {
  local url="$1" body="$2" token_file="${3:-}"
  local -a auth=()
  mapfile -t auth < <(auth_header_args "$token_file")
  curl -fsS --max-time 30 -X POST -H 'Content-Type: application/json' "${auth[@]}" --data "$body" "$url"
}

# Version and commit the server reports are stored as image labels by the
# image workflow (org.opencontainers.image.version / .revision).
image_label() {
  local ref="$1" label="$2"
  docker image inspect --format "{{ index .Config.Labels \"$label\" }}" "$ref"
}

# --- local images (ROLLBACK-LOCAL) -------------------------------------------
# myrmidon(ROLLBACK-LOCAL): rollback support for images that only exist on the
# deploy host (pre-1.1.0 builds are not in the registry). Nothing here pulls:
# the checks read the local docker daemon only.

# Is the reference present on the local docker daemon? Prints nothing; rc 0/1.
local_image_exists() {
  docker image inspect "$1" >/dev/null 2>&1
}

# Local tags of one repository (e.g. ghcr.io/itkadr-git/myrmidon), newest
# first, without duplicates. May print nothing when there are none.
local_image_tags() {
  local repo="$1"
  docker image ls "$repo" --format '{{.Tag}}' 2>/dev/null | grep -v '^<none>$' || true
}

# Dies with a readable message listing what is actually on the host, so a typo
# in a tag does not turn into a bare "No such image". Succeeds (rc 0) when the
# reference is on the daemon.
require_local_image() {
  local ref="$1" repo tags
  if [[ "$ref" == *@sha256:* ]]; then
    repo="${ref%@*}"
  else
    repo="${ref%%:*}"
  fi
  if ! local_image_exists "$ref"; then
    if [[ "$ref" == *@sha256:* ]]; then
      die "image is not on the local docker daemon: $ref
Available local digests of $repo:
$(docker image ls "$repo" --format '{{.ID}}' 2>/dev/null | grep . | sort -u || true)
Rollback to an image that is on the host (docker image ls $repo), or drop --local to pull from the registry"
    fi
    tags="$(local_image_tags "$repo" | paste -sd, -)"
    die "image is not on the local docker daemon: $ref
Available local tags of $repo: ${tags:-<none>}
Rollback to a tag that is on the host (docker image ls $repo), or drop --local to pull from the registry"
  fi
}

maintenance_enter() {
  local reason="$1"
  case "$MAINTENANCE_MODE" in
    api)
      local body
      body="$(jq -cn --arg reason "$reason" --argjson t "$MAINTENANCE_DRAIN_TIMEOUT_SEC" \
        '{action: "enter", scope: {type: "instance"}, reason: $reason, drainTimeoutSec: $t, onTimeout: "wait"}')"
      run http_post_json "$MAINTENANCE_API_URL" "$body" "$MAINTENANCE_TOKEN_FILE" >/dev/null
      ;;
    hook)
      [[ -n "$MAINTENANCE_ENTER_COMMAND" ]] || die "MAINTENANCE_MODE=hook needs MAINTENANCE_ENTER_COMMAND"
      run env MYRMIDON_DEPLOY_REASON="$reason" bash -c "$MAINTENANCE_ENTER_COMMAND"
      ;;
    pause)
      log "maintenance: no maintenance API configured; pausing ${MAINTENANCE_PAUSE_SEC}s (MAINTENANCE_MODE=pause)"
      run sleep "$MAINTENANCE_PAUSE_SEC"
      ;;
  esac
}

maintenance_exit() {
  case "$MAINTENANCE_MODE" in
    api)
      run http_post_json "$MAINTENANCE_API_URL" '{"action":"exit","scope":{"type":"instance"}}' "$MAINTENANCE_TOKEN_FILE" >/dev/null
      ;;
    hook)
      [[ -n "$MAINTENANCE_EXIT_COMMAND" ]] || die "MAINTENANCE_MODE=hook needs MAINTENANCE_EXIT_COMMAND"
      run bash -c "$MAINTENANCE_EXIT_COMMAND"
      ;;
    pause) log "maintenance: nothing to exit (MAINTENANCE_MODE=pause)" ;;
  esac
}

# Prints the number of running agent runs, or nothing when unknown.
running_runs() {
  if [[ -n "$RUNNING_RUNS_COMMAND" ]]; then
    bash -c "$RUNNING_RUNS_COMMAND"
  elif [[ "$MAINTENANCE_MODE" == "api" ]]; then
    http_get "$MAINTENANCE_API_URL" "$MAINTENANCE_TOKEN_FILE" | jq -r '.instance.runningRuns // empty'
  fi
}

wait_for_idle_runs() {
  # myrmidon(DEPLOY-TIMEOUT-EXIT): returns 1 instead of dying, so the caller
  # (deploy.sh) can lift maintenance before it aborts. Dying here would strand
  # the board in maintenance mode, because maintenance_enter already ran.
  local deadline=$((SECONDS + RUNS_WAIT_TIMEOUT_SEC)) count rc
  while :; do
    # myrmidon(R4): a broken counter must not let the image switch cut live runs.
    rc=0
    count="$(running_runs)" || rc=$?
    count="$(tr -d '[:space:]' <<<"$count")"
    if ((rc != 0)) || [[ -z "$count" ]]; then
      if [[ "$ALLOW_UNKNOWN_RUNS" == "1" ]]; then
        log "runs: cannot count running runs (exit $rc); ALLOW_UNKNOWN_RUNS=1, not waiting"
        return 0
      fi
      log "ERROR: runs: cannot count running runs (exit $rc, output '${count}'); fix RUNNING_RUNS_COMMAND / MAINTENANCE_MODE=api or set ALLOW_UNKNOWN_RUNS=1; image not changed"
      return 1
    fi
    [[ "$count" =~ ^[0-9]+$ ]] || { log "ERROR: running runs count is not a number: $count"; return 1; }
    if ((count == 0)); then
      log "runs: no runs in progress"
      return 0
    fi
    ((SECONDS < deadline)) || { log "ERROR: runs: $count run(s) still in progress after ${RUNS_WAIT_TIMEOUT_SEC}s; deploy aborted before changing the image"; return 1; }
    log "runs: waiting for $count run(s) to finish"
    sleep "$POLL_INTERVAL_SEC"
  done
}

# Takes the pre-deploy dump and refuses to continue when it is missing or empty.
take_dump() {
  local label="$1"
  [[ -n "$DUMP_COMMAND" ]] || die "DUMP_COMMAND is not set; refusing to deploy without a database dump"
  mkdir -p "$DUMP_DIR"
  local file
  file="$DUMP_DIR/myrmidon-$(date -u +%Y%m%dT%H%M%SZ)-$label.dump"
  log "dump: $file"
  DUMP_FILE="$file" bash -c "$DUMP_COMMAND" || die "dump command failed; image not changed"
  [[ -f "$file" ]] || die "dump command did not create $file; image not changed"
  local size
  size="$(wc -c <"$file" | tr -d ' ')"
  if ((size < DUMP_MIN_BYTES)); then
    die "dump $file is empty or too small ($size bytes < $DUMP_MIN_BYTES); image not changed"
  fi
  log "dump: ok ($size bytes)"
  LAST_DUMP_FILE="$file"
}

record_history() {
  mkdir -p "$STATE_DIR"
  printf '%s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" >>"$HISTORY_FILE"
}
