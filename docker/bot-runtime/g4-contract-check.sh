#!/usr/bin/env bash
# myrmidon(G4): contract check for the myrmidon-hermes image (hermes gateway
# adapter parity). Runs against a CONTAINER BUILT FROM THE SAME COMMIT, not
# against stubs: the caller (myrmidon-bot-image.yml) has just built
# myrmidon-hermes:pr-check from this pull request's tree and passes the image
# tag as $1. Everything the hermes_gateway adapter relies on (G4) is exercised
# over the real gateway HTTP API of the image's own hermes version:
#
#   1. health + auth gates: /health is open, a wrong bearer is rejected, and
#      stopping an unknown run is a clean 404 (the shape the adapter's stop
#      path must tolerate).
#   2. Idempotency-Key: same key + same body replays the SAME run_id with
#      replayed:true; the same key with a different body conflicts. This is
#      the property L1 (infra-interrupt relief) was gated on.
#   3. /stop on a live run: a run pinned to a local mock provider streams for
#      a long time, POST .../stop flips it to stopping and then cancelled,
#      with the run.cancelled terminal event on the SSE stream.
#   4. approval gate: POST .../approval on a run with no pending approval is
#      a 409 (the adapter's auto-deny posts there).
#   5. MYRMIDON_BOT_YOLO env switch: 1 (default) exports HERMES_YOLO_MODE=1 to
#      the gateway process (dangerous-command approvals bypassed); 0 leaves it
#      unset so approvals follow the profile's config.yaml.
#
# No secrets: the API server key is generated here, used only in headers/env
# of this run, and never printed. The mock provider never leaves loopback.
set -euo pipefail

