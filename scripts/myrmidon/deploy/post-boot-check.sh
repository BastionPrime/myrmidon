#!/usr/bin/env bash
# Post-boot check. A systemd oneshot runs this after docker,
# paperclip.service and nginx: it proves the machine came up in the state the
# release intends, and files a job for the on-duty role when it did not.
# It never messages the owner directly.
#
#   post-boot-check.sh --config deploy.env [--json-out <file>] [--timeout 300]
#
# Checks (each can be disabled when the installation does not run that
# component, via the same deploy.env; nothing is silently skipped):
#   1. the board /api/health reports status ok AND the version equals the
#      version of the image pinned in the compose override file (image.yml /
#      COMPOSE_OVERRIDE_FILE) - the 01.10 incident was exactly a boot that
#      brought up a different image than the deploy had pinned;
#   2. the dockergate container runs the image digest recorded in
#      DOCKERGATE_EXPECT_IMAGE (empty = the release was deployed without
#      dockergate, the check is off with a log line);
#   3. every bot container exists and is running, and dockergate shows no
#      denies since boot (the A2 contract check, 01.10 incident #2);
#   4. nginx, LiteLLM, RAGFlow and Hindsight are up (nginx: the unit passed
#      After=docker and a port answers; the others: their health endpoints);
#   5. the DNS names other services use resolve inside the docker networks:
#      mysql, es01, paperclip-server-1 (the RAGFlow lesson of 01.10).
#
# On any failure the script exits 1, prints each failed check, and (when
# --json-out is given, and by the systemd unit to $STATE_DIR/post-boot-check.json)
# writes a machine-readable report meant for the board issue router, not for
# the owner: the on-duty role reads it.
set -euo pipefail
# shellcheck source=lib.sh source-path=SCRIPTDIR
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

json_out="" timeout_sec=300
while (($#)); do
  case "$1" in
    --config) config="$2"; shift 2 ;;
    --json-out) json_out="$2"; shift 2 ;;
    --timeout) timeout_sec="$2"; shift 2 ;;
    -h|--help) sed -n '2,29p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
load_config "$config"
require_cmd docker curl jq

# --- the checks, collected so the report lists every failure, not just the first
declare -a FAILURES=() PASSED=()
check() { # check <name> <command...>
  local name="$1"; shift
  if "$@"; then
    PASSED+=("$name")
    log "post-boot: $name ok"
  else
    FAILURES+=("$name")
    log "post-boot: $name FAILED"
  fi
}

# --- 1. board health vs the pinned image -------------------------------------
# The version the override file pins: read the image label of the pinned
# digest without pulling (registry read), so a boot that resurrected another
# image is caught even when the board answers ok.
pinned_ref="$(current_image)"
running_ref=""
if docker inspect --format '{{.Config.Image}}' "${COMPOSE_SERVICE}-board-check" >/dev/null 2>&1; then :; fi
running_ref="$(docker ps --filter "name=${COMPOSE_SERVICE}" --format '{{.Image}}' 2>/dev/null | head -n1 || true)"

board_health_ok() {
  local body version
  body="$(http_get "$HEALTH_URL" "$HEALTH_TOKEN_FILE" 2>/dev/null || true)"
  [[ "$(jq -r '.status // empty' <<<"$body" 2>/dev/null || true)" == "ok" ]] || return 1
  version="$(jq -r '.version // empty' <<<"$body" 2>/dev/null || true)"
  [[ -z "$version" ]] && return 1
  [[ -n "$pinned_ref" ]] || return 0
  # The running container must run the pinned reference (digest or tag).
  [[ -n "$running_ref" ]] || return 1
  [[ "$running_ref" == *"${pinned_ref##*/}"* || "$pinned_ref" == *"${running_ref##*/}"* ]]
}

# --- 2. dockergate image ------------------------------------------------------
dockergate_ok() {
  [[ -n "${DOCKERGATE_EXPECT_IMAGE:-}" ]] || { log "post-boot: dockergate: DOCKERGATE_EXPECT_IMAGE not set, check off (release without dockergate change)"; return 0; }
  local running
  running="$(docker ps --filter "name=dockergate" --format '{{.Image}}' 2>/dev/null | head -n1 || true)"
  [[ -n "$running" ]] || return 1
  [[ "$running" == "$DOCKERGATE_EXPECT_IMAGE" ]]
}

