#!/usr/bin/env bash
# TRACING-HEALTH: verifies that LLM tracing runs over OTLP only.
#
#   tracing-check.sh [--langfuse-url URL] [--langfuse-version V]
#                    [--gateway-config FILE] [--callbacks-command CMD]
#                    [--intended-file FILE] [--token-file FILE]
#                    [--print-intended] [--write-intended FILE]
#
# Langfuse v4 in the default `events_only` write mode rejects the legacy trace
# and observation events on `/api/public/ingestion`. LiteLLM keeps sending them
# for as long as the legacy `langfuse` callback is enabled: the 02.10 incident
# was about 12k "Bad request" responses per hour, it burned gateway CPU, and
# nobody noticed because nothing checked tracing. Tracing therefore runs over
# OTLP only (`langfuse_otel`), and this script refuses to let a legacy callback
# pass against a v4 server.
#
# Reads two lists and compares them with the v4 marker:
#   * intended — the callback list of the bundle, ONE source of truth. It comes
#     from the generated file (`--intended-file`, written by `deploy.sh` or by
#     `--write-intended`), which is generated from tracing_intended_callbacks()
#     in lib.sh; with no file yet, the function itself answers.
#   * effective — the live gateway's callbacks: the stdout of
#     `--callbacks-command` (the live gateway or its database) plus the
#     `callbacks:` list of the deployed config file (`--gateway-config`). The
#     union is taken because the config file and the gateway database disagree
#     and the database only adds callbacks.
#
# v4 detection: `GET <langfuse-url>/api/public/health` is a public route and
# answers `{"status":…,"version":"4.x.y"}`; the major version is the documented
# marker (v4 rejects the legacy ingestion endpoint in events_only mode). The
# documented fallback is the version the release bundle pins
# (`--langfuse-version` / MYRMIDON_TRACING_LANGFUSE_VERSION), used when the
# route is unreachable or answers without a version. A legacy callback with an
# unproven version is refused too: a silent install is exactly what the
# incident was about.
#
# Exit 0 when the callbacks are the OTLP-only set (or no tracing input is
# configured, which is logged as a skip); exit 1 on the refusal. There is no
# flag, setting or dry run that skips the refusal: a non-zero exit must stop
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
write_intended="" print_intended=0

while (($#)); do
  case "$1" in
    --langfuse-url) langfuse_url="$2"; shift 2 ;;
    --langfuse-version) langfuse_version="$2"; shift 2 ;;
    --gateway-config) gateway_config="$2"; shift 2 ;;
    --callbacks-command) callbacks_command="$2"; shift 2 ;;
    --intended-file) intended_file="$2"; shift 2 ;;
    --token-file) token_file="$2"; shift 2 ;;
    --write-intended) write_intended="$2"; shift 2 ;;
    --print-intended) print_intended=1; shift ;;
    -h|--help) sed -n '2,35p' "$0"; exit 0 ;;
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

if ! tracing_check "$langfuse_url" "$langfuse_version" "$intended_file" \
  "$gateway_config" "$callbacks_command" "$token_file"; then
  die "LLM tracing refused: the legacy 'langfuse' callback cannot be installed against a Langfuse v4 server (see the refusal above). Install the OTLP callback 'langfuse_otel' only."
fi