IMAGE="${1:?usage: g4-contract-check.sh <image> [port]}"
PORT="${2:-38642}"
MOCK_PORT=$((PORT + 1))
CONTAINER="g4-contract-check-$$"
MOCK_PID=""
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# The workdir must be on a filesystem the Docker daemon can see bind-mounted:
# a private tmpfs namespace (sandboxed shells) is invisible to dockerd even
# though it looks local, so skip /tmp entirely and prefer G4_CHECK_WORKDIR,
# then the caller's cwd, then the repository root's parent. No secrets beyond
# a random test key.
pick_workdir() {
  local candidate
  for candidate in "${G4_CHECK_WORKDIR:-}" "$PWD" "$(dirname "$ROOT")" "/srv/dev"; do
    [ -n "$candidate" ] || continue
    case "${candidate%/}" in /tmp|/tmp/*) continue ;; esac
    if [ -d "$candidate" ] && [ -w "$candidate" ]; then
      mktemp -d "${candidate%/}/g4-contract-check.XXXXXX" && return 0
    fi
  done
  echo "" # no daemon-visible workdir found; caller decides
  return 1
}
WORK="$(pick_workdir)" || fail "no daemon-visible workdir found (set G4_CHECK_WORKDIR)"
GATEWAY="http://127.0.0.1:${PORT}"

log()  { echo "[g4-contract-check] $*"; }
fail() { echo "[g4-contract-check] ERROR: $*" >&2; exit 1; }

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  if [ -n "$MOCK_PID" ]; then kill "$MOCK_PID" >/dev/null 2>&1 || true; fi
  # The gateway writes its state back into the bind mount as uid 10001, which
  # the invoking user may not be able to delete; the image itself (root) can.
  docker run --rm --user root --entrypoint sh -v "$WORK":/w "$IMAGE" \
    -c 'rm -rf /w/*' >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# --- local mock provider (chat.completions that streams forever) ------------
# The stop test needs a run that STAYS running: any real provider would answer
# too fast. This tiny stdlib-only server streams one chunk per second, so the
# run is alive until /stop interrupts it. It listens on loopback only and is
# reached from the container through host.docker.internal.
cat > "$WORK/mock_server.py" <<'PYEOF'
import http.server, json, time

class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass
    def do_POST(self):
        n = int(self.headers.get('Content-Length', 0))
        self.rfile.read(n)
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        for _ in range(1800):
            chunk = {"id": "chatcmpl-1", "object": "chat.completion.chunk",
                     "choices": [{"index": 0, "delta": {"content": "x"}}]}
            self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
            self.wfile.flush()
            time.sleep(1)
        self.wfile.write(b"data: [DONE]\n\n")

http.server.ThreadingHTTPServer(('127.0.0.1', ${MOCK_PORT}), H).serve_forever()
PYEOF
sed -i "s/\${MOCK_PORT}/${MOCK_PORT}/" "$WORK/mock_server.py"
python3 "$WORK/mock_server.py" &
MOCK_PID=$!

# --- container profile: key via ${HERMES_HOME}/.env (bot-runtime contract) ---
mkdir -p "$WORK/hermes-home"
API_KEY="$(openssl rand -hex 32)"
printf 'API_SERVER_KEY="%s"\nOPENAI_API_KEY="mock-not-a-secret"\n' "$API_KEY" > "$WORK/hermes-home/.env"
cat > "$WORK/hermes-home/config.yaml" <<'YAMLEOF'
model:
  default: 'contract-check-model'
  provider: 'custom:mock'
custom_providers:
  - name: 'mock'
    base_url: 'http://host.docker.internal:MOCKPORT/v1'
    api_key_env: 'OPENAI_API_KEY'
command_allowlist:
- execute_code
YAMLEOF
sed -i "s/MOCKPORT/${MOCK_PORT}/" "$WORK/hermes-home/config.yaml"

# The bot-runtime contract requires HERMES_HOME (/data/hermes) to be owned (or
# at least writable) by the image's uid 10001. A CI runner can just chown; a
# sandboxed non-root shell cannot, and falls back to permissive modes on this
# throwaway directory — the only secret in it is the random test key above.
give_uid_10001() {
  local dir="$1"
  chown -R 10001:10001 "$dir" 2>/dev/null || {
    chmod a+rwx "$dir"
    chmod a+rw "$dir/.env" "$dir/config.yaml"
  }
}
give_uid_10001 "$WORK/hermes-home"

# uid 10001 must be able to write the mounted volumes (bot-runtime contract).
# /data itself is chowned to bot in the image; /data/hermes comes from the bind
# mount above; /workspace and /scratch are fresh tmpfs mounts, like the
# workflow's node-variant job uses.
run_gateway() {
  docker run -d --name "$CONTAINER" \
    -p "127.0.0.1:${PORT}:8642" \
    --add-host=host.docker.internal:host-gateway \
    --tmpfs /workspace:uid=10001,gid=10001 \
    --tmpfs /scratch:uid=10001,gid=10001 \
    -v "$WORK/hermes-home:/data/hermes" \
    -e "MYRMIDON_BOT_YOLO=${1:-1}" \
    "$IMAGE"
}

req() { # method path [body] [extra header] -> writes code to RC, body to BODY
  local method="$1" path="$2" body="${3:-}" extra="${4:-}"
  local args=(-s -m 30 -o "$WORK/resp.json" -w '%{http_code}' -X "$method" \
    -H 'Content-Type: application/json' -H "Authorization: Bearer ${API_KEY}" "$GATEWAY$path")
  if [ -n "$extra" ]; then args+=(-H "$extra"); fi
  if [ -n "$body" ]; then args+=(-d "$body"); fi
  RC="$(curl "${args[@]}" 2>/dev/null || echo 000)"
  BODY="$(cat "$WORK/resp.json" 2>/dev/null || true)"
}

wait_health() {
  local deadline=$(( $(date +%s) + 120 ))
  until curl -fsS -m 5 "$GATEWAY/health" >/dev/null 2>&1; do
    [ "$(date +%s)" -lt "$deadline" ] || fail "gateway health did not come up"
    sleep 2
  done
}

log "starting container from $IMAGE"
run_gateway 1
wait_health
log "gateway is up"

# --- 1. health + auth gates ---------------------------------------------------
req GET /health
[ "$RC" = 200 ] || fail "/health returned $RC (expected 200)"
command -v jq >/dev/null || fail "jq is required"
jq -e '.status == "ok"' <<<"$BODY" >/dev/null || fail "/health body: $BODY"
# A wrong bearer must be rejected: build the header via a variable so the
# literal never looks like a hardcoded credential to secret scanners
# (gitleaks' curl-auth-header rule matches any Authorization header on a
# curl line, even with an obviously bogus value).
WRONG_BEARER="Authorization: Bearer wrong-key"
RC="$(curl -s -m 10 -o /dev/null -w '%{http_code}' -H "$WRONG_BEARER" "$GATEWAY/v1/capabilities")"
[ "$RC" = 401 ] || fail "wrong bearer on /v1/capabilities returned $RC (expected 401)"
req POST /v1/runs/run_unknown_g4/stop '{}'
[ "$RC" = 404 ] || fail "stop of unknown run returned $RC (expected 404)"
log "1. health/auth gates ok (open /health, 401 wrong key, 404 unknown run)"

# --- 2. Idempotency-Key --------------------------------------------------------
req POST /v1/runs '{"input":"contract check","session_id":"g4-idem"}' "Idempotency-Key: g4-check-1"
[ "$RC" = 202 ] || fail "create returned $RC (expected 202): $BODY"
RUN_ID="$(jq -r '.run_id // empty' <<<"$BODY")"
[ -n "$RUN_ID" ] || fail "create response missing run_id: $BODY"
jq -e '.replayed == false' <<<"$BODY" >/dev/null || fail "first create not replayed=false: $BODY"
req POST /v1/runs '{"input":"contract check","session_id":"g4-idem"}' "Idempotency-Key: g4-check-1"
[ "$RC" = 202 ] || fail "replayed create returned $RC (expected 202): $BODY"
[ "$(jq -r '.run_id' <<<"$BODY")" = "$RUN_ID" ] || fail "replay returned a different run_id: $BODY"
jq -e '.replayed == true' <<<"$BODY" >/dev/null || fail "replay not flagged replayed=true: $BODY"
req POST /v1/runs '{"input":"DIFFERENT body","session_id":"g4-idem"}' "Idempotency-Key: g4-check-1"
[ "$RC" = 400 ] || [ "$RC" = 409 ] || fail "same key + different body returned $RC (expected 400 or 409): $BODY"
jq -e '.error.code == "idempotency_key_conflict"' <<<"$BODY" >/dev/null \
  || fail "conflict error code not idempotency_key_conflict: $BODY"
log "2. idempotency ok (same key replays run_id=$RUN_ID, different body conflicts)"

# --- 3. /stop on a live run ----------------------------------------------------
req POST /v1/runs '{"input":"stop me while streaming","session_id":"g4-stop"}' "Idempotency-Key: g4-check-stop"
[ "$RC" = 202 ] || fail "stop-test create returned $RC (expected 202): $BODY"
STOP_ID="$(jq -r '.run_id // empty' <<<"$BODY")"
# wait until the run is actually running (agent created, streaming from the mock)
deadline=$(( $(date +%s) + 60 ))
while true; do
  req GET "/v1/runs/$STOP_ID"
  [ "$RC" = 200 ] || fail "run status returned $RC"
  ST="$(jq -r '.status' <<<"$BODY")"
  [ "$ST" = "running" ] && break
  case "$ST" in queued|started) ;; *) fail "run reached '$ST' before it could be stopped: $BODY";; esac
  [ "$(date +%s)" -lt "$deadline" ] || fail "run never became running (last: $ST)"
  sleep 1
done
req POST "/v1/runs/$STOP_ID/stop" '{}'
[ "$RC" = 200 ] || fail "stop returned $RC (expected 200): $BODY"
jq -e '.status == "stopping" or .status == "cancelled"' <<<"$BODY" >/dev/null \
  || fail "stop response status unexpected: $BODY"
deadline=$(( $(date +%s) + 60 ))
while true; do
  req GET "/v1/runs/$STOP_ID"
  ST="$(jq -r '.status' <<<"$BODY")"
  case "$ST" in cancelled|canceled|stopped|interrupted) break;;
    failed) fail "run failed instead of stopping: $BODY";;
  esac
  [ "$(date +%s)" -lt "$deadline" ] || fail "run never reached a cancelled terminal status (last: $ST)"
  sleep 1
done
# the SSE stream must have carried the terminal event (header via a variable:
# gitleaks' curl-auth-header rule flags any literal Authorization header on a
# curl line, valid key or not)
AUTH_HEADER="Authorization: Bearer ${API_KEY}"
curl -s -m 10 -N -H "$AUTH_HEADER" "$GATEWAY/v1/runs/$STOP_ID/events" \
  > "$WORK/sse.txt" || true
grep -q "run.cancelled" "$WORK/sse.txt" || fail "SSE stream missing run.cancelled: $(head -c 300 "$WORK/sse.txt")"
log "3. /stop ok ($STOP_ID: stopping → $ST, SSE carried run.cancelled)"

# --- 4. approval gate ----------------------------------------------------------
req POST "/v1/runs/$STOP_ID/approval" '{"choice":"deny"}'
[ "$RC" = 409 ] || fail "approval without a pending request returned $RC (expected 409): $BODY"
log "4. approval gate ok (409 when nothing pending)"

# --- 5. MYRMIDON_BOT_YOLO switch ----------------------------------------------
# The running gateway was started with the default (1): HERMES_YOLO_MODE=1 must
# be in the gateway process env. The default is the fleet's posture (no attended
# operator); 0 must leave it unset (approvals follow config.yaml).
docker exec "$CONTAINER" sh -c \
  'found=0; for p in /proc/[0-9]*/cmdline; do tr "\0" " " < "$p" 2>/dev/null | grep -q "gateway run" || continue; tr "\0" "\n" < "${p%/cmdline}/environ" 2>/dev/null | grep -q "^HERMES_YOLO_MODE=1$" && found=1; done; [ "$found" = 1 ]' \
  || fail "MYRMIDON_BOT_YOLO=1 did not export HERMES_YOLO_MODE=1 to the gateway process"
log "5a. MYRMIDON_BOT_YOLO=1 -> HERMES_YOLO_MODE=1 in the gateway process env"

docker rm -f "$CONTAINER" >/dev/null
run_gateway 0
wait_health
docker exec "$CONTAINER" sh -c \
  'found=0; for p in /proc/[0-9]*/cmdline; do tr "\0" " " < "$p" 2>/dev/null | grep -q "gateway run" || continue; tr "\0" "\n" < "${p%/cmdline}/environ" 2>/dev/null | grep -q "^HERMES_YOLO_MODE=" && found=1; done; [ "$found" = 0 ]' \
  || fail "MYRMIDON_BOT_YOLO=0 must not set HERMES_YOLO_MODE"
log "5b. MYRMIDON_BOT_YOLO=0 -> HERMES_YOLO_MODE unset (approvals follow config.yaml)"

log "G4 contract check passed for $IMAGE"
