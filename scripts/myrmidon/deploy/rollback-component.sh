#!/usr/bin/env bash
# scripts/myrmidon/deploy/rollback-component.sh
#
# RELEASE-GATE: the component half of rollback.sh. Restores the image deploy.sh
# remembered for one component (dockergate or fleetd) before its last rollout,
# or an explicit --to-image reference, recreates the service and checks health.
# It does not touch the board image; run rollback.sh for that.
#
#   rollback-component.sh --config deploy.env --component dockergate
#                          [--to-image <ref>] [--dry-run]
#
# Like rollback.sh this is the emergency path: it warns when the target is not
# a verified CI image but does not block.
set -euo pipefail
# shellcheck source=lib.sh source-path=SCRIPTDIR
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

config="" component="" to_image=""
DRY_RUN=0
while (($#)); do
  case "$1" in
    --config) config="$2"; shift 2 ;;
    --component) component="$2"; shift 2 ;;
    --to-image) to_image="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ -n "$component" ]] || die "--component is required (dockergate or fleetd)"
load_config "$config"
require_cmd docker curl

declare -A MYR_COMPONENT_REPOSITORIES=(
  [dockergate]="ghcr.io/itkadr-git/myrmidon-dockergate"
  [fleetd]="ghcr.io/itkadr-git/myrmidon-fleetd"
)
repo="${MYR_COMPONENT_REPOSITORIES[$component]:-}"
[[ -n "$repo" ]] || die "unknown component: $component (known: dockergate, fleetd)"

COMPONENT_SERVICE_VAR="$(printf 'MYR_%s_COMPOSE_SERVICE' "$component" | tr '[:lower:]' '[:upper:]')"
COMPONENT_OVERRIDE_VAR="$(printf 'MYR_%s_OVERRIDE_FILE' "$component" | tr '[:lower:]' '[:upper:]')"
COMPONENT_HEALTH_URL_VAR="$(printf 'MYR_%s_HEALTH_URL' "$component" | tr '[:lower:]' '[:upper:]')"
COMPONENT_HOST_VAR="$(printf 'MYR_%s_HOST' "$component" | tr '[:lower:]' '[:upper:]')"
COMPONENT_SERVICE="${!COMPONENT_SERVICE_VAR:-$component}"
COMPONENT_OVERRIDE_NAME="${!COMPONENT_OVERRIDE_VAR:-docker-compose.myrmidon-$component.yml}"
COMPONENT_HEALTH_URL="${!COMPONENT_HEALTH_URL_VAR:-}"
COMPONENT_HOST="${!COMPONENT_HOST_VAR:-local}"
COMPONENT_OVERRIDE_PATH="$COMPOSE_DIR/$COMPONENT_OVERRIDE_NAME"
COMPONENT_PREVIOUS_FILE="$STATE_DIR/previous-$component-image"

# HOST-TARGETING (the 02.10 two-host follow-up): the rollback must target the
# SAME host the rollout targeted. A rollback that ignored MYR_<COMPONENT>_HOST
# would pull the image and recreate the service on the deploy host — the exact
# 1.4.0 fleetd incident (paperclip-fleetd-1 created on the board host, no
# config there, container exits, removed by hand). The helpers are shared with
# rollout-component.sh through lib.sh (component_host_*).
if [[ "$COMPONENT_HOST" == "skip" ]]; then
  log "SKIP: $component is not managed by this deploy (MYR_${component^^}_HOST=skip); roll it back by its own procedure there"
  exit 0
fi
component_host_parse "$component" "$COMPONENT_HOST"

if [[ -n "$to_image" ]]; then
  ref="$to_image"
elif [[ -f "$COMPONENT_PREVIOUS_FILE" ]]; then
  ref="$(tr -d '[:space:]' <"$COMPONENT_PREVIOUS_FILE")"
else
  die "no previous $component image recorded in $STATE_DIR; pass --to-image <ref>"
fi
[[ "$ref" =~ ^[A-Za-z0-9./_:@-]+$ ]] || die "rollback target is not an image reference: $ref"

current_ref=""
current_ref="$(component_host_cat_override | sed -nE 's/^[[:space:]]*image:[[:space:]]*([^[:space:]#]+).*/\1/p' | head -n1)"

if ! check_ci_image_for_repo "$repo" "$ref"; then
  log "WARNING: $component rollback target is not a verified CI image: $CI_CHECK_REASON"
  log "WARNING: continuing anyway, rollback is the emergency path"
fi

if [[ "$DRY_RUN" == "1" ]]; then
  log "dry run: nothing will be changed. Plan (${COMPONENT_HOST%%:*} target${COMPONENT_REMOTE:+, ssh $COMPONENT_REMOTE}):"
  plan "1. docker pull $ref"
  plan "2. set image in $COMPONENT_OVERRIDE_PATH (from ${current_ref:-<none>}); docker compose up -d --no-deps $COMPONENT_SERVICE"
  plan "3. health: ${COMPONENT_HEALTH_URL:-<unset>}"
  exit 0
fi

log "1/3 pull $ref"
component_host_docker pull --quiet "$ref" >/dev/null || die "cannot pull $ref"

log "2/3 switch image to $ref"
component_host_write_override "$ref"
component_host_compose up -d --no-deps "$COMPONENT_SERVICE" || die "compose up failed for $COMPONENT_SERVICE"
record_history "rollback-$component" "$ref"
if [[ -n "$current_ref" && "$current_ref" != "$ref" ]]; then
  printf '%s\n' "$current_ref" >"$COMPONENT_PREVIOUS_FILE"
fi

log "3/3 health"
if [[ -n "$COMPONENT_HEALTH_URL" ]]; then
  # URL plus optional curl arguments; word-splitting is intended.
  health_ok=0
  for _ in $(seq 1 "$((HEALTH_TIMEOUT_SEC / POLL_INTERVAL_SEC + 1))"); do
    # shellcheck disable=SC2086
    if curl -fsS --max-time 10 $COMPONENT_HEALTH_URL >/dev/null 2>&1; then
      health_ok=1
      break
    fi
    sleep "$POLL_INTERVAL_SEC"
  done
  [[ "$health_ok" == "1" ]] || die "$component did not answer at $COMPONENT_HEALTH_URL after rollback"
else
  log "WARNING: no MYR_${component^^}_HEALTH_URL configured; skipping the health probe"
fi
log "rolled $component back to $ref"
