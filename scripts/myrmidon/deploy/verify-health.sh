#!/usr/bin/env bash
# Polls /api/health until the server reports status ok and the expected
# version and commit.
#
#   verify-health.sh --url http://127.0.0.1:3100/api/health \
#     --expect-version 2026.916.1-myr.1 --expect-commit <40-char sha> \
#     [--timeout 300] [--token-file <file>] [--interval 5]
#
# In `authenticated` deployments anonymous health responses carry the commit
# but not the version; pass a board API key file with --token-file to check
# the version too. Exit 0 on match, 1 otherwise.
set -euo pipefail
# shellcheck source=lib.sh source-path=SCRIPTDIR
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

url="" expect_version="" expect_commit="" timeout=300 token_file="" interval=5
while (($#)); do
  case "$1" in
    --url) url="$2"; shift 2 ;;
    --expect-version) expect_version="$2"; shift 2 ;;
    --expect-commit) expect_commit="$2"; shift 2 ;;
    --timeout) timeout="$2"; shift 2 ;;
    --token-file) token_file="$2"; shift 2 ;;
    --interval) interval="$2"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ -n "$url" ]] || die "--url is required"
[[ -n "$expect_version" || -n "$expect_commit" ]] || die "give --expect-version and/or --expect-commit"
require_cmd curl jq

deadline=$((SECONDS + timeout))
body=""
while :; do
  if body="$(http_get "$url" "$token_file" 2>/dev/null)" && [[ "$(jq -r '.status // empty' <<<"$body")" == "ok" ]]; then
    break
  fi
  body=""
  ((SECONDS < deadline)) || die "health: $url did not report status ok within ${timeout}s"
  sleep "$interval"
done

version="$(jq -r '.version // empty' <<<"$body")"
commit="$(jq -r '.commit // empty' <<<"$body")"
log "health: status ok, version ${version:-<hidden>}, commit ${commit:-<none>}"

failed=0
if [[ -n "$expect_commit" && "$commit" != "$expect_commit" ]]; then
  log "health: commit mismatch: got ${commit:-<none>}, expected $expect_commit"
  failed=1
fi
if [[ -n "$expect_version" ]]; then
  if [[ -z "$version" ]]; then
    log "health: version is not in the response (authenticated mode hides it from anonymous callers); set --token-file / HEALTH_TOKEN_FILE"
    failed=1
  elif [[ "$version" != "$expect_version" ]]; then
    log "health: version mismatch: got $version, expected $expect_version"
    failed=1
  fi
fi
exit "$failed"
