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
# It also refuses when the systemd boot unit (paperclip.service) does not
# start the server from exactly the compose files this deploy manages
# (one boot path: see lib.sh, verify_boot_unit).
#
# Steps: pull the image by digest; remember the current digest as "previous";
# dump the database (DUMP_COMMAND, refuses an empty dump); enter maintenance;
# wait until no runs are in progress. The window drains for the short grace
# (MAINTENANCE_DRAIN_GRACE_SEC, 300 s by default) and then interrupts whatever
# is still running; the interrupted runs are retried when the window closes
# (MAINTENANCE_ON_TIMEOUT=wait keeps the old "wait for the long timeout"
# behaviour). A drain timeout lifts maintenance again and aborts before the
# image changes; then switch the image line in the compose override file and
# recreate only the server service; verify /api/health (status, version,
# commit); leave maintenance (myrmidon EXIT-ASYNC: the exit call returns as soon
# as the window is `leaving`, then the script waits for the window to retire,
# not for the HTTP call); run the post-deploy fleet check (no issue became
# blocked in the deploy window, the window retired).
#
# RELEASE-GATE (the 01.10 incident): the release's component images roll out
# together with the board, in this same run. After the board image check
# resolves and verifies the matching dockergate and fleetd digests (same
# release: the tag the board image was built from, or the short sha of its
# commit; see ../dockergate/check-release-support.sh). A release whose
# component digests are missing is refused BEFORE anything changes. After the
# board is healthy each component is pulled, switched and health-checked
# (rollout-component.sh); a failing component health is DEGRADED, not silent.
# Last, a post-deploy smoke (bot-apply-smoke.sh) waits for at least one bot
# container to re-apply; failing that within its window the deploy reports
# DEGRADED and prints the rollback commands.
#
# On a failed health check the script stops with maintenance still on and
# prints the rollback command. --dry-run changes nothing and prints the plan
# (the image checks are read-only, so they run in a dry run too).
#
# TRACING-HEALTH: right after the health check the deploy verifies the LLM
# tracing callbacks of the gateway (tracing-check.sh): the legacy `langfuse`
# callback against a v4 Langfuse server is refused, and the deploy stops like a
# failed health check — maintenance stays on and the rollback command is
# printed. There is no flag that skips the refusal. Without a MYRMIDON_TRACING_*
# setting the check logs that it is skipped, so an installation without a
# tracing gateway still deploys.
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

# RELEASE-GATE: which components roll with the board, and the smoke settings.
MYR_RELEASE_COMPONENTS="${MYRMIDON_RELEASE_COMPONENTS:-dockergate,fleetd}"
MYR_SMOKE_ENABLED="${MYRMIDON_DEPLOY_SMOKE:-1}"
MYR_SMOKE_TIMEOUT_SEC="${MYRMIDON_DEPLOY_SMOKE_TIMEOUT_SEC:-300}"
MYR_SMOKE_INTERVAL_SEC="${MYRMIDON_DEPLOY_SMOKE_INTERVAL_SEC:-10}"
MYR_SMOKE_COMPANY="${MYRMIDON_DEPLOY_SMOKE_COMPANY:-}"
MYR_SMOKE_AGENT="${MYRMIDON_DEPLOY_SMOKE_AGENT:-}"

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

