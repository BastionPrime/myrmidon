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
  # RELEASE-GATE: the reference-format half is board-specific (image_ref_problem
  # speaks about the board repository); the registry/labels/commit half is the
  # same for every component image, so it lives in check_ci_image_for_repo.
  local ref="$1"
  if [[ "$ref" != *@* || "${ref%@*}" != "$MYR_CI_IMAGE" ]] || ! valid_digest "${ref#*@}"; then
    CI_CHECK_REASON="$(image_ref_problem "$ref")"
    return 1
  fi
  check_ci_image_for_repo "$MYR_CI_IMAGE" "$ref"
}

# RELEASE-GATE (the 01.10 incident): the same CI-image proof for a component
# image (dockergate, fleetd) of the release: in the registry, revision and
# source labels set by the CI workflows, commit on origin/main or a myr-v* tag.
# Takes the expected repository plus a repo@sha256:<64 hex> reference.
check_ci_image_for_repo() {
  local expected_repo="$1" ref="$2" out err rc=0 labels revision image_source
  CI_CHECK_REASON="" CI_IMAGE_REVISION="" CI_IMAGE_VERSION=""

  if [[ "$ref" != *@* || "${ref%@*}" != "$expected_repo" ]] || ! valid_digest "${ref#*@}"; then
    CI_CHECK_REASON="$ref is not $expected_repo@sha256:<64 lowercase hex>"
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

# The boot unit (one boot path). The board container is started at boot by a
# systemd unit; the incident of 01.10 was exactly a unit that read a *different*
# compose file than the one deploy.sh maintains, so an old vendor image replaced
# the board for 7 minutes. verify_boot_unit() refuses a deploy unless the unit
# points at the same compose files (COMPOSE_DIR + COMPOSE_FILES + the override)
# this deploy manages, and can install the canonical unit from the template.
# Settings (all optional, see deploy.env.example; read by load_config):
#   SYSTEMD_UNIT_NAME     default paperclip.service
#   SYSTEMD_UNIT_DIR      default /etc/systemd/system (sandboxable for stands)
#   SYSTEMD_UNIT_INSTALL  1 = install the canonical unit from the template when
#                         none exists yet (needs root); unset = verify only.
#                         A unit that exists but does not match is ALWAYS a
#                         refusal, even with SYSTEMD_UNIT_INSTALL=1: repairing a
#                         foreign unit silently is how the incident happened.

# Fills the paperclip.service template: __COMPOSE_DIR__, __COMPOSE_FILE_ARGS__
# (the colon-separated COMPOSE_FILES expanded into -f arguments plus the
# override file) and __COMPOSE_SERVICE__.
render_boot_unit() {
  local -a files=()
  local f
  IFS=':' read -r -a _boot_files <<<"$COMPOSE_FILES"
  for f in "${_boot_files[@]}"; do files+=("$COMPOSE_DIR/$f"); done
  files+=("$OVERRIDE_PATH")
  local file_args=""
  for f in "${files[@]}"; do file_args+="${file_args:+ }-f $f"; done
  sed -e "s|__COMPOSE_DIR__|$COMPOSE_DIR|g" \
    -e "s|__COMPOSE_FILE_ARGS__|$file_args|g" \
    -e "s|__COMPOSE_SERVICE__|$COMPOSE_SERVICE|g" \
    "$MYR_SCRIPT_DIR/paperclip.service.template"
}

# The install path of the unit (absolute).
boot_unit_path() { printf '%s/%s\n' "${SYSTEMD_UNIT_DIR%/}" "$SYSTEMD_UNIT_NAME"; }

# Checks the installed unit against the compose set this deploy manages.
# Returns 0 and sets BOOT_UNIT_OK=1 when the unit is the canonical one (its
# ExecStart names exactly COMPOSE_DIR, every COMPOSE_FILES entry and the
# override, in any order, with no other compose file); returns 1 with
# BOOT_UNIT_REASON set otherwise. Missing unit, uninstalled systemd or a
# foreign unit are all "not verified": the deploy refuses.
verify_boot_unit() {
  BOOT_UNIT_OK=0 BOOT_UNIT_REASON=""
  local unit expected
  unit="$(boot_unit_path)"
  if ! command -v systemctl >/dev/null 2>&1; then
    BOOT_UNIT_REASON="systemctl is not available: the boot unit $SYSTEMD_UNIT_NAME cannot be verified; install it from scripts/myrmidon/deploy/paperclip.service.template or set SYSTEMD_UNIT_INSTALL=1 on a host with systemd"
    return 1
  fi
  if [[ ! -f "$unit" ]]; then
    if [[ "$SYSTEMD_UNIT_INSTALL" == "1" && "$DRY_RUN" != "1" ]]; then
      install_boot_unit || return 1
    else
      BOOT_UNIT_REASON="the boot unit $unit does not exist; install it (SYSTEMD_UNIT_INSTALL=1 or copy scripts/myrmidon/deploy/paperclip.service.template) so the board starts from the compose files this deploy manages"
      return 1
    fi
  fi
  expected="$(render_boot_unit)"
  if [[ "$(cat "$unit")" != "$expected" ]]; then
    BOOT_UNIT_REASON="the boot unit $unit does not match the canonical unit for COMPOSE_DIR=$COMPOSE_DIR (COMPOSE_FILES=$COMPOSE_FILES + $COMPOSE_OVERRIDE_FILE): it may start the board from other compose files, as on 01.10. Fix: SYSTEMD_UNIT_INSTALL=1 on the unit host, or make the unit match scripts/myrmidon/deploy/paperclip.service.template. The deploy is refused while the unit differs (nothing was changed)"
    return 1
  fi
  BOOT_UNIT_OK=1
  return 0
}

# Installs the canonical unit (needs write access to SYSTEMD_UNIT_DIR, i.e.
# root on a real host) and reloads systemd. Existing foreign unit: refusal.
install_boot_unit() {
  local unit
  unit="$(boot_unit_path)"
  if [[ -f "$unit" ]]; then
    BOOT_UNIT_REASON="refusing to overwrite the existing unit $unit with the canonical one automatically: a foreign unit is exactly the 01.10 incident; remove or fix it by hand, then deploy"
    return 1
  fi
  if ! mkdir -p "$SYSTEMD_UNIT_DIR" 2>/dev/null; then
    BOOT_UNIT_REASON="cannot create $SYSTEMD_UNIT_DIR (need root to install the boot unit $SYSTEMD_UNIT_NAME); install it by hand from scripts/myrmidon/deploy/paperclip.service.template"
    return 1
  fi
  local tmp
  tmp="$(mktemp "$SYSTEMD_UNIT_DIR/.paperclip.XXXXXX")" || { BOOT_UNIT_REASON="cannot write to $SYSTEMD_UNIT_DIR"; return 1; }
  render_boot_unit >"$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$unit" || { rm -f "$tmp"; BOOT_UNIT_REASON="cannot install the unit at $unit"; return 1; }
  if command -v systemctl >/dev/null 2>&1; then
    run systemctl daemon-reload || log "WARNING: systemctl daemon-reload failed; run it by hand"
    run systemctl enable "$SYSTEMD_UNIT_NAME" >/dev/null 2>&1 || log "WARNING: could not enable $SYSTEMD_UNIT_NAME; run: systemctl enable $SYSTEMD_UNIT_NAME"
  fi
  log "boot unit installed: $unit (from paperclip.service.template; After=docker.service, reads the compose files of this deploy)"
  return 0
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
  # myrmidon(DRAIN-INTERRUPT): a planned deploy must not wait for long runs. In
  # `interrupt_and_retry` (the default) the window drains for the short grace
  # below and then interrupts whatever is still running; the interrupted runs
  # are retried when the window closes. `wait` keeps the old behaviour: admission
  # stays closed and the drain waits for the long timeout instead.
  : "${MAINTENANCE_ON_TIMEOUT:=interrupt_and_retry}"
  : "${MAINTENANCE_DRAIN_GRACE_SEC:=300}"
  : "${MAINTENANCE_DRAIN_TIMEOUT_SEC:=1800}"
  : "${MAINTENANCE_ENTER_COMMAND:=}"
  : "${MAINTENANCE_EXIT_COMMAND:=}"
  : "${MAINTENANCE_PAUSE_SEC:=0}"
  : "${MAINTENANCE_EXIT_WAIT_SEC:=120}"
  : "${RUNNING_RUNS_COMMAND:=}"
  : "${RUNS_WAIT_TIMEOUT_SEC:=1800}"
  : "${ALLOW_UNKNOWN_RUNS:=0}"
  : "${POLL_INTERVAL_SEC:=5}"
  : "${SYSTEMD_UNIT_NAME:=paperclip.service}"
  : "${SYSTEMD_UNIT_DIR:=/etc/systemd/system}"
  : "${SYSTEMD_UNIT_INSTALL:=}"
  case "$MAINTENANCE_MODE" in
    api|hook|pause) ;;
    *) die "MAINTENANCE_MODE must be api, hook or pause (got $MAINTENANCE_MODE)" ;;
  esac
  # myrmidon(DRAIN-INTERRUPT): reject a typo instead of silently keeping the
  # default interrupt mode (or silently switching a wait operator to interrupt).
  case "$MAINTENANCE_ON_TIMEOUT" in
    wait|interrupt_and_retry) ;;
    *) die "MAINTENANCE_ON_TIMEOUT must be wait or interrupt_and_retry (got $MAINTENANCE_ON_TIMEOUT)" ;;
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
  # RELEASE-GATE: the component override files (dockergate, fleetd) ride along
  # when they exist, so one `docker compose` call sees the whole release stack.
  local cf
  for cf in "$COMPOSE_DIR"/docker-compose.myrmidon-dockergate.yml "$COMPOSE_DIR"/docker-compose.myrmidon-fleetd.yml; do
    [[ -f "$cf" ]] && args+=(-f "$cf")
  done
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
      # myrmidon(DRAIN-INTERRUPT): in interrupt mode the drain timeout is the
      # short grace after which the window interrupts what is still running; in
      # wait mode it stays the long timeout the window simply waits out.
      local drain_timeout="$MAINTENANCE_DRAIN_TIMEOUT_SEC"
      if [[ "$MAINTENANCE_ON_TIMEOUT" == "interrupt_and_retry" ]]; then
        drain_timeout="$MAINTENANCE_DRAIN_GRACE_SEC"
      fi
      local body
      body="$(jq -cn --arg reason "$reason" --argjson t "$drain_timeout" --arg o "$MAINTENANCE_ON_TIMEOUT" \
        '{action: "enter", scope: {type: "instance"}, reason: $reason, drainTimeoutSec: $t, onTimeout: $o}')"
      run http_post_json "$MAINTENANCE_API_URL" "$body" "$MAINTENANCE_TOKEN_FILE" >/dev/null
      log "maintenance: entered (onTimeout=$MAINTENANCE_ON_TIMEOUT, drainTimeoutSec=$drain_timeout)"
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
  # myrmidon(EXIT-ASYNC): the exit POST returns as soon as the server marks the
  # window `leaving` (the server finishes the leave asynchronously on its
  # maintenance tick; admission already reopens in `leaving`). The deploy
  # therefore waits on the STATE, not on the HTTP call: poll GET /maintenance
  # until the instance window is gone (state `off`), bounded by
  # MAINTENANCE_EXIT_WAIT_SEC. Without this wait the script reported success
  # while the window was still `leaving`, and the next enter raced the previous
  # exit (409 "still leaving"). A wait timeout does not fail an already
  # switched and healthy deploy: the window is `leaving` (admission open) and
  # the tick retires it, so the timeout is logged loudly and the deploy moves
  # on. A failed POST still aborts (unchanged): the window would stay `on`.
  case "$MAINTENANCE_MODE" in
    api)
      run http_post_json "$MAINTENANCE_API_URL" '{"action":"exit","scope":{"type":"instance"}}' "$MAINTENANCE_TOKEN_FILE" >/dev/null || return 1
      wait_for_maintenance_off \
        || log "WARNING: the exit request was accepted, but the instance window did not retire within ${MAINTENANCE_EXIT_WAIT_SEC}s (MAINTENANCE_EXIT_WAIT_SEC); it stays 'leaving' (admission is open) and the maintenance tick retires it"
      ;;
    hook)
      [[ -n "$MAINTENANCE_EXIT_COMMAND" ]] || die "MAINTENANCE_MODE=hook needs MAINTENANCE_EXIT_COMMAND"
      run bash -c "$MAINTENANCE_EXIT_COMMAND"
      ;;
    pause) log "maintenance: nothing to exit (MAINTENANCE_MODE=pause)" ;;
  esac
}

