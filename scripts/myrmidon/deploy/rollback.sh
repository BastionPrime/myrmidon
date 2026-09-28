#!/usr/bin/env bash
# Rolls the server back to the previous image digest.
#
#   rollback.sh --config deploy.env [--to sha256:<64 hex> | --to-image <ref>] [--dry-run]
#               [--restore-dump <file> [--yes-restore-database]]
#
# Without --to/--to-image it uses the image deploy.sh remembered before the last
# deploy (full reference, so the first rollback can return to a vendor image).
# --to-image takes any reference (repo:tag or repo@sha256:...).
# The database is NOT restored unless --restore-dump is given: migrations are
# one-way, so restoring throws away everything written since the dump. A
# restore asks to type RESTORE, or takes --yes-restore-database. It runs
# RESTORE_COMMAND with DUMP_FILE set while the server service is stopped.
# Maintenance stays on until the old image passes the health check.
set -euo pipefail
# shellcheck source=lib.sh source-path=SCRIPTDIR
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

config="" target="" target_image="" restore_dump="" yes_restore=0 expect_version="" expect_commit=""
DRY_RUN=0
while (($#)); do
  case "$1" in
    --config) config="$2"; shift 2 ;;
    --to) target="$2"; shift 2 ;;
    --to-image) target_image="$2"; shift 2 ;;
    --restore-dump) restore_dump="$2"; shift 2 ;;
    --yes-restore-database) yes_restore=1; shift ;;
    --expect-version) expect_version="$2"; shift 2 ;;
    --expect-commit) expect_commit="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
load_config "$config"
require_cmd docker curl jq

[[ -z "$target" || -z "$target_image" ]] || die "give --to or --to-image, not both"
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

if [[ -n "$restore_dump" ]]; then
  [[ -n "$RESTORE_COMMAND" ]] || die "RESTORE_COMMAND is not set; cannot restore $restore_dump"
  [[ -s "$restore_dump" ]] || die "dump file missing or empty: $restore_dump"
fi

if [[ "$DRY_RUN" == "1" ]]; then
  log "dry run: nothing will be changed. Plan:"
  plan "1. docker pull $ref"
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

log "1/6 pull $ref"
docker pull --quiet "$ref" >/dev/null || die "cannot pull $ref"
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
