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
      die "runs: cannot count running runs (exit $rc, output '${count}'); fix RUNNING_RUNS_COMMAND / MAINTENANCE_MODE=api or set ALLOW_UNKNOWN_RUNS=1; image not changed"
    fi
    [[ "$count" =~ ^[0-9]+$ ]] || die "running runs count is not a number: $count"
    if ((count == 0)); then
      log "runs: no runs in progress"
      return 0
    fi
    ((SECONDS < deadline)) || die "runs: $count run(s) still in progress after ${RUNS_WAIT_TIMEOUT_SEC}s; deploy aborted before changing the image"
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
