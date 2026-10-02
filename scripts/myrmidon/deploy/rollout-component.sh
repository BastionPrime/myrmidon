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
#
# HOST-TARGETING (the 02.10 two-host follow-up): a component does not have to
# live on the deploy host. fleetd of the 1.4.0 production install runs on a
# second host (vm-exec), while deploy.sh runs on the board host (vm-core): the
# first 1.4.0 rollout created paperclip-fleetd-1 on the board host, it exited
# at once (no /etc/myrmidon-fleetd/config.json there) and the operator removed
# it by hand. A component that does not live on this host must not be "rolled
# out" here. Two supported arrangements, fail-closed by default:
#
#   MYR_<COMPONENT>_HOST=local (default)   the service runs in this host's
#     compose project (COMPOSE_DIR). A rollout that finds no trace of the
#     service locally (no override file AND no service in `docker compose
#     config --services`) fails: silently skipping a required component is
#     exactly the 01.10 split again.
#   MYR_<COMPONENT>_HOST=remote:<user>@<host>   the service runs on another
#     host. The rollout then runs docker over ssh (ssh must be set up with a
#     key, no password prompt), writes the override file there under the same
#     relative name (COMPOSE_DIR must exist on the remote host too), recreates
#     the service there and probes MYR_<COMPONENT>_HEALTH_URL from THIS host
#     (the URL the deploy host can reach, not localhost of the remote host).
#   MYR_<COMPONENT>_HOST=skip   the component is not managed by this deploy at
#     all (rolled out by its own procedure elsewhere). The rollout logs a loud
#     SKIP line and exits 0 — the release still ships together, the operator
#     owns the other half explicitly.
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
    -h|--help) sed -n '2,46p' "$0"; exit 0 ;;
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
#   MYR_DOCKERGATE_COMPOSE_SERVICE (default: dockergate) and
#   MYR_DOCKERGATE_OVERRIDE_FILE (default: docker-compose.myrmidon-dockergate.yml),
#   likewise FLEETD_*.
COMPONENT_SERVICE_OVERRIDE_VAR="$(printf 'MYR_%s_COMPOSE_SERVICE' "$component" | tr '[:lower:]' '[:upper:]')"
COMPONENT_OVERRIDE_VAR="$(printf 'MYR_%s_OVERRIDE_FILE' "$component" | tr '[:lower:]' '[:upper:]')"
COMPONENT_HEALTH_URL_VAR="$(printf 'MYR_%s_HEALTH_URL' "$component" | tr '[:lower:]' '[:upper:]')"
COMPONENT_HOST_VAR="$(printf 'MYR_%s_HOST' "$component" | tr '[:lower:]' '[:upper:]')"
default_service="$component"
default_override="docker-compose.myrmidon-$component.yml"
COMPONENT_SERVICE="${!COMPONENT_SERVICE_OVERRIDE_VAR:-$default_service}"
COMPONENT_OVERRIDE_NAME="${!COMPONENT_OVERRIDE_VAR:-$default_override}"
COMPONENT_HEALTH_URL="${!COMPONENT_HEALTH_URL_VAR:-}"
COMPONENT_HOST="${!COMPONENT_HOST_VAR:-local}"
COMPONENT_OVERRIDE_PATH="$COMPOSE_DIR/$COMPONENT_OVERRIDE_NAME"
COMPONENT_PREVIOUS_FILE="$STATE_DIR/previous-$component-image"

# HOST-TARGETING: where this component actually runs. skip is decided AFTER
# the CI-image check below: even a component this deploy does not manage must
# name a real, CI-built image of this release — the release ships together.
# The parser and the docker/compose/cat/write helpers live in lib.sh
# (component_host_*) so the rollback (rollback-component.sh) targets the SAME
# host as the rollout — a rollback ignoring MYR_<COMPONENT>_HOST would recreate
# the component on the deploy host, the exact 1.4.0 fleetd incident.
if [[ "$COMPONENT_HOST" == "skip" ]]; then
  log "SKIP: $component is not managed by this deploy (MYR_${component^^}_HOST=skip); its image rolls out by its own procedure"
  log "      make sure the $component image of THIS release ($ref) is rolled out there too — the release must ship together"
fi
component_host_parse "$component" "$COMPONENT_HOST"
component_docker() { component_host_docker "$@"; }
component_compose() { component_host_compose "$@"; }
component_cat_override() { component_host_cat_override; }
component_service_exists() { component_host_service_exists; }
component_write_override() { component_host_write_override "$@"; }

# Same CI-image gate as the board: registry, labels, commit on main or a tag.
log "checking that $ref was built by CI"
if ! check_ci_image_for_repo "$repo" "$ref"; then
  log "Only component images built by the CI workflows from main or a myr-v* tag are rolled out."
  die "component image refused, nothing was changed: $CI_CHECK_REASON"
fi

# HOST-TARGETING: skip exits only after the CI check — see the case above.
if [[ "$COMPONENT_SKIP" == "1" ]]; then
  log "SKIP: $component rollout ends here; nothing was pulled, switched or recreated on this host"
  exit 0
fi

# HOST-TARGETING (fail-closed local pre-check): before anything is pulled or
# written, prove the service is part of the target host's compose project. A
# component with no trace there (the 1.4.0 fleetd-on-the-board-host incident)
# must fail HERE, not at step 4 with an image pulled and an override written on
# a host the service never ran on.
if ! component_service_exists; then
  local_desc="this host"
  [[ -n "$COMPONENT_REMOTE" ]] && local_desc="$COMPONENT_REMOTE (remote)"
  die "$component is not a service of the compose project on $local_desc ($COMPONENT_SERVICE missing from \$COMPOSE_FILES; a rollout would create the service from nothing, as in the 1.4.0 fleetd incident): fix MYR_${component^^}_COMPOSE_SERVICE/COMPOSE_FILES or set MYR_${component^^}_HOST to remote:/skip"
fi

current_ref=""
[[ -n "$(component_cat_override)" ]] && current_ref="$(component_cat_override | sed -nE 's/^[[:space:]]*image:[[:space:]]*([^[:space:]#]+).*/\1/p' | head -n1)"

if [[ "$DRY_RUN" == "1" ]]; then
  log "dry run: nothing will be changed. Component plan (${COMPONENT_HOST%%:*} target):"
  plan "1. component image check passed (read-only): $ref built by CI from commit ${CI_IMAGE_REVISION:0:12}"
  plan "2. docker pull $ref"
  plan "3. remember previous component image: ${current_ref:-<none>} -> $COMPONENT_PREVIOUS_FILE"
  plan "4. set image in $COMPONENT_OVERRIDE_PATH; docker compose up -d --no-deps $COMPONENT_SERVICE${COMPONENT_REMOTE:+ (through ssh $COMPONENT_REMOTE)}"
  plan "5. health: ${COMPONENT_HEALTH_URL:-<unset: deploy refuses>}"
  exit 0
fi

log "1/5 pull $ref"
component_docker pull --quiet "$ref" >/dev/null || die "cannot pull $ref"

log "2/5 remember previous component image"
mkdir -p "$STATE_DIR"
if [[ -n "$current_ref" && "$current_ref" != "$ref" ]]; then
  printf '%s\n' "$current_ref" >"$COMPONENT_PREVIOUS_FILE"
fi

log "3/5 switch image in $COMPONENT_OVERRIDE_PATH"
component_write_override "$ref"

log "4/5 recreate $COMPONENT_SERVICE"
component_compose up -d --no-deps "$COMPONENT_SERVICE" || die "compose up failed for $COMPONENT_SERVICE"
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
