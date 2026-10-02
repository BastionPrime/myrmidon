#!/usr/bin/env bash
# scripts/myrmidon/deploy/rollout-component.sh
#
# RELEASE-GATE (the 01.10 incident): deploy.sh rolls the matching dockergate
# (and fleetd) images together with the board image, in the same run. This is
# the shared half for one component: pull by digest, remember the previous
# reference, write the image line into the component override file, recreate
# the service, and check its health endpoint. deploy.sh calls it once per
# component after the board itself is healthy.
#
#   rollout-component.sh --config deploy.env --component dockergate \
#                        --digest sha256:<64 hex> [--dry-run]
#
# The component registry repositories are fixed (they are CI-built exactly like
# the board image; see scripts/myrmidon/dockergate/check-release-support.sh):
#   dockergate -> ghcr.io/itkadr-git/myrmidon-dockergate
#   fleetd     -> ghcr.io/itkadr-git/myrmidon-fleetd
#
# The image is verified the same way the board image is (registry presence,
# revision and source labels, commit on origin/main or a myr-v* tag) — there
# is no flag that skips it, for the same reason as the board check.
#
# Health check: per-component <COMPONENT>_HEALTH_URL (a curl -fsS target) is
# REQUIRED; the deploy of the release must prove every component answers, not
# just the board. verify-health.sh stays board-specific (version/commit of
# /api/health); components get a plain reachability probe here.
set -euo pipefail
# shellcheck source=lib.sh source-path=SCRIPTDIR
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

config="" component="" digest=""
DRY_RUN=0
while (($#)); do
  case "$1" in
    --config) config="$2"; shift 2 ;;
    --component) component="$2"; shift 2 ;;
    --digest) digest="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ -n "$component" ]] || die "--component is required (dockergate or fleetd)"
valid_digest "$digest" || die "component digest must be sha256:<64 hex>, got '$digest'"
load_config "$config"
require_cmd docker curl

declare -A MYR_COMPONENT_REPOSITORIES=(
  [dockergate]="ghcr.io/itkadr-git/myrmidon-dockergate"
  [fleetd]="ghcr.io/itkadr-git/myrmidon-fleetd"
)
repo="${MYR_COMPONENT_REPOSITORIES[$component]:-}"
[[ -n "$repo" ]] || die "unknown component: $component (known: dockergate, fleetd)"
ref="$repo@$digest"

# Service and override naming follow the component name:
#   DOCKERGATE_COMPOSE_SERVICE (default: dockergate) and
#   DOCKERGATE_OVERRIDE_FILE (default: docker-compose.myrmidon-dockergate.yml),
#   likewise FLEETD_*.
COMPONENT_SERVICE_OVERRIDE_VAR="$(printf 'MYR_%s_COMPOSE_SERVICE' "$component" | tr '[:lower:]' '[:upper:]')"
COMPONENT_OVERRIDE_VAR="$(printf 'MYR_%s_OVERRIDE_FILE' "$component" | tr '[:lower:]' '[:upper:]')"
COMPONENT_HEALTH_URL_VAR="$(printf 'MYR_%s_HEALTH_URL' "$component" | tr '[:lower:]' '[:upper:]')"
default_service="$component"
default_override="docker-compose.myrmidon-$component.yml"
COMPONENT_SERVICE="${!COMPONENT_SERVICE_OVERRIDE_VAR:-$default_service}"
COMPONENT_OVERRIDE_NAME="${!COMPONENT_OVERRIDE_VAR:-$default_override}"
COMPONENT_HEALTH_URL="${!COMPONENT_HEALTH_URL_VAR:-}"
COMPONENT_OVERRIDE_PATH="$COMPOSE_DIR/$COMPONENT_OVERRIDE_NAME"
COMPONENT_PREVIOUS_FILE="$STATE_DIR/previous-$component-image"

# Same CI-image gate as the board: registry, labels, commit on main or a tag.
log "checking that $ref was built by CI"
if ! check_ci_image_for_repo "$repo" "$ref"; then
  log "Only component images built by the CI workflows from main or a myr-v* tag are rolled out."
  die "component image refused, nothing was changed: $CI_CHECK_REASON"
fi

current_ref=""
[[ -f "$COMPONENT_OVERRIDE_PATH" ]] && current_ref="$(sed -nE 's/^[[:space:]]*image:[[:space:]]*([^[:space:]#]+).*/\1/p' "$COMPONENT_OVERRIDE_PATH" | head -n1)"

if [[ "$DRY_RUN" == "1" ]]; then
  log "dry run: nothing will be changed. Component plan:"
  plan "1. component image check passed (read-only): $ref built by CI from commit ${CI_IMAGE_REVISION:0:12}"
  plan "2. docker pull $ref"
  plan "3. remember previous component image: ${current_ref:-<none>} -> $COMPONENT_PREVIOUS_FILE"
  plan "4. set image in $COMPONENT_OVERRIDE_PATH; docker compose up -d --no-deps $COMPONENT_SERVICE"
  plan "5. health: ${COMPONENT_HEALTH_URL:-<unset: deploy refuses>}"
  exit 0
fi

log "1/5 pull $ref"
docker pull --quiet "$ref" >/dev/null || die "cannot pull $ref"

log "2/5 remember previous component image"
mkdir -p "$STATE_DIR"
if [[ -n "$current_ref" && "$current_ref" != "$ref" ]]; then
  printf '%s\n' "$current_ref" >"$COMPONENT_PREVIOUS_FILE"
fi

log "3/5 switch image in $COMPONENT_OVERRIDE_PATH"
{
  echo "# Managed by scripts/myrmidon/deploy. Only the image line changes."
  echo "services:"
  echo "  $COMPONENT_SERVICE:"
  echo "    image: $ref"
} >"$COMPONENT_OVERRIDE_PATH"

log "4/5 recreate $COMPONENT_SERVICE"
compose up -d --no-deps "$COMPONENT_SERVICE" || die "compose up failed for $COMPONENT_SERVICE"
record_history "deploy-$component" "$ref"

log "5/5 health"
[[ -n "$COMPONENT_HEALTH_URL" ]] || die "$component has no MYR_${component^^}_HEALTH_URL configured: the release deploy must prove the component answers; refusing to report success without it"
# The value is the URL plus any curl arguments it needs (a unix socket, an
# auth header): word-splitting is intended here.
health_ok=0
for _ in $(seq 1 "$((HEALTH_TIMEOUT_SEC / POLL_INTERVAL_SEC + 1))"); do
  # shellcheck disable=SC2086
  if curl -fsS --max-time 10 $COMPONENT_HEALTH_URL >/dev/null 2>&1; then
    health_ok=1
    break
  fi
  sleep "$POLL_INTERVAL_SEC"
done
if [[ "$health_ok" != "1" ]]; then
  log "DEGRADED: $component did not answer at $COMPONENT_HEALTH_URL within ${HEALTH_TIMEOUT_SEC}s"
  log "Roll back the board with: $MYR_SCRIPT_DIR/rollback.sh --config $config"
  log "Roll back this component with: $MYR_SCRIPT_DIR/rollback-component.sh --config $config --component $component"
  exit 1
fi
log "component $component rolled out ($ref, previous: ${current_ref:-<none>})"
