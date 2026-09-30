#!/usr/bin/env bash
# Rolls the server back to the previous image digest.
#
#   rollback.sh --config deploy.env [--to sha256:<64 hex> | --to-image <ref>] [--dry-run]
#               [--local [<ref>]] [--restore-dump <file> [--yes-restore-database]]
#
# Without --to/--to-image it uses the image deploy.sh remembered before the last
# deploy (full reference, so the first rollback can return to a vendor image).
# --to-image takes any reference (repo:tag or repo@sha256:...).
# --local (myrmidon(ROLLBACK-LOCAL)) rolls back to an image that is already on
# the deploy host, without pulling: pre-1.1.0 builds are not in the registry,
# and the registry may be the thing that is broken. The reference comes from
# the argument, from MYRMIDON_ROLLBACK_LOCAL in the settings file, or (with no
# value) from --to/--to-image; the image must pass `docker image inspect`, and
# a missing one stops the rollback with the local tags that do exist.
# The database is NOT restored unless --restore-dump is given: migrations are
# one-way, so restoring throws away everything written since the dump. A
# restore asks to type RESTORE, or takes --yes-restore-database. It runs
# RESTORE_COMMAND with DUMP_FILE set while the server service is stopped.
# Maintenance stays on until the old image passes the health check.
#
# Rollback is the emergency path and is never blocked by where the target image
# came from. It does check the target the way deploy.sh checks a new image (a
# CI image in the registry, built from a commit on origin/main or a myr-v* tag)
# and prints a WARNING when it is not one: the first rollback from a vendor
# image, or from an image built by hand, is expected to warn.
set -euo pipefail
# shellcheck source=lib.sh source-path=SCRIPTDIR
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

config="" target="" target_image="" local_arg="unset" restore_dump="" yes_restore=0 expect_version="" expect_commit=""
DRY_RUN=0
while (($#)); do
  case "$1" in
    --config) config="$2"; shift 2 ;;
    --to) target="$2"; shift 2 ;;
    --to-image) target_image="$2"; shift 2 ;;
    --local)
      # myrmidon(ROLLBACK-LOCAL): optional value; --local <ref>, --local=<ref> or bare.
      if [[ "${2:-}" != -* && -n "${2:-}" ]]; then local_arg="$2"; shift 2; else local_arg=""; shift; fi ;;
    --local=*)
      # myrmidon(ROLLBACK-LOCAL): --local=<ref>; an empty value acts as bare --local.
      local_arg="${1#*=}"; shift ;;
    --restore-dump) restore_dump="$2"; shift 2 ;;
    --yes-restore-database) yes_restore=1; shift ;;
    --expect-version) expect_version="$2"; shift 2 ;;
    --expect-commit) expect_commit="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
load_config "$config"
require_cmd docker curl jq

[[ -z "$target" || -z "$target_image" ]] || die "give --to or --to-image, not both"

# myrmidon(ROLLBACK-LOCAL): local mode. The reference comes from --local, from
# MYRMIDON_ROLLBACK_LOCAL in the settings file, or (bare --local) from
# --to/--to-image. Local mode never pulls and never reads the registry: the
# image must already be on the deploy host, which is exactly the situation it
# exists for (pre-1.1.0 builds are not in the registry; the registry may be
# unreachable during the incident being rolled back from).
if [[ "$local_arg" == "unset" ]]; then
  if [[ -n "${MYRMIDON_ROLLBACK_LOCAL:-}" ]]; then
    local_arg="$MYRMIDON_ROLLBACK_LOCAL"
  fi
fi
rollback_local=0
if [[ "$local_arg" != "unset" ]]; then
  rollback_local=1
  if [[ -z "$local_arg" ]]; then
    if [[ -n "$target" || -n "$target_image" ]]; then
      : # bare --local: use the reference given with --to/--to-image
    else
      die "--local without a value needs --to sha256:... or --to-image <ref> (or MYRMIDON_ROLLBACK_LOCAL in the settings file)"
    fi
  else
    [[ -z "$target" && -z "$target_image" ]] || die "give the local reference with --local, not together with --to/--to-image"
    if valid_digest "$local_arg"; then
      target="$local_arg"
    else
      target_image="$local_arg"
    fi
  fi
fi

if [[ -n "$target" ]]; then
  valid_digest "$target" || die "rollback target is not a digest: $target"
  ref="$MYRMIDON_IMAGE@$target"
elif [[ -n "$target_image" ]]; then
  ref="$target_image"
elif [[ -f "$PREVIOUS_IMAGE_FILE" ]]; then
  ref="$(tr -d '[:space:]' <"$PREVIOUS_IMAGE_FILE")"
