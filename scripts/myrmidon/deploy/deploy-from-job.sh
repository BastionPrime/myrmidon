#!/usr/bin/env bash
# Host executor for deploys started from the board interface (R5-A).
#
#   deploy-from-job.sh --config deploy.env [--timeout 86400] [--dry-run]
#
# The board (deploy-jobs module, server/src/myrmidon/deploy-jobs) never runs
# docker itself: it verifies the image digest, opens the maintenance window
# and writes a job into its state. This script is the host half: it polls the
# board API for a dispatchable job, waits for the maintenance window to be
# fully on, runs the SAME deploy.sh (with its mandatory CI-image check, dump,
# drain, health verification) for the job digest, and reports the outcome as a
# small JSON file the board reads (STATE_DIR/job-<id>.json, mounted read-only
# into the board container as MYRMIDON_DEPLOY_REPORTS_DIR).
#
# Report phases: claimed → switching → switched → health-ok | health-failed |
# error. The board marks the job succeeded only when its own /api/health
# agrees with the reported version and commit, so a lying report cannot close
# a failed deploy.
#
# The script exits when no dispatchable job is left and --once was given, or
# keeps polling (one executor per host; a second instance refuses to start by
# holding STATE_DIR/executor.lock).
#
# Requires: bash 4+, docker, curl, jq, git (the same tools as deploy.sh).
set -euo pipefail
# shellcheck source=lib.sh source-path=SCRIPTDIR
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

config="" timeout_sec=86400 once=0
DRY_RUN=0
while (($#)); do
  case "$1" in
    --config) config="$2"; shift 2 ;;
    --timeout) timeout_sec="$2"; shift 2 ;;
    --once) once=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
load_config "$config"
require_cmd docker curl jq

# Board API: the same endpoints the deploy scripts already use for maintenance.
: "${BOARD_API_URL:?BOARD_API_URL is required (the board API, for example http://127.0.0.1:3100/api)}"
BOARD_TOKEN_FILE="${BOARD_TOKEN_FILE:-$HEALTH_TOKEN_FILE}"
if [[ -n "$BOARD_TOKEN_FILE" ]]; then
  [[ -r "$BOARD_TOKEN_FILE" ]] || die "token file not readable: $BOARD_TOKEN_FILE"
fi

REPORT_DIR="${REPORT_DIR:-$STATE_DIR}"
JOBS_URL="$BOARD_API_URL/myrmidon/deploy-jobs"
MAINT_URL="${MAINTENANCE_API_URL:-$BOARD_API_URL/myrmidon/maintenance}"

report() { # report <jobId> <phase> [detail] [version] [commit]
  local job="$1" phase="$2" detail="${3:-}" version="${4:-}" commit="${5:-}"
  local file="$REPORT_DIR/job-$job.json"
  if [[ "$DRY_RUN" == "1" ]]; then
    plan "report $phase -> $file"
    return 0
  fi
  local tmp
  tmp="$(mktemp "$file.XXXXXX")"
  jq -cn --arg jobId "$job" --arg phase "$phase" --arg detail "$detail" \
      --arg version "$version" --arg commit "$commit" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      '{jobId: $jobId, phase: $phase, detail: $detail, version: (if $version == "" then null else $version end), commit: (if $commit == "" then null else $commit end), at: $at}' >"$tmp"
  mv -f "$tmp" "$file"
}

board_get() { # board_get <url> -> body on stdout
  local url="$1"
  if [[ -n "$BOARD_TOKEN_FILE" ]]; then
    curl -fsS --max-time 30 -H "Authorization: Bearer $(cat "$BOARD_TOKEN_FILE")" "$url"
  else
    curl -fsS --max-time 30 "$url"
  fi
}

# One executor per host: the lock directory lives next to the state files.
LOCK_DIR="$STATE_DIR/executor.lock"
if [[ "$DRY_RUN" != "1" ]]; then
  mkdir -p "$STATE_DIR"
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    die "another deploy executor holds $LOCK_DIR; refusing to run two"
  fi
  trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT
fi

dispatchable() { # prints "jobId digest" of the job to run, or nothing
  local body
  body="$(board_get "$JOBS_URL")" || return 0
  jq -r '
    (.job // null) as $j
    | if $j == null then empty
      elif ($j.status == "maintenance_on" or $j.status == "running") then "\($j.id) \($j.digest)"
      else empty end
  ' <<<"$body"
}

window_state() {
  board_get "$MAINT_URL" | jq -r '.instance.state // "off"'
}

run_deploy() { # run_deploy <jobId> <digest>
  local job="$1" digest="$2" rc=0
  report "$job" claimed "host executor picked the job"
  # The window must be fully on before the image switch: same rule as the UI.
  local waited=0 state
  while :; do
    state="$(window_state)" || state="off"
    [[ "$state" == "on" ]] && break
    if ((waited >= timeout_sec)); then
      report "$job" error "maintenance window never reached on within ${timeout_sec}s (state $state)"
      return 1
    fi
    sleep "${POLL_INTERVAL_SEC:-5}"
    waited=$((waited + POLL_INTERVAL_SEC + 1))
  done
  report "$job" switching "switching the image"
  if [[ "$DRY_RUN" == "1" ]]; then
    plan "would run: $MYR_SCRIPT_DIR/deploy.sh --config $config --digest $digest"
    report "$job" health-ok "dry run" "" ""
    return 0
  fi
  set +e
  "$MYR_SCRIPT_DIR/deploy.sh" --config "$config" --digest "$digest" 2>"$STATE_DIR/job-$job.log"
  rc=$?
  set -e
  local version commit
  version="$(image_label "$MYR_CI_IMAGE@$digest" org.opencontainers.image.version || true)"
  commit="$(image_label "$MYR_CI_IMAGE@$digest" org.opencontainers.image.revision || true)"
  if ((rc == 0)); then
    report "$job" health-ok "deploy.sh finished" "$version" "$commit"
  else
    report "$job" health-failed "deploy.sh failed with exit $rc; see $STATE_DIR/job-$job.log" "$version" "$commit"
  fi
  return "$rc"
}

log "executor: polling $JOBS_URL (timeout ${timeout_sec}s$( ((once)) && printf ', one pass' ))"
deadline=$((SECONDS + timeout_sec))
while :; do
  found="$(dispatchable)" || true
  if [[ -n "$found" ]]; then
    read -r job digest <<<"$found"
    log "executor: job $job, digest ${digest:0:19}"
    run_deploy "$job" "$digest" || true
    ((once)) && exit 0
    continue
  fi
  ((once)) && exit 0
  if ((SECONDS >= deadline)); then
    log "executor: no job within ${timeout_sec}s; exiting"
    exit 0
  fi
  sleep "${POLL_INTERVAL_SEC:-5}"
done