# RELEASE-GATE: resolve the component digests of the SAME release before
# anything changes. Order: the myr-vX.Y.Z tag when the board commit carries
# one (version label of a tag build), else the sha-<short> tag of the commit.
# A release whose component digests are missing is refused here: rolling the
# board alone is exactly what the 01.10 incident did to the fleet.
component_digests=""
component_resolution=""
if [[ -n "$MYR_RELEASE_COMPONENTS" && "$MYR_RELEASE_COMPONENTS" != "none" ]]; then
  version_tag=""
  if [[ "${CI_IMAGE_VERSION:-}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    version_tag="$CI_IMAGE_VERSION"
  fi
  if [[ -n "$version_tag" ]]; then
    component_resolution="tag $version_tag"
    component_digests="$("$MYR_SCRIPT_DIR/../dockergate/check-release-support.sh" --from-tag "$version_tag" --components "$MYR_RELEASE_COMPONENTS" 2>/dev/null)" || component_digests=""
  fi
  if [[ -z "$component_digests" ]]; then
    component_resolution="sha ${CI_IMAGE_REVISION:0:7}"
    component_digests="$("$MYR_SCRIPT_DIR/../dockergate/check-release-support.sh" --from-sha "${CI_IMAGE_REVISION:0:7}" --components "$MYR_RELEASE_COMPONENTS" 2>/dev/null)" || component_digests=""
  fi
  if [[ -z "$component_digests" ]]; then
    log "Release gate: the component images ($MYR_RELEASE_COMPONENTS) of this release ($component_resolution) are not in the registry."
    log "A release must ship its components together with the board; this deploy is refused and nothing was changed."
    log "This cannot be skipped: build and publish the component images from the same commit (the component workflows run on every push to main and every myr-v* tag)."
    die "release incomplete: component digests missing ($MYR_RELEASE_COMPONENTS, resolved by $component_resolution)"
  fi
  log "release components ($component_resolution):"
  while IFS= read -r line; do
    [[ -n "$line" ]] && log "  $line"
  done <<<"$component_digests"
fi

# myrmidon(BOOT-PATH): one boot path. The boot unit must read exactly the
# compose files this deploy manages, or a reboot restarts the board from
# a different (e.g. vendor) compose file. Refused before anything changes;
# the check is read-only and runs in a dry run too.
if ! verify_boot_unit; then
  log "Only a boot unit pointing at the compose files of this deploy (COMPOSE_DIR, COMPOSE_FILES, the override) is accepted; this cannot be skipped."
  die "boot unit not verified, nothing was changed: $BOOT_UNIT_REASON"
fi
log "boot unit ok: $(boot_unit_path) starts $COMPOSE_SERVICE from COMPOSE_DIR ($COMPOSE_FILES + $COMPOSE_OVERRIDE_FILE)"

previous="$(current_digest)"
previous_image="$(current_image)"

if [[ "$previous" == "$digest" && "$force" != "1" ]]; then
  log "already running $ref; nothing to do (use --force to redeploy)"
  exit 0
fi

if [[ "$DRY_RUN" == "1" ]]; then
  log "dry run: nothing will be changed. Plan:"
  plan "0. image check passed (read-only): $ref is in the registry, commit ${CI_IMAGE_REVISION:0:12} is on origin/main or a myr-v* tag"
  plan "0.5 boot unit check passed (read-only): $(boot_unit_path) reads the compose files of this deploy"
  plan "1. docker pull $ref"
  plan "2. remember previous image: ${previous_image:-<none>} -> $PREVIOUS_IMAGE_FILE"
  plan "3. dump database with DUMP_COMMAND into $DUMP_DIR (refuse if smaller than $DUMP_MIN_BYTES bytes)"
  plan "4. enter maintenance (MAINTENANCE_MODE=$MAINTENANCE_MODE, onTimeout=$MAINTENANCE_ON_TIMEOUT, grace ${MAINTENANCE_DRAIN_GRACE_SEC}s)"
  plan "5. wait for zero running runs (timeout ${RUNS_WAIT_TIMEOUT_SEC}s); onTimeout=$MAINTENANCE_ON_TIMEOUT drains for the grace and then interrupts what is still running (retried after the window closes); on a drain timeout maintenance is lifted and the deploy aborts before the image changes"
  plan "6. set image in $OVERRIDE_PATH to $ref; docker compose up -d --no-deps $COMPOSE_SERVICE"
  plan "7. verify $HEALTH_URL: status ok, version ${expect_version:-<from image label>}, commit ${expect_commit:-<from image label>}"
  plan "7b. verify the LLM tracing callbacks (OTLP only; refuses the legacy 'langfuse' callback against a v4 Langfuse server; logs a skip when no MYRMIDON_TRACING_* input is configured)"
  plan "8. leave maintenance (the exit POST returns when the window is marked leaving; the deploy waits for the state off, MAINTENANCE_EXIT_WAIT_SEC=${MAINTENANCE_EXIT_WAIT_SEC}s); then the post-deploy fleet check (no issue blocked in the deploy window, the window retired; needs BOARD_API_URL/BOARD_COMPANY_ID, otherwise skipped)"
  if [[ -n "$component_digests" ]]; then
    plan "9. roll out release components together with the board: $MYR_RELEASE_COMPONENTS (${component_resolution}; one rollout-component.sh per component, each with its own pull, switch and health check)"
    plan "10. post-deploy smoke: wait for a bot container to re-apply (bot-apply-smoke.sh, timeout ${MYR_SMOKE_TIMEOUT_SEC}s); on failure the deploy reports DEGRADED and prints the rollback commands"
  fi
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

# myrmidon(POST-DEPLOY-CHECK): the deploy window starts when the first
# board-affecting step runs (the maintenance enter below). Issues blocked after
# this moment are the failure signature the post-deploy check looks for.
deploy_started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

log "4/8 enter maintenance"
maintenance_enter "deploy $MYRMIDON_IMAGE@${digest:0:19}"

log "5/8 wait for running runs"
# myrmidon(DEPLOY-TIMEOUT-EXIT): the drain happens with maintenance already on,
# so a failed wait must not die inside wait_for_idle_runs and leave the board in
# maintenance until someone lifts it by hand. The wait returns 1 instead of
# dying; here we lift maintenance, then die, so the board serves traffic again
# and the image has not changed (nothing after this point ran). The state flag
# keeps the final message true when the lift itself fails (maintenance may
# already be off): then the reason stays "the drain did not finish", and the
# operator is told maintenance is still on, not that it was lifted.
if ! wait_for_idle_runs; then
  log "drain failed; lifting maintenance before aborting (image not changed)"
  lift_ok=1
  maintenance_exit || lift_ok=0
  if ((lift_ok == 0)); then
    log "WARNING: could not lift maintenance (it may already be off); check $MAINTENANCE_MODE manually"
    die "runs: deploy aborted before changing the image; maintenance lift failed (see WARNING above)"
  fi
  die "runs: deploy aborted before changing the image; maintenance was lifted"
fi

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

# TRACING-HEALTH: the gateway must carry the OTLP-only callback set. A legacy
# `langfuse` callback against a v4 Langfuse server makes the gateway reject
# about 12k events per hour while everything looks healthy, so a refusal stops
# the deploy exactly like a failed health check (maintenance stays on, the
# rollback command is printed). The check is read-only: without a
# MYRMIDON_TRACING_* setting it logs a skip and the deploy continues.
log "7b/8 verify LLM tracing callbacks"
if ! "$MYR_SCRIPT_DIR/tracing-check.sh" \
  --langfuse-url "${MYRMIDON_TRACING_LANGFUSE_URL:-}" \
  --langfuse-version "${MYRMIDON_TRACING_LANGFUSE_VERSION:-}" \
  --gateway-config "${MYRMIDON_TRACING_GATEWAY_CONFIG:-}" \
  --callbacks-command "${MYRMIDON_TRACING_CALLBACKS_COMMAND:-}" \
  --intended-file "${MYRMIDON_TRACING_CALLBACKS_FILE:-$(tracing_callbacks_file_default)}" \
  ${MYRMIDON_TRACING_TOKEN_FILE:+--token-file "$MYRMIDON_TRACING_TOKEN_FILE"}; then
  log "DEPLOY FAILED: $ref is running and healthy, but the LLM tracing callbacks are refused. Maintenance stays on."
  log "Fix the gateway callbacks (OTLP only, 'langfuse_otel') and run the deploy again."
  log "Roll back with: $MYR_SCRIPT_DIR/rollback.sh --config $config"
  exit 1
fi

log "8/8 leave maintenance"
# myrmidon(EXIT-ASYNC): the exit POST returns once the window is marked
# `leaving`; maintenance_exit then waits (bounded) for the window to retire, so
# the deploy waits on the STATE, not on the HTTP call.
maintenance_exit

# myrmidon(POST-DEPLOY-CHECK): the board is live again — prove the deploy did
# not leave the fleet stalled. A degraded verdict does NOT fail the deploy (the
# image is switched and healthy); it is reported loudly so the operator reacts
# at once instead of finding a stalled team by hand.
log "post-deploy fleet check"
if ! post_deploy_fleet_check "$deploy_started_at"; then
  log "DEPLOY DEGRADED: $ref is running and healthy, but the post-deploy check reported problems above; inspect the board now"
fi
log "deployed $ref (previous: ${previous:-<none>}, dump: $LAST_DUMP_FILE)"

# RELEASE-GATE: the components of the same release roll out in this same run.
# A component failure marks the deploy DEGRADED (the board itself is healthy;
# the rollback commands are printed, not auto-run: the operator decides).
component_failures=""
if [[ -n "$component_digests" ]]; then
  log "9/10 roll out release components"
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    name="${line%%=*}"
    cdigest="${line#*=}"
    log "rolling out $name at $cdigest"
    if ! "$MYR_SCRIPT_DIR/rollout-component.sh" --config "$config" --component "$name" --digest "$cdigest"; then
      component_failures="$component_failures $name"
    fi
  done <<<"$component_digests"
  if [[ -n "$component_failures" ]]; then
    log "DEGRADED: component rollout failed for:$component_failures"
    log "Roll back the board with: $MYR_SCRIPT_DIR/rollback.sh --config $config"
    log "Roll back a component with: $MYR_SCRIPT_DIR/rollback-component.sh --config $config --component <dockergate|fleetd>"
    exit 1
  fi
fi

# RELEASE-GATE: post-deploy smoke. Within MYR_SMOKE_TIMEOUT_SEC at least one
# bot container must re-apply; otherwise the deploy is DEGRADED with the
# rollback commands. Skipped only when explicitly disabled or unconfigured
# (no company): an unconfigured smoke on a bot fleet is itself reported.
if [[ "$MYR_SMOKE_ENABLED" == "1" ]]; then
  if [[ -z "$MYR_SMOKE_COMPANY" ]]; then
    log "WARNING: post-deploy bot smoke skipped: MYRMIDON_DEPLOY_SMOKE_COMPANY is not set; the deploy cannot prove a bot re-applied"
  else
    log "10/10 post-deploy smoke: waiting for a bot container to re-apply"
    smoke_args=(--board-url "${BOARD_API_URL:-$MAINTENANCE_API_URL}" --company "$MYR_SMOKE_COMPANY" --timeout "$MYR_SMOKE_TIMEOUT_SEC" --interval "$MYR_SMOKE_INTERVAL_SEC")
    [[ -n "$MYR_SMOKE_AGENT" ]] && smoke_args+=(--agent "$MYR_SMOKE_AGENT")
    [[ -n "$HEALTH_TOKEN_FILE" ]] && smoke_args+=(--token-file "$HEALTH_TOKEN_FILE")
    if ! "$MYR_SCRIPT_DIR/bot-apply-smoke.sh" "${smoke_args[@]}"; then
      log "DEGRADED: no bot container re-applied within ${MYR_SMOKE_TIMEOUT_SEC}s"
      log "Roll back the board with: $MYR_SCRIPT_DIR/rollback.sh --config $config"
      log "Roll back a component with: $MYR_SCRIPT_DIR/rollback-component.sh --config $config --component <dockergate|fleetd>"
      exit 1
    fi
  fi
fi

log "release gate passed: board and $MYR_RELEASE_COMPONENTS rolled out together, bots re-apply"
