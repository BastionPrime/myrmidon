#!/usr/bin/env bash
# Deploys a Myrmidon image by digest.
#
#   deploy.sh --config deploy.env --digest sha256:<64 hex> [--dry-run]
#             [--expect-version V] [--expect-commit SHA] [--force]
#
# Steps: pull the image by digest; remember the current digest as "previous";
# dump the database (DUMP_COMMAND, refuses an empty dump); enter maintenance;
# wait until no runs are in progress; switch the image line in the compose
# override file and recreate only the server service; verify /api/health
# (status, version, commit); leave maintenance.
#
# On a failed health check the script stops with maintenance still on and
# prints the rollback command. --dry-run changes nothing and prints the plan.
set -euo pipefail
# shellcheck source=lib.sh source-path=SCRIPTDIR
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

config="" digest="" expect_version="" expect_commit="" force=0
DRY_RUN=0
while (($#)); do
  case "$1" in
    --config) config="$2"; shift 2 ;;
    --digest) digest="$2"; shift 2 ;;
    --expect-version) expect_version="$2"; shift 2 ;;
    --expect-commit) expect_commit="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --force) force=1; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
valid_digest "$digest" || die "--digest must look like sha256:<64 hex chars>"
load_config "$config"
require_cmd docker curl jq

ref="$MYRMIDON_IMAGE@$digest"
previous="$(current_digest)"
previous_image="$(current_image)"

if [[ "$previous" == "$digest" && "$force" != "1" ]]; then
  log "already running $ref; nothing to do (use --force to redeploy)"
  exit 0
fi

if [[ "$DRY_RUN" == "1" ]]; then
  log "dry run: nothing will be changed. Plan:"
  plan "1. docker pull $ref"
  plan "2. remember previous image: ${previous_image:-<none>} -> $PREVIOUS_IMAGE_FILE"
  plan "3. dump database with DUMP_COMMAND into $DUMP_DIR (refuse if smaller than $DUMP_MIN_BYTES bytes)"
  plan "4. enter maintenance (MAINTENANCE_MODE=$MAINTENANCE_MODE)"
  plan "5. wait for zero running runs (timeout ${RUNS_WAIT_TIMEOUT_SEC}s)"
  plan "6. set image in $OVERRIDE_PATH to $ref; docker compose up -d --no-deps $COMPOSE_SERVICE"
  plan "7. verify $HEALTH_URL: status ok, version ${expect_version:-<from image label>}, commit ${expect_commit:-<from image label>}"
  plan "8. leave maintenance"
  exit 0
fi

log "1/8 pull $ref"
docker pull --quiet "$ref" >/dev/null || die "cannot pull $ref"
[[ -n "$expect_version" ]] || expect_version="$(image_label "$ref" org.opencontainers.image.version)"
[[ -n "$expect_commit" ]] || expect_commit="$(image_label "$ref" org.opencontainers.image.revision)"
[[ -n "$expect_version" || -n "$expect_commit" ]] || die "image has no version/revision labels; pass --expect-version and --expect-commit"

log "2/8 previous image: ${previous_image:-<none>}"
mkdir -p "$STATE_DIR"
if [[ -n "$previous" ]]; then
  printf '%s\n' "$previous" >"$PREVIOUS_FILE"
fi
# myrmidon(R4): the full reference, so rollback also works from a vendor image.
if [[ -n "$previous_image" ]]; then
  printf '%s\n' "$previous_image" >"$PREVIOUS_IMAGE_FILE"
fi

log "3/8 database dump"
take_dump "${digest#sha256:}"
LAST_DUMP_FILE="${LAST_DUMP_FILE:-}"

log "4/8 enter maintenance"
maintenance_enter "deploy $MYRMIDON_IMAGE@${digest:0:19}"

log "5/8 wait for running runs"
wait_for_idle_runs

log "6/8 switch image and recreate $COMPOSE_SERVICE"
write_override "$digest"
compose up -d --no-deps "$COMPOSE_SERVICE"
record_history deploy "$digest"

log "7/8 verify health"
if ! "$MYR_SCRIPT_DIR/verify-health.sh" --url "$HEALTH_URL" --timeout "$HEALTH_TIMEOUT_SEC" \
  --expect-version "$expect_version" --expect-commit "$expect_commit" \
  ${HEALTH_TOKEN_FILE:+--token-file "$HEALTH_TOKEN_FILE"} --interval "$POLL_INTERVAL_SEC"; then
  log "DEPLOY FAILED: $ref is running but health does not match. Maintenance stays on."
  log "Roll back with: $MYR_SCRIPT_DIR/rollback.sh --config $config"
  log "Pre-deploy dump: $LAST_DUMP_FILE"
  exit 1
fi

log "8/8 leave maintenance"
maintenance_exit
log "deployed $ref (previous: ${previous:-<none>}, dump: $LAST_DUMP_FILE)"