elif [[ -f "$PREVIOUS_FILE" ]]; then
  target="$(tr -d '[:space:]' <"$PREVIOUS_FILE")"
  valid_digest "$target" || die "rollback target is not a digest: $target"
  ref="$MYRMIDON_IMAGE@$target"
else
  die "no previous image recorded in $STATE_DIR; pass --to sha256:... or --to-image <ref>"
fi
[[ "$ref" =~ ^[A-Za-z0-9./_:@-]+$ ]] || die "rollback target is not an image reference: $ref"
current="$(current_digest)"
current_ref="$(current_image)"

if [[ "$rollback_local" == "1" ]]; then
  # The local daemon is the source of truth here: checked before anything
  # changes. A tag reference must resolve to exactly one image, or the wrong
  # one could come up.
  require_local_image "$ref"
  log "local rollback: using $ref as found on the docker daemon (no pull)"
else
  # Does not block: says loudly when the target is not a verified CI image.
  if ! check_ci_image "$ref"; then
    log "WARNING: rollback target is not a verified CI image: $CI_CHECK_REASON"
    log "WARNING: continuing anyway, rollback is the emergency path"
  fi
fi

if [[ -n "$restore_dump" ]]; then
  [[ -n "$RESTORE_COMMAND" ]] || die "RESTORE_COMMAND is not set; cannot restore $restore_dump"
  [[ -s "$restore_dump" ]] || die "dump file missing or empty: $restore_dump"
fi

if [[ "$DRY_RUN" == "1" ]]; then
  log "dry run: nothing will be changed. Plan:"
  if [[ "$rollback_local" == "1" ]]; then
    plan "1. use $ref from the local docker daemon (no pull; verified with docker image inspect)"
  else
    plan "1. docker pull $ref"
  fi
  plan "2. enter maintenance (MAINTENANCE_MODE=$MAINTENANCE_MODE) if not already on"
  if [[ -n "$restore_dump" ]]; then
    plan "3. stop $COMPOSE_SERVICE and restore database from $restore_dump (RESTORE_COMMAND), after confirmation"
  else
    plan "3. database is not restored (no --restore-dump)"
  fi
  plan "4. set image in $OVERRIDE_PATH from ${current_ref:-<none>} to $ref; docker compose up -d --no-deps $COMPOSE_SERVICE"
  plan "5. verify $HEALTH_URL against the image labels"
  plan "6. leave maintenance"
  exit 0
fi

if [[ "$rollback_local" == "1" ]]; then
  log "1/6 use local image $ref (no pull)"
else
  log "1/6 pull $ref"
  docker pull --quiet "$ref" >/dev/null || die "cannot pull $ref"
fi
[[ -n "$expect_version" ]] || expect_version="$(image_label "$ref" org.opencontainers.image.version)"
[[ -n "$expect_commit" ]] || expect_commit="$(image_label "$ref" org.opencontainers.image.revision)"

log "2/6 enter maintenance"
maintenance_enter "rollback to ${ref:0:80}"

if [[ -n "$restore_dump" ]]; then
  if [[ "$yes_restore" != "1" ]]; then
    printf 'Restoring %s replaces the current database. Everything written since the dump is lost.\nType RESTORE to continue: ' "$restore_dump" >&2
    read -r answer || answer=""
    [[ "$answer" == "RESTORE" ]] || die "database restore not confirmed; nothing changed"
  fi
  log "3/6 stop $COMPOSE_SERVICE and restore $restore_dump"
  compose stop "$COMPOSE_SERVICE"
  DUMP_FILE="$restore_dump" bash -c "$RESTORE_COMMAND" || die "restore command failed; server is stopped, image unchanged"
else
  log "3/6 database not restored"
fi

log "4/6 switch image to $ref"
write_override_ref "$ref"
compose up -d --no-deps "$COMPOSE_SERVICE"
record_history rollback "$ref"
if [[ -n "$current" && "$current" != "$target" ]]; then
  printf '%s\n' "$current" >"$PREVIOUS_FILE"
fi
if [[ -n "$current_ref" && "$current_ref" != "$ref" ]]; then
  printf '%s\n' "$current_ref" >"$PREVIOUS_IMAGE_FILE"
fi

log "5/6 verify health"
"$MYR_SCRIPT_DIR/verify-health.sh" --url "$HEALTH_URL" --timeout "$HEALTH_TIMEOUT_SEC" \
  --expect-version "$expect_version" --expect-commit "$expect_commit" \
  ${HEALTH_TOKEN_FILE:+--token-file "$HEALTH_TOKEN_FILE"} --interval "$POLL_INTERVAL_SEC" \
  || die "ROLLBACK FAILED health check; maintenance stays on. Inspect: docker compose logs $COMPOSE_SERVICE"

log "6/6 leave maintenance"
maintenance_exit
log "rolled back to $ref"
