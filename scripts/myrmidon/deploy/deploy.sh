#!/usr/bin/env bash
# Deploys a Myrmidon image by digest. Only images built by CI are deployed.
#
#   deploy.sh --config deploy.env --digest sha256:<64 hex> [--dry-run]
#             [--expect-version V] [--expect-commit SHA] [--force]
#
# --digest takes sha256:<64 hex> or ghcr.io/itkadr-git/myrmidon@sha256:<64 hex>.
#
# Before anything else (before the pull, the dump and maintenance) the script
# refuses unless: the reference is exactly ghcr.io/itkadr-git/myrmidon@sha256:<64 hex>
# (no tag, no other repository); the image is in the registry; its
# org.opencontainers.image.revision label names a commit that is on origin/main
# or carries a myr-v* tag (git fetch in the clone that holds these scripts).
# There is no flag to skip this check, --force does not skip it either.
#
# Steps: pull the image by digest; remember the current digest as "previous";
# dump the database (DUMP_COMMAND, refuses an empty dump); enter maintenance;
# wait until no runs are in progress; switch the image line in the compose
# override file and recreate only the server service; verify /api/health
# (status, version, commit); leave maintenance.
#
# On a failed health check the script stops with maintenance still on and
# prints the rollback command. --dry-run changes nothing and prints the plan
# (the image check is read-only, so it runs in a dry run too).
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
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
parse_digest_arg "$digest"
load_config "$config"
require_cmd docker curl jq

# Only CI images reach production: this runs before any other action.
[[ "$MYRMIDON_IMAGE" == "$MYR_CI_IMAGE" ]] \
  || die "MYRMIDON_IMAGE is '$MYRMIDON_IMAGE': only $MYR_CI_IMAGE is deployed (images built by CI); nothing was changed"
ref="$MYRMIDON_IMAGE@$digest"
log "checking that $ref was built by CI"
if ! check_ci_image "$ref"; then
  log "Only images built by the CI workflow 'Myrmidon image' from main or a myr-v* tag are deployed. This check cannot be skipped."
  die "image refused, nothing was changed: $CI_CHECK_REASON"
fi
log "image ok: built by CI from commit ${CI_IMAGE_REVISION:0:12}, version ${CI_IMAGE_VERSION:-<none>}"

previous="$(current_digest)"
previous_image="$(current_image)"

if [[ "$previous" == "$digest" && "$force" != "1" ]]; then
  log "already running $ref; nothing to do (use --force to redeploy)"
  exit 0
fi

if [[ "$DRY_RUN" == "1" ]]; then
  log "dry run: nothing will be changed. Plan:"
  plan "0. image check passed (read-only): $ref is in the registry, commit ${CI_IMAGE_REVISION:0:12} is on origin/main or a myr-v* tag"
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
# myrmidon(R4): a forced redeploy of the same image must not overwrite the real previous one.
if [[ -n "$previous" && "$previous" != "$digest" ]]; then
  printf '%s\n' "$previous" >"$PREVIOUS_FILE"
fi
# myrmidon(R4): the full reference, so rollback also works from a vendor image.
if [[ -n "$previous_image" && "$previous_image" != "$ref" ]]; then
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
if [[ "$force" == "1" ]]; then
  compose up -d --no-deps --force-recreate "$COMPOSE_SERVICE"
else
  compose up -d --no-deps "$COMPOSE_SERVICE"
fi
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
