#!/usr/bin/env bash
# TRACING-HEALTH (part E): the live tracing contract check.
#
# Why: the 02.10 incident class is a tracing path that LOOKS healthy. Langfuse
# v4 runs in `events_only` write mode, where the legacy `/api/public/ingestion`
# endpoint rejects trace/observation events; LiteLLM keeps sending them while
# the legacy `langfuse` callback is configured, so the installation produced
# ~12k "Bad request" events per hour, burned gateway CPU and showed nothing in
# the dashboard. A static config check cannot tell which path actually ships
# events; only a live stack can.
#
# What this script proves, with one completion and nothing else:
#   1. the test stack comes up (LiteLLM + Langfuse v4 + ClickHouse + stores);
#   2. the gateway accepts ONE chat completion;
#   3. THAT completion produced EXACTLY ONE OTEL event in ClickHouse
#      `events_core` (not "at least one" - the count is the contract);
#   4. there are ZERO ingestion rejections: no "Rejected"/"Bad request" line in
#      the Langfuse logs, no "API errors occurred" burst in the gateway log;
#   5. (the same evidence from the other side) the legacy ingestion route was
#      never called, and the OTLP route was.
#
# The stack is docker/tracing/docker-compose.contract.yml: test-only, every
# image pinned to an exact version, nothing published beyond loopback, and all
# credentials generated here for this run. The model provider is a stub inside
# the compose network (a host-loopback provider cannot be reached from a
# container via host.docker.internal), so no provider is contacted.
#
# Usage: tracing-contract-check.sh [--keep]
#   --keep   leave the stack and the work dir in place for inspection
#
# Environment:
#   TRACING_CONTRACT_WORKDIR   daemon-visible work dir (default: cwd, then the
#                              repository parent; never /tmp)
#   TRACING_CONTRACT_PORT_BASE first host port (default: derived from the pid)
#   TRACING_CONTRACT_UP_TIMEOUT_SEC   stack readiness window (default 600)
#   TRACING_CONTRACT_EVENT_TIMEOUT_SEC  event window (default 300)
#
# Exit 0: the contract holds. Exit 1: it does not (a refusal is never skipped).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT/docker/tracing/docker-compose.contract.yml"
PROJECT="tracing-contract"
KEEP=0