# --- 3. bot containers and dockergate denies ---------------------------------
bots_ok() {
  local total running
  total="$(docker ps -a --filter "name=myrmidon-bot-" --format '{{.Names}}' 2>/dev/null | wc -l | tr -d ' ')"
  running="$(docker ps --filter "name=myrmidon-bot-" --format '{{.Names}}' 2>/dev/null | wc -l | tr -d ' ')"
  if ((total == 0)); then
    log "post-boot: bots: no bot containers exist; if this host runs bots, the reconciler did not create them"
    return 1
  fi
  ((running == total)) || return 1
  # dockergate denies since boot: the gate logs a deny line per refused apply.
  if [[ -n "${DOCKERGATE_LOGS_COMMAND:-}" ]]; then
    local denies
    denies="$(bash -c "$DOCKERGATE_LOGS_COMMAND" 2>/dev/null | grep -ci 'deny' || true)"
    [[ "$denies" =~ ^[0-9]+$ ]] || return 1
    ((denies == 0)) || { log "post-boot: bots: $denies dockergate deny line(s) since boot"; return 1; }
  fi
  return 0
}

# --- 4. nginx / LiteLLM / RAGFlow / Hindsight --------------------------------
nginx_ok() {
  [[ -n "${NGINX_CHECK_URL:-}" ]] || { log "post-boot: nginx: NGINX_CHECK_URL not set, check off"; return 0; }
  curl -fsS --max-time 10 -o /dev/null "${NGINX_CHECK_URL%%\#*}"
}
litellm_ok() {
  [[ -n "${LITELLM_CHECK_URL:-}" ]] || { log "post-boot: litellm: LITELLM_CHECK_URL not set, check off"; return 0; }
  curl -fsS --max-time 10 -o /dev/null "${LITELLM_CHECK_URL%%\#*}"
}
ragflow_ok() {
  [[ -n "${RAGFLOW_CHECK_URL:-}" ]] || { log "post-boot: ragflow: RAGFLOW_CHECK_URL not set, check off"; return 0; }
  curl -fsS --max-time 10 -o /dev/null "${RAGFLOW_CHECK_URL%%\#*}"
}
hindsight_ok() {
  [[ -n "${HINDSIGHT_CHECK_URL:-}" ]] || { log "post-boot: hindsight: HINDSIGHT_CHECK_URL not set, check off"; return 0; }
  curl -fsS --max-time 10 -o /dev/null "${HINDSIGHT_CHECK_URL%%\#*}"
}

# --- 5. DNS names other services use -----------------------------------------
dns_names_ok() {
  local -a names=()
  local n rc=0
  IFS=' ' read -r -a names <<<"${DNS_CHECK_NAMES:-mysql es01 paperclip-server-1}"
  for n in "${names[@]}"; do
    if ! docker run --rm --network "${DNS_CHECK_NETWORK:-myrmidon}" \
      "${DNS_CHECK_IMAGE:-busybox:latest}" getent hosts "$n" >/dev/null 2>&1; then
      log "post-boot: dns: $n does not resolve on network ${DNS_CHECK_NETWORK:-myrmidon}"
      rc=1
    fi
  done
  return $rc
}

# --- systemd-failed check (part of the acceptance: systemctl --failed empty) --
systemd_failed_ok() {
  command -v systemctl >/dev/null 2>&1 || return 0
  [[ "$(systemctl list-units --state=failed --no-legend 2>/dev/null | wc -l | tr -d ' ')" == "0" ]]
}

deadline=$((SECONDS + timeout_sec))
while ((SECONDS < deadline)); do
  if board_health_ok; then break; fi
  sleep 5
done

check "board health vs pinned image" board_health_ok
check "dockergate image" dockergate_ok
check "bot containers running, no dockergate denies" bots_ok
check "nginx up" nginx_ok
check "litellm up" litellm_ok
check "ragflow up" ragflow_ok
check "hindsight up" hindsight_ok
check "dns names resolve (mysql es01 paperclip-server-1)" dns_names_ok
check "systemctl --failed is empty" systemd_failed_ok

json_out="${json_out:-$STATE_DIR/post-boot-check.json}"
if [[ -n "$json_out" ]]; then
  mkdir -p "$(dirname "$json_out")" 2>/dev/null || true
  local_passed="$(printf '%s\n' "${PASSED[@]}" | jq -R . | jq -s . | jq 'map(select(length > 0))')"
  local_failed="$(printf '%s\n' "${FAILURES[@]}" | jq -R . | jq -s . | jq 'map(select(length > 0))')"
  jq -n --argjson ts "$(date -u +%s)" \
    --arg pinned "$pinned_ref" --arg running "$running_ref" \
    --argjson passed "$local_passed" \
    --argjson failed "$local_failed" \
    '{timestamp: $ts, pinnedImage: $pinned, runningImage: $running, passed: $passed, failed: $failed, ok: ($failed | length == 0)}' \
    >"$json_out" 2>/dev/null || true
fi

if ((${#FAILURES[@]})); then
  log "post-boot check FAILED (${#FAILURES[@]} check(s)); report: ${json_out:-<none>}; this goes to the on-duty role, not the owner"
  exit 1
fi
log "post-boot check passed (${#PASSED[@]} check(s)); report: ${json_out:-<none>}"
