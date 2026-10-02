#!/usr/bin/env bash
# scripts/myrmidon/deploy/bot-apply-smoke.sh
#
# RELEASE-GATE (the 01.10 incident): post-deploy smoke of the bot fleet. The
# incident showed a deploy can be "healthy" (the board answers /api/health)
# while every bot apply is denied by a mismatched dockergate and the whole
# fleet sits in `created`. This script watches the board until at least one
# bot container re-applies successfully — within a bounded window — and
# reports the outcome so deploy.sh can call it DEGRADED and print the rollback
# command when it does not happen.
#
#   bot-apply-smoke.sh --board-url <http://host:3100/api> --token-file <file>
#                      --company <companyId> [--timeout 300] [--interval 10]
#                      [--agent <id>] [--dry-run]
#
# The signal is the board's own bot-container status: it asks the reconciler's
# driver for the live container state, so "a container is running and its
# marker reports the applied limit" is exactly the fact the incident lacked.
# Success criteria, in order of strength:
#   1. the agent named by --agent (or the first eligible one) has a container
#      in state `running` (re-created and started after the board came back);
#   2. any eligible agent has a container in state `running`.
# The response also carries containerError, which we surface on failure.
#
# Exit codes: 0 = at least one bot re-applied; 1 = not within the timeout
# (print the diagnosis); 2 = usage/transport error.
set -euo pipefail

log() { printf '[myrmidon-smoke] %s\n' "$*" >&2; }
die() { printf '[myrmidon-smoke] ERROR: %s\n' "$*" >&2; exit 2; }

board_url="" token_file="" company="" timeout_sec=300 interval=10 agent="" dry_run=0
while (($#)); do
  case "$1" in
    --board-url) board_url="$2"; shift 2 ;;
    --token-file) token_file="$2"; shift 2 ;;
    --company) company="$2"; shift 2 ;;
    --timeout) timeout_sec="$2"; shift 2 ;;
    --interval) interval="$2"; shift 2 ;;
    --agent) agent="$2"; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    -h|--help) sed -n '2,27p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ -n "$board_url" ]] || die "--board-url is required (the board API root, e.g. http://127.0.0.1:3100/api)"
[[ -n "$company" ]] || die "--company is required (the company whose agents to watch; the agents list is company-scoped)"
[[ "$timeout_sec" =~ ^[0-9]+$ ]] || die "--timeout must be a number of seconds"
[[ "$interval" =~ ^[1-9][0-9]*$ ]] || die "--interval must be a positive number of seconds"

auth_args=()
if [[ -n "$token_file" ]]; then
  [[ -r "$token_file" ]] || die "token file not readable: $token_file"
  auth_args=(-H "Authorization: Bearer $(cat "$token_file")")
fi

# The company's agents: one read-only call; each row has id and adapterType.
list_agent_ids() {
  local body
  body="$(curl -fsS --max-time 10 "${auth_args[@]}" "$board_url/companies/$company/agents" 2>/dev/null)" || return 1
  jq -r '[.[]? | select(.adapterType == "hermes_gateway") | .id] | join(" ")' <<<"$body" 2>/dev/null
}

# Status of one agent's bot container (routes.ts bot-container status).
container_state() {
  local id="$1" body
  body="$(curl -fsS --max-time 10 "${auth_args[@]}" "$board_url/myrmidon/agents/$id/bot-container/status" 2>/dev/null)" || return 1
  jq -r '.container.state // "missing"' <<<"$body" 2>/dev/null
}

container_error() {
  local id="$1" body
  body="$(curl -fsS --max-time 10 "${auth_args[@]}" "$board_url/myrmidon/agents/$id/bot-container/status" 2>/dev/null)" || return 1
  jq -r '.containerError // ""' <<<"$body" 2>/dev/null
}

if [[ "$dry_run" == "1" ]]; then
  log "dry run: would poll $board_url/companies/$company/agents and each bot-container status for a running bot container, timeout ${timeout_sec}s, interval ${interval}s${agent:+, agent $agent}"
  exit 0
fi

log "waiting for a bot container to re-apply (timeout ${timeout_sec}s)"
deadline=$((SECONDS + timeout_sec))
while ((SECONDS < deadline)); do
  ids=""
  if [[ -n "$agent" ]]; then
    ids="$agent"
  else
    ids="$(list_agent_ids || true)"
  fi
  if [[ -z "$ids" ]]; then
    log "no hermes_gateway agents listed (board not ready yet, or none in company $company)"
  else
    running="" other="" last_error=""
    for id in $ids; do
      state="$(container_state "$id" || echo missing)"
      case "$state" in
        running) [[ -z "$running" ]] && running="$id" ;;
        *) other="$other ${id##*-}:$state"; last_error="$(container_error "$id" || true)" ;;
      esac
    done
    if [[ -n "$running" ]]; then
      log "OK: bot container of agent $running is running (re-applied after the deploy)"
      exit 0
    fi
    log "no running bot container yet (states:$other)${last_error:+; last containerError: $last_error}"
  fi
  sleep "$interval"
done

log "SMOKE FAILED: no bot container re-applied within ${timeout_sec}s"
exit 1