while (($#)); do
  case "$1" in
    --keep) KEEP=1; shift ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "[tracing-contract] ERROR: unknown argument: $1" >&2; exit 1 ;;
  esac
done

log()  { echo "[tracing-contract] $*"; }
fail() { echo "[tracing-contract] ERROR: $*" >&2; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required"
}

require_cmd docker
require_cmd curl
[ -r "$COMPOSE_FILE" ] || fail "compose file not found: $COMPOSE_FILE"
docker version --format '{{.Server.Version}}' >/dev/null 2>&1 \
  || fail "no docker daemon reachable"
docker compose version >/dev/null 2>&1 || fail "docker compose is required"

# --- work dir the daemon can bind-mount ---------------------------------------
# A private tmpfs namespace (sandboxed shells) is invisible to dockerd even
# though it looks local, so /tmp is never a candidate.
pick_workdir() {
  local candidate
  for candidate in "${TRACING_CONTRACT_WORKDIR:-}" "$PWD" "$(dirname "$ROOT")"; do
    [ -n "$candidate" ] || continue
    case "${candidate%/}" in /tmp|/tmp/*) continue ;; esac
    if [ -d "$candidate" ] && [ -w "$candidate" ]; then
      mktemp -d "${candidate%/}/tracing-contract.XXXXXX" && return 0
    fi
  done
  return 1
}
WORK="$(pick_workdir)" || fail "no daemon-visible work dir found (set TRACING_CONTRACT_WORKDIR)"
ENV_FILE="$WORK/contract.env"

# --- run values (generated here, never in the repository) ---------------------
rand_hex() {
  local n="$1"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$n"
  else
    python3 -c "import secrets,sys; print(secrets.token_hex(int(sys.argv[1])))" "$n"
  fi
}

BASE="${TRACING_CONTRACT_PORT_BASE:-$((39000 + ($$ % 300) * 12))}"
WEB_PORT=$((BASE + 1))
LITELLM_PORT=$((BASE + 2))
CLICKHOUSE_PORT=$((BASE + 3))
S3_PORT=$((BASE + 4))
UP_TIMEOUT="${TRACING_CONTRACT_UP_TIMEOUT_SEC:-600}"
EVENT_TIMEOUT="${TRACING_CONTRACT_EVENT_TIMEOUT_SEC:-300}"

POSTGRES_PASSWORD="$(rand_hex 16)"
REDIS_PASSWORD="$(rand_hex 16)"
CLICKHOUSE_PASSWORD="$(rand_hex 16)"
SALT="$(rand_hex 16)"
NEXTAUTH_SECRET="$(rand_hex 32)"
ENCRYPTION_KEY="$(rand_hex 32)"
S3_ACCESS_KEY="contract$(rand_hex 6)"
S3_SECRET_KEY="$(rand_hex 16)"
USER_PASSWORD="$(rand_hex 16)"
MASTER_KEY="sk-contract-$(rand_hex 12)"
MOCK_API_KEY="sk-mock-$(rand_hex 8)"
PUBLIC_KEY="pk-lf-contract-$(rand_hex 8)"
SECRET_KEY="sk-lf-contract-$(rand_hex 8)"
ORG_ID="contract-org"
PROJECT_ID="contract-project"
S3_CONFIG="$WORK/seaweedfs-s3.json"

cat >"$S3_CONFIG" <<EOF
{
  "identities": [
    {
      "name": "langfuse",
      "credentials": [
        { "accessKey": "${S3_ACCESS_KEY}", "secretKey": "${S3_SECRET_KEY}" }
      ],
      "actions": ["Admin", "Read", "Write", "List", "Tagging"]
    }
  ]
}
EOF

cat >"$ENV_FILE" <<EOF
TRACING_CONTRACT_POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
TRACING_CONTRACT_REDIS_PASSWORD=${REDIS_PASSWORD}
TRACING_CONTRACT_CLICKHOUSE_PASSWORD=${CLICKHOUSE_PASSWORD}
TRACING_CONTRACT_CLICKHOUSE_PORT=${CLICKHOUSE_PORT}
TRACING_CONTRACT_SALT=${SALT}
TRACING_CONTRACT_NEXTAUTH_SECRET=${NEXTAUTH_SECRET}
TRACING_CONTRACT_ENCRYPTION_KEY=${ENCRYPTION_KEY}
TRACING_CONTRACT_LANGFUSE_PORT=${WEB_PORT}
TRACING_CONTRACT_LITELLM_PORT=${LITELLM_PORT}
TRACING_CONTRACT_S3_PORT=${S3_PORT}
TRACING_CONTRACT_S3_CONFIG=${S3_CONFIG}
TRACING_CONTRACT_S3_ACCESS_KEY=${S3_ACCESS_KEY}
TRACING_CONTRACT_S3_SECRET_KEY=${S3_SECRET_KEY}
TRACING_CONTRACT_MOCK_API_KEY=${MOCK_API_KEY}
TRACING_CONTRACT_MASTER_KEY=${MASTER_KEY}
TRACING_CONTRACT_ORG_ID=${ORG_ID}
TRACING_CONTRACT_PROJECT_ID=${PROJECT_ID}
TRACING_CONTRACT_LANGFUSE_PUBLIC_KEY=${PUBLIC_KEY}
TRACING_CONTRACT_LANGFUSE_SECRET_KEY=${SECRET_KEY}
TRACING_CONTRACT_USER_PASSWORD=${USER_PASSWORD}
EOF
chmod 600 "$ENV_FILE" "$S3_CONFIG"

# --- the stack ---------------------------------------------------------------
# The stub model provider is a service in the compose network (see
# stub-provider.py): it publishes nothing, and the completion has to travel
# through the gateway.
compose() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" -p "$PROJECT" "$@"; }

cleanup() {
  local rc=$?
  if [ "$KEEP" = "0" ]; then
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    rm -rf "$WORK"
  else
    log "kept the stack and $WORK (--keep)"
  fi
  exit "$rc"
}
trap cleanup EXIT

# --- 1. bring the stack up ----------------------------------------------------
log "1. starting the contract stack (langfuse 4.49.0 events_only + clickhouse + litellm 1.103.2)"
compose up -d 2>&1 | sed 's/^/[tracing-contract] compose: /'

wait_http() { # url timeout_sec
  local url="$1" deadline=$(( $(date +%s) + $2 ))
  local out
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if out="$(curl -fsS -m 10 "$url" 2>/dev/null)"; then
      printf '%s' "$out"
      return 0
    fi
    sleep 3
  done
  return 1
}

wait_clickhouse() {
  local deadline=$(( $(date +%s) + UP_TIMEOUT ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -fsS -m 10 -H "X-ClickHouse-User: langfuse" -H "X-ClickHouse-Key: ${CLICKHOUSE_PASSWORD}" \
      "http://127.0.0.1:${CLICKHOUSE_PORT}/ping" >/dev/null 2>&1; then
      return 0
    fi
    sleep 3
  done
  return 1
}

wait_clickhouse || fail "ClickHouse did not answer on 127.0.0.1:${CLICKHOUSE_PORT} within ${UP_TIMEOUT}s"

HEALTH="$(wait_http "http://127.0.0.1:${WEB_PORT}/api/public/health" "$UP_TIMEOUT" || true)"
case "$HEALTH" in
  *'"status":"OK"'*|*'"status":"ok"'*|*'"status":"Ok"'*) ;;
  *) fail "langfuse-web health did not report status=ok within ${UP_TIMEOUT}s: ${HEALTH:-<no answer>}" ;;
esac
# The contract is about the v4 write mode (`events_only`), so the version is
# part of the proof: a v3 server would accept the legacy ingestion path.
LANGFUSE_VERSION="$(printf '%s' "$HEALTH" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
[ -n "$LANGFUSE_VERSION" ] || fail "the Langfuse health route answered without a version: $HEALTH"
case "$LANGFUSE_VERSION" in
  4.*) ;;
  *) fail "the tracing contract requires Langfuse v4, the server answered ${LANGFUSE_VERSION}" ;;
esac
log "1. stack up: langfuse-web healthy (v${LANGFUSE_VERSION}), clickhouse answering"

# The headless initialization creates the org, the project and the key pair on
# startup; until the project answers, the completion below would be rejected
# with an authentication error rather than measured.
AUTH_HEADER="Authorization: Basic $(printf '%s:%s' "$PUBLIC_KEY" "$SECRET_KEY" | base64 | tr -d '\n')"
PROJECT_READY=""
deadline=$(( $(date +%s) + UP_TIMEOUT ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if curl -fsS -m 10 -H "$AUTH_HEADER" "http://127.0.0.1:${WEB_PORT}/api/public/projects" \
    | grep -q "$PROJECT_ID"; then
    PROJECT_READY=1
    break
  fi
  sleep 3
done
[ -n "$PROJECT_READY" ] || fail "the initialized project ${PROJECT_ID} did not answer within ${UP_TIMEOUT}s"

# Langfuse uploads raw events to blob storage; the bucket must exist before the
# first event is accepted.
bucket_ready=""
deadline=$(( $(date +%s) + 120 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 10 -X PUT "http://127.0.0.1:${S3_PORT}/langfuse" || echo 000)"
  if [ "$code" = "200" ] || [ "$code" = "409" ]; then
    bucket_ready=1
    break
  fi
  if compose exec -T seaweedfs weed shell -master=127.0.0.1:9333 <<<'s3.bucket.create -name langfuse' >/dev/null 2>&1; then
    bucket_ready=1
    break
  fi
  sleep 3
done
[ -n "$bucket_ready" ] || fail "the langfuse bucket was not created in seaweedfs"

LITELLM_BASE="http://127.0.0.1:${LITELLM_PORT}"
deadline=$(( $(date +%s) + UP_TIMEOUT ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if curl -fsS -m 10 "${LITELLM_BASE}/health/liveliness" >/dev/null 2>&1; then
    break
  fi
  sleep 3
done
curl -fsS -m 10 "${LITELLM_BASE}/health/liveliness" >/dev/null 2>&1 \
  || fail "the gateway did not become live within ${UP_TIMEOUT}s"

# --- 2. ONE completion --------------------------------------------------------
log "2. sending ONE chat completion to the gateway"
GATEWAY_AUTH="Authorization: Bearer ${MASTER_KEY}"
RC="$(curl -s -m 60 -o "$WORK/completion.json" -w '%{http_code}' -X POST \
  "${LITELLM_BASE}/v1/chat/completions" \
  -H 'Content-Type: application/json' -H "$GATEWAY_AUTH" \
  -d '{"model":"tracing-contract","messages":[{"role":"user","content":"tracing contract check"}]}' || echo 000)"
[ "$RC" = "200" ] || fail "the completion returned $RC (expected 200): $(head -c 400 "$WORK/completion.json" 2>/dev/null)"
grep -qE '"object"[[:space:]]*:[[:space:]]*"chat\.completion"' "$WORK/completion.json" \
  || fail "the completion response is not a chat completion: $(head -c 400 "$WORK/completion.json")"
log "2. one completion accepted (HTTP 200, chat.completion)"

# --- 3. exactly one trace / one model call in ClickHouse ---------------------
# What ONE completion produces, verified live on v4: one Langfuse trace whose
# root is a SPAN and exactly one GENERATION observation (the model call). The
# contract is that shape, not "at least one event": a second exporter, a second
# callback or a duplicated ingestion would show up as a second trace, a second
# GENERATION or extra rows.
read_counts() { # -> rows<TAB>traces<TAB>generations
  curl -fsS -m 15 -H "X-ClickHouse-User: langfuse" -H "X-ClickHouse-Key: ${CLICKHOUSE_PASSWORD}" \
    --data-binary "SELECT count(), uniqExact(trace_id), countIf(type = 'GENERATION') FROM events_core FORMAT TSV" \
    "http://127.0.0.1:${CLICKHOUSE_PORT}/?database=langfuse" 2>/dev/null | tr -d ' \r'
}

COUNTS=""
deadline=$(( $(date +%s) + EVENT_TIMEOUT ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  COUNTS="$(read_counts || true)"
  case "$COUNTS" in
    ""|0*$'\t'*) sleep 5 ;;
    *) break ;;
  esac
done
case "$COUNTS" in
  ""|0*) fail "no OTEL event reached ClickHouse events_core within ${EVENT_TIMEOUT}s (the completion did not ship a trace)" ;;
esac

# Let the ingestion pipeline drain before the counts are called final.
sleep 15
COUNTS="$(read_counts || true)"
case "$COUNTS" in
  ""|0*) fail "events_core could not be read after the settle window: '${COUNTS}'" ;;
esac
IFS=$'\t' read -r ROWS TRACES GENERATIONS <<<"$COUNTS"
if [ -z "${ROWS:-}" ] || [ -z "${TRACES:-}" ] || [ -z "${GENERATIONS:-}" ]; then
  fail "unexpected events_core counts: '${COUNTS}'"
fi
[ "$TRACES" = "1" ] || fail "expected exactly ONE OTEL trace for the ONE completion, found ${TRACES} traces (rows=${ROWS})"
[ "$GENERATIONS" = "1" ] || fail "expected exactly ONE model-call observation (GENERATION) for the ONE completion, found ${GENERATIONS} (rows=${ROWS})"
# rows = the trace's root SPAN + the one GENERATION: the observed shape of one
# completion on this Langfuse version. More rows mean a second span or a second
# exporter shipped along, which is exactly the regression class.
[ "$ROWS" = "2" ] || fail "expected exactly 2 rows in events_core (one root SPAN + one GENERATION), found ${ROWS}"
log "3. exactly ONE OTEL trace (1 root SPAN + 1 GENERATION) in events_core for the one completion (rows=${ROWS} traces=${TRACES} generations=${GENERATIONS})"

# --- 4. zero ingestion rejections --------------------------------------------
REJECTIONS="$(compose logs --no-color langfuse-web langfuse-worker 2>&1 \
  | grep -icE 'rejected|bad request' || true)"
[ "$REJECTIONS" = "0" ] || {
  compose logs --no-color langfuse-web langfuse-worker 2>&1 | grep -iE 'rejected|bad request' | head -5
  fail "the langfuse logs carry ${REJECTIONS} ingestion rejection line(s) (expected 0)"
}
GATEWAY_ERRORS="$(compose logs --no-color litellm 2>&1 \
  | grep -icE 'api errors occurred|bad request' || true)"
[ "$GATEWAY_ERRORS" = "0" ] || fail "the gateway log carries ${GATEWAY_ERRORS} 'API errors occurred'/'Bad request' line(s) (expected 0)"
log "4. zero ingestion rejections (langfuse 0, gateway 0)"

# --- 5. same evidence from the other side: the events are OTLP ----------------
# `source` is set by the Langfuse ingestion path: 'otel' for anything that
# arrived over the OTLP route, and a legacy value for /api/public/ingestion
# (the route v4 rejects, and the route a stray legacy `langfuse` callback
# posts to). Every row must be 'otel', one project key must cover them, and the
# service that produced them must be the gateway.
read_source() { # -> otel<TAB>non-otel<TAB>keys<TAB>litellm
  curl -fsS -m 15 -H "X-ClickHouse-User: langfuse" -H "X-ClickHouse-Key: ${CLICKHOUSE_PASSWORD}" \
    --data-binary "SELECT countIf(source = 'otel'), countIf(source != 'otel'), uniqExact(ingestion_api_key), countIf(service_name = 'litellm') FROM events_core FORMAT TSV" \
    "http://127.0.0.1:${CLICKHOUSE_PORT}/?database=langfuse" 2>/dev/null | tr -d ' \r'
}
SOURCE="$(read_source || true)"
[ -n "$SOURCE" ] || fail "the events_core source breakdown could not be read"
IFS=$'\t' read -r OTLP_ROWS NON_OTLP_ROWS INGESTION_KEYS LITELLM_ROWS <<<"$SOURCE"
[ "$NON_OTLP_ROWS" = "0" ] || fail "${NON_OTLP_ROWS} row(s) did not arrive over OTLP (source != 'otel'): the legacy /api/public/ingestion path shipped events"
[ "$OTLP_ROWS" = "$ROWS" ] || fail "only ${OTLP_ROWS} of ${ROWS} rows arrived over OTLP"
[ "$INGESTION_KEYS" = "1" ] || fail "expected the rows to carry exactly ONE project key, found ${INGESTION_KEYS}"
[ "$LITELLM_ROWS" = "$ROWS" ] || fail "only ${LITELLM_ROWS} of ${ROWS} rows carry service_name=litellm: the gateway identity is missing"
log "5. every event arrived over OTLP (source=otel, one project key, service_name=litellm); the legacy ingestion path shipped nothing"

log "tracing contract check passed: 1 completion -> 1 OTEL trace (1 SPAN + 1 GENERATION), 0 ingestion rejections"