# myrmidon(EXIT-ASYNC): poll the maintenance status until the instance window
# is retired (state `off`, or no instance window at all), or give up after
# MAINTENANCE_EXIT_WAIT_SEC (default 120). A missing state field means the
# board is not in maintenance — that is success, not something to wait for.
# Returns 1 on timeout so the caller can report it.
wait_for_maintenance_off() {
  local deadline=$((SECONDS + MAINTENANCE_EXIT_WAIT_SEC)) body state
  while :; do
    body="$(http_get "$MAINTENANCE_API_URL" "$MAINTENANCE_TOKEN_FILE" 2>/dev/null)" || body=""
    state="$(jq -r '.instance.state // "off"' <<<"$body" 2>/dev/null || echo off)"
    [[ "$state" == "off" ]] && return 0
    ((SECONDS < deadline)) || { log "maintenance: instance window still '$state' after ${MAINTENANCE_EXIT_WAIT_SEC}s (MAINTENANCE_EXIT_WAIT_SEC)"; return 1; }
    sleep "$POLL_INTERVAL_SEC"
  done
}

# myrmidon(POST-DEPLOY-CHECK): after the image switch, the health check and the
# maintenance exit, prove the deploy did not leave the fleet stalled.
# Read-only against the board API the deploy already talks to. Two facts:
#   1. No issue is `blocked` with an update inside the deploy window
#      (GET /companies/<id>/issues?status=blocked&updatedSince=<deploy start>).
#      A planned restart must not turn in-flight work into blocked; any hit is
#      the failure signature this step exists for.
#   2. The maintenance window retired (`off`): the admission gate that closed
#      during the drain is gone, so the vendor periodic resumeQueuedRuns
#      re-admits what queued up.
# BOARD_API_URL and BOARD_COMPANY_ID are optional: when unset, the check is
# skipped with a log line, so a standalone install without board credentials
# stays deployable. A configured but unreadable board is a degraded deploy, not
# a pass. Returns 1 (and logs "degraded:") when the deploy must be reported
# degraded; 0 on a clean check.
post_deploy_fleet_check() {
  local started_at="$1" rc=0
  if [[ -z "${BOARD_API_URL:-}" || -z "${BOARD_COMPANY_ID:-}" ]]; then
    log "post-deploy check: BOARD_API_URL/BOARD_COMPANY_ID not set; skipping the fleet check (set them in the deploy env to enable)"
    return 0
  fi
  local -a auth=()
  mapfile -t auth < <(auth_header_args "$MAINTENANCE_TOKEN_FILE")
  local body blocked
  body="$(curl -fsS --max-time 30 "${auth[@]}" \
    "$BOARD_API_URL/companies/$BOARD_COMPANY_ID/issues?status=blocked&updatedSince=$started_at&limit=100" 2>/dev/null)" || body=""
  if [[ -z "$body" ]]; then
    log "post-deploy check: board issue list unreadable (BOARD_API_URL=$BOARD_API_URL)"
    log "degraded: board issue list unreadable after deploy"
    return 1
  fi
  blocked="$(jq -r 'if type == "array" then length elif type == "object" and (.issues | type == "array") then (.issues | length) else "?" end' <<<"$body" 2>/dev/null || echo "?")"
  if [[ "$blocked" == "?" || -z "$blocked" ]]; then
    log "post-deploy check: unexpected board answer shape for blocked issues"
    log "degraded: board issue list unreadable after deploy"
    return 1
  fi
  if ((blocked > 0)); then
    log "post-deploy check: $blocked blocked issue(s) updated since the deploy started ($started_at) — inspect them before waking agents by hand"
    log "degraded: $blocked blocked issue(s) in the deploy window"
    rc=1
  fi
  local mstate mbody
  mbody="$(http_get "$MAINTENANCE_API_URL" "$MAINTENANCE_TOKEN_FILE" 2>/dev/null)" || mbody=""
  mstate="$(jq -r '.instance.state // "off"' <<<"$mbody" 2>/dev/null || echo off)"
  if [[ "$mstate" != "off" ]]; then
    log "post-deploy check: maintenance window still '$mstate' after exit"
    log "degraded: maintenance window did not retire after exit"
    rc=1
  fi
  if ((rc == 0)); then
    log "post-deploy check: no blocked issues in the deploy window, maintenance retired"
  fi
  return "$rc"
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

# --- TRACING-HEALTH: one source of truth for the tracing callbacks -----------
# Langfuse v4 in the default `events_only` write mode rejects legacy trace and
# observation events on `/api/public/ingestion`. LiteLLM keeps sending them for
# as long as the legacy `langfuse` callback is enabled: the 02.10 incident was
# about 12k "Bad request" responses per hour, burned gateway CPU, and nobody
# noticed because nothing checked tracing. Tracing therefore runs over OTLP
# only, and the callback list has ONE source of truth: the function below.
# The generated file, the gateway config the bundle renders and the check all
# read that function, so a hand-written second list cannot drift away from it.
#
# Deploy settings (all optional; without them the check logs that it is
# skipped, so an installation without a tracing gateway still deploys):
#   MYRMIDON_TRACING_LANGFUSE_URL       base URL of the Langfuse server
#   MYRMIDON_TRACING_LANGFUSE_VERSION   version pinned in the bundle; the
#                                       fallback when the probe cannot answer
#   MYRMIDON_TRACING_GATEWAY_CONFIG     deployed LiteLLM config file
#   MYRMIDON_TRACING_CALLBACKS_COMMAND  command printing the effective callbacks
#   MYRMIDON_TRACING_CALLBACKS_FILE     generated file with the intended list
#   MYRMIDON_TRACING_TOKEN_FILE         token file for a guarded health route

# The only callback list the bundle installs. OpenTelemetry reaches Langfuse
# through the OTLP endpoint on v3 and v4; the legacy `langfuse` callback posts
# to `/api/public/ingestion`, which v4 rejects. One place, nothing else writes
# a second list.
tracing_intended_callbacks() {
  printf '%s\n' "langfuse_otel"
}

# Default location of the generated intended list (a file, so the check reads
# the same bytes the installer wrote).
tracing_callbacks_file_default() {
  printf '%s\n' "${STATE_DIR:-.}/tracing-callbacks.txt"
}

# Generates the intended callback list from the function above (one callback
# per line). The installer renders the gateway config and the start check from
# this file, so the bundle never carries two hand-written lists.
tracing_write_callbacks_file() {
  local file="$1" dir
  [[ -n "$file" ]] || die "tracing_write_callbacks_file needs a target file"
  dir="$(dirname "$file")"
  [[ -d "$dir" ]] || mkdir -p "$dir"
  tracing_intended_callbacks >"$file"
}

# Prints the callback names of a generated/readable list file, one per line,
# skipping blanks and comments.
tracing_read_callbacks_file() {
  local file="$1"
  [[ -r "$file" ]] || return 0
  grep -v '^[[:space:]]*$' "$file" | grep -v '^[[:space:]]*#' || true
}

# Normalizes a callback list (spaces, commas or newlines) to one name per line.
tracing_normalize_callbacks() {
  tr ',' '\n' | tr -s '[:space:]' '\n' | grep -v '^[[:space:]]*$' || true
}

# Major version of a version string ("4.2.0", "v4.2.0"), or empty.
tracing_major_of_version() {
  local version="${1#v}"
  if [[ "$version" =~ ^([0-9]+) ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
  else
    printf '%s\n' ""
  fi
  return 0
}

# Major version of the Langfuse server, or empty when it cannot be read. The
# first probe works without credentials: Langfuse serves `GET /api/public/health`
# (public route) with `{"status":...,"version":"4.x.y"}`, and the version is the
# documented v4 marker (on v4 the legacy ingestion endpoint rejects events with
# "events_only"). The documented fallback is the version the release bundle
# pins (MYRMIDON_TRACING_LANGFUSE_VERSION), used when the route is unreachable,
# guarded or answers without a version.
tracing_langfuse_major() {
  local url="$1" token_file="${2:-}" body version
  if [[ -z "$url" ]]; then
    printf '%s\n' ""
    return 0
  fi
  body="$(http_get "${url%/}/api/public/health" "$token_file" 2>/dev/null)" || body=""
  version="$(jq -r '.version // empty' <<<"$body" 2>/dev/null)" || version=""
  tracing_major_of_version "$version"
}

# Prints the callbacks of a LiteLLM gateway config file, one per line. Reads
# the `callbacks:` key of the `litellm_settings:` block and understands both
# the inline form (`callbacks: ["langfuse_otel"]`) and the block form
# (`callbacks:` plus `- langfuse_otel` lines). An unknown shape prints nothing
# rather than a guess.
tracing_callbacks_from_config() {
  local file="$1"
  [[ -n "$file" && -r "$file" ]] || return 0
  awk '
    function clean(s) {
      gsub(/"/, "", s)
      gsub("\047", "", s)
      sub(/^[ \t]+/, "", s)
      sub(/[ \t]+$/, "", s)
      sub(/,$/, "", s)
      return s
    }
    /^[ \t]*#/ { next }
    /^[ \t]*$/ { next }
    /^[^ \t]/ {
      in_litellm = ($0 ~ /^litellm_settings[ \t]*:/)
      block = 0
      next
    }
    !in_litellm { next }
    /^[ \t]+callbacks[ \t]*:/ {
      rest = $0
      sub(/^[ \t]*callbacks[ \t]*:[ \t]*/, "", rest)
      if (rest ~ /^\[/) {
        sub(/^\[/, "", rest)
        sub(/\][ \t]*$/, "", rest)
        n = split(rest, parts, ",")
        for (i = 1; i <= n; i++) { v = clean(parts[i]); if (v != "") print v }
        block = 0
      } else if (rest != "") {
        v = clean(rest); if (v != "") print v
        block = 0
      } else {
        block = 1
      }
      next
    }
    block && /^[ \t]*-[ \t]*/ {
      v = $0
      sub(/^[ \t]*-[ \t]*/, "", v)
      v = clean(v)
      if (v != "") print v
      next
    }
    block { block = 0 }
  ' "$file"
}

# Effective LiteLLM callbacks, one per line. Two sources are read and the union
# is taken, because the gateway config file and the gateway database disagree
# and the database only ADDS callbacks (a legacy one can stay in memory while
# the file looks clean):
#   * MYRMIDON_TRACING_CALLBACKS_COMMAND — the live gateway (or its database),
#     whatever the deployment trusts to read it;
#   * MYRMIDON_TRACING_GATEWAY_CONFIG — the deployed config file.
tracing_effective_callbacks() {
  local command="${1:-}" config="${2:-}" out=""
  if [[ -n "$command" ]]; then
    out="$(bash -c "$command" 2>/dev/null)" || out=""
    tracing_normalize_callbacks <<<"$out"
  fi
  if [[ -n "$config" ]]; then
    tracing_callbacks_from_config "$config"
  fi
}

# True when the stream on stdin contains the legacy `langfuse` callback (as
# opposed to `langfuse_otel` or any other name).
tracing_has_legacy_callback() {
  local token
  while IFS= read -r token; do
    token="$(printf '%s' "$token" | tr -d '[:space:]')"
    [[ "$token" == "langfuse" ]] && return 0
  done
  return 1
}

# The guard. Returns 0 when the bundle's OTLP-only list is what the gateway
# uses; returns 1 after a log line naming the reason when a legacy `langfuse`
# callback is installed against a v4 (or unproven) Langfuse server. There is
# deliberately no flag or setting that skips the refusal: callers die on 1.
# Arguments: langfuse_url, pinned_version, intended_file, gateway_config,
# callbacks_command, token_file.
tracing_check() {
  local url="${1:-}" pinned="${2:-}" intended_file="${3:-}" config="${4:-}" command="${5:-}" token_file="${6:-}"
  local major intended effective reason=""

  if [[ -z "$url$pinned$config$command" ]]; then
    log "tracing: no MYRMIDON_TRACING_* input configured; the callback check is skipped"
    return 0
  fi

  if [[ -z "$config" && -z "$command" ]]; then
    log "tracing: ERROR: tracing is configured but the effective callback set cannot be read; set MYRMIDON_TRACING_GATEWAY_CONFIG (the deployed gateway config) or MYRMIDON_TRACING_CALLBACKS_COMMAND (the live gateway). The check refuses rather than assuming the list is clean."
    return 1
  fi

  major="$(tracing_langfuse_major "$url" "$token_file")"
  if [[ -z "$major" && -n "$pinned" ]]; then
    major="$(tracing_major_of_version "$pinned")"
    [[ -n "$major" ]] && log "tracing: the Langfuse version pinned in the bundle is $pinned; the server probe gave no version"
  fi

  intended="$(tracing_read_callbacks_file "$intended_file")"
  [[ -n "$intended" ]] || intended="$(tracing_intended_callbacks)"
  effective="$(tracing_effective_callbacks "$command" "$config")"

  log "tracing: intended callbacks: $(tr '\n' ' ' <<<"$intended" | sed 's/ *$//')"
  log "tracing: effective callbacks: $(tr '\n' ' ' <<<"$effective" | sed 's/ *$//')"

  if tracing_has_legacy_callback <<<"$intended"; then
    if [[ "$major" == "4" || -z "$major" ]]; then
      reason="the callback list the bundle itself installs"
    else
      log "tracing: the bundle list carries the legacy 'langfuse' callback; Langfuse $major accepts it (the v4 refusal is what this check exists for)"
    fi
  fi

  if [[ -z "$reason" ]] && tracing_has_legacy_callback <<<"$effective"; then
    if [[ "$major" == "4" ]]; then
      reason="the effective gateway callbacks"
    elif [[ -z "$major" ]]; then
      reason="the effective gateway callbacks, and the Langfuse version cannot be proven (pin MYRMIDON_TRACING_LANGFUSE_VERSION or expose GET /api/public/health)"
    else
      log "tracing: the gateway carries the legacy 'langfuse' callback; Langfuse $major accepts it (the v4 refusal is what this check exists for)"
    fi
  fi

  if [[ -n "$reason" ]]; then
    log "tracing: REFUSED: the legacy 'langfuse' callback is in $reason while the Langfuse server is v4 (or its version cannot be proven). Langfuse v4 in events_only mode rejects /api/public/ingestion with 'Bad request' per event and burns gateway CPU; install the OTLP callback 'langfuse_otel' only. This check cannot be skipped."
    return 1
  fi

  log "tracing: callbacks ok (OTLP only)"
  return 0
}
