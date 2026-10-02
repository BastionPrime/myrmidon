#!/usr/bin/env bash
# TRACING-HEALTH: verifies that LLM tracing runs over OTLP only, that it
# delivers, and that the Langfuse and gateway images are pinned.
#
#   tracing-check.sh [--langfuse-url URL] [--langfuse-version V]
#                    [--gateway-config FILE] [--callbacks-command CMD]
#                    [--intended-file FILE] [--token-file FILE]
#                    [--delivery-command CMD] [--delivery-window SEC]
#                    [--langfuse-image REF] [--gateway-image REF]
#                    [--print-intended] [--write-intended FILE]
#
# Langfuse v4 in the default `events_only` write mode rejects the legacy trace
# and observation events on `/api/public/ingestion`. LiteLLM keeps sending them
# for as long as the legacy `langfuse` callback is enabled: the 02.10 incident
# was about 12k "Bad request" responses per hour, it burned gateway CPU, and
# nobody noticed because nothing checked tracing. Tracing therefore runs over
# OTLP only, and this script refuses an unsafe tracing configuration.
#
# Three checks, each skipped when its settings are absent:
#
# 1. Callbacks. Reads two lists and compares them with the v4 marker:
#    * intended — the callback list of the bundle, ONE source of truth. It comes
#      from the generated file (`--intended-file`, written by `deploy.sh` or by
#      `--write-intended`), which is generated from tracing_intended_callbacks()
#      in lib.sh; with no file yet, the function itself answers.
#    * effective — the live gateway's callbacks: the stdout of
#      `--callbacks-command` (the live gateway or its database) plus the
#      `callbacks:` list of the deployed config file (`--gateway-config`). The
#      union is taken because the config file and the gateway database disagree
#      and the database only adds callbacks.
#    v4 detection: `GET <langfuse-url>/api/public/health` is a public route and
#    answers `{"status":…,"version":"4.x.y"}`; the major version is the
#    documented marker (v4 rejects the legacy ingestion endpoint in events_only
#    mode). The documented fallback is the version the release bundle pins
#    (`--langfuse-version`). A legacy callback with an unproven version is
#    refused too: a silent install is exactly what the incident was about.
#
# 2. Image pins. `--langfuse-image` and `--gateway-image` must carry a full
#    X.Y.Z tag or a digest: a major or minor tag moves under the deployment and
#    is not a pin.
#
# 3. Delivery. The installer sends a test request and waits for an OTEL event
#    in `events_core`; without that event the install is NOT complete, so the
#    check treats it as a refusal, not a silent success. `--delivery-command`
#    prints two integers for the window (`--delivery-window`, 15 min by
#    default): the OTEL event count and the LiteLLM SpendLogs request count.
#    Zero events with traffic, a ratio below 50 %, or unreadable counts are
#    refused.
#
# Exit 0 when every configured check passes; exit 1 on the first refusal. There
# is no flag, setting or dry run that skips a refusal: a non-zero exit must stop
# the install/deploy.
set -euo pipefail
# shellcheck source=lib.sh source-path=SCRIPTDIR
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

langfuse_url="${MYRMIDON_TRACING_LANGFUSE_URL:-}"
langfuse_version="${MYRMIDON_TRACING_LANGFUSE_VERSION:-}"
gateway_config="${MYRMIDON_TRACING_GATEWAY_CONFIG:-}"
callbacks_command="${MYRMIDON_TRACING_CALLBACKS_COMMAND:-}"
intended_file="${MYRMIDON_TRACING_CALLBACKS_FILE:-$(tracing_callbacks_file_default)}"
token_file="${MYRMIDON_TRACING_TOKEN_FILE:-}"
delivery_command="${MYRMIDON_TRACING_DELIVERY_COMMAND:-}"
delivery_window="${MYRMIDON_TRACING_DELIVERY_WINDOW_SEC:-900}"
langfuse_image="${MYRMIDON_TRACING_LANGFUSE_IMAGE:-}"
gateway_image="${MYRMIDON_TRACING_GATEWAY_IMAGE:-}"
write_intended="" print_intended=0

while (($#)); do
  case "$1" in
    --langfuse-url) langfuse_url="$2"; shift 2 ;;
    --langfuse-version) langfuse_version="$2"; shift 2 ;;
    --gateway-config) gateway_config="$2"; shift 2 ;;
    --callbacks-command) callbacks_command="$2"; shift 2 ;;
    --intended-file) intended_file="$2"; shift 2 ;;
    --token-file) token_file="$2"; shift 2 ;;
    --delivery-command) delivery_command="$2"; shift 2 ;;
    --delivery-window) delivery_window="$2"; shift 2 ;;
    --langfuse-image) langfuse_image="$2"; shift 2 ;;
    --gateway-image) gateway_image="$2"; shift 2 ;;
    --write-intended) write_intended="$2"; shift 2 ;;
    --print-intended) print_intended=1; shift ;;
    -h|--help) sed -n '2,52p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

if [[ -n "$write_intended" ]]; then
  # Generates the bundle's intended list from the single source of truth, so
  # the gateway config and every check read the same file.
  tracing_write_callbacks_file "$write_intended"
  log "tracing: wrote the intended callback list to $write_intended"
  exit 0
fi

if ((print_intended)); then
  tracing_intended_callbacks
  exit 0
fi

require_cmd curl jq

if [[ -z "$langfuse_url$langfuse_version$gateway_config$callbacks_command$delivery_command$langfuse_image$gateway_image" ]]; then
  log "tracing: no MYRMIDON_TRACING_* input configured; the tracing checks are skipped"
  exit 0
fi

if ! tracing_check_image_pins "$langfuse_image" "$gateway_image"; then
  die "LLM tracing refused: an image reference is not pinned (see the refusal above). Pin it by X.Y.Z or by digest."
fi

if ! tracing_check "$langfuse_url" "$langfuse_version" "$intended_file" \
  "$gateway_config" "$callbacks_command" "$token_file"; then
  die "LLM tracing refused: the legacy 'langfuse' callback cannot be installed against a Langfuse v4 server (see the refusal above). Install the OTLP callback 'langfuse_otel' only."
fi

if ! tracing_delivery_check "$delivery_command" "$delivery_window"; then
  die "LLM tracing refused: the gateway does not deliver OTEL events (see the refusal above). The tracing install is not complete."
fi