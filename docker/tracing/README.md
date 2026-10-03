# Tracing contract check (TRACING-HEALTH)

`tracing-contract-check.sh` is the live contract test for the LLM tracing path.
It starts `docker-compose.contract.yml` (LiteLLM + Langfuse v4 + ClickHouse +
Postgres/Redis/S3-compatible store), sends exactly ONE chat completion through
the gateway and then asserts:

1. the stack comes up (Langfuse web healthy, ClickHouse answering);
2. the gateway accepts the completion (HTTP 200, `chat.completion`);
3. **exactly ONE** Langfuse trace for that one completion, carrying exactly
   **one** model call: one root `SPAN` + one `GENERATION` row in ClickHouse
   `events_core` (2 rows, 1 trace) — not "at least one event", and the counts
   must not grow after the ingestion settles;
4. **zero ingestion rejections**: no `Rejected`/`Bad request` line in the
   Langfuse logs and no `API errors occurred` burst in the gateway log;
5. the same fact from the other side: every row in `events_core` arrived over
   OTLP (`source = 'otel'`, one project key, `service_name = 'litellm'`), so
   nothing went through the legacy `/api/public/ingestion` path.

The counts are checked after the ingestion has settled, so a late duplicate
fails the run instead of hiding behind a snapshot.

## Why it has to be live

The 02.10 incident class was a tracing path that *looks* configured and ships
nothing. Langfuse v4 runs in the `events_only` write mode, where
`/api/public/ingestion` rejects the legacy trace/observation events that
LiteLLM keeps sending while the legacy `langfuse` callback is installed (~12k
"Bad request" per hour, gateway CPU, empty dashboard). A config check can only
see which callback is listed; only a started stack shows which endpoint the
events actually arrive on. The accepted callback list lives in one place,
`tracing_intended_callbacks()` in `scripts/myrmidon/deploy/lib.sh`, and
`litellm.config.yaml` here carries the same single-element list
(`langfuse_otel`).

## Running it

```sh
# local / CI, needs a reachable docker daemon and network for the image pulls
bash docker/tracing/tracing-contract-check.sh          # add --keep to inspect
```

The script generates every credential for the run (nothing in the repository
is a secret), publishes ports on loopback only, and removes the stack and its
volumes on the way out. The model provider is `stub-provider.py`, a stdlib
OpenAI-compatible stub that runs as an unpublished service in the compose
network, so the completion travels through the gateway and no provider is
contacted. `TRACING_CONTRACT_WORKDIR`, `TRACING_CONTRACT_PORT_BASE` and the two
timeout variables are the only knobs.

## In CI

`tracing-contract.myrmidon.test.mjs` runs the static assertions in the `checks`
job on every tier (script exists, executable, `bash -n` clean, every image in
the compose pinned to an exact `X.Y.Z` tag or a digest, loopback-only ports,
the OTLP-only callback list, the exact-one-event assertions). The live lane is
opt-in: it needs `TRACING_CONTRACT_LIVE=1` and a reachable docker daemon, and
without either it skips cleanly, like the G4 contract check. A dedicated
`tracing-contract` job in `.github/workflows/myrmidon-ci.yml` is what will run
it in CI; that job is not in the workflow yet, so the live lane currently runs
wherever the variable and a docker daemon are provided.

## Pinning

Every image in the compose carries an exact tag; `postgres` and `seaweedfs`
also carry a digest because their upstream tags have no third component. A
major or minor tag such as `langfuse/langfuse:4` is refused by the static guard
— the same rule `scripts/myrmidon/deploy/deploy.sh` applies to
`MYRMIDON_TRACING_LANGFUSE_IMAGE` / `MYRMIDON_TRACING_GATEWAY_IMAGE`.

Red proof of that guard (the pin assertion must be able to fail):

```sh
sed -i 's#langfuse/langfuse:4\.49\.0#langfuse/langfuse:4#' docker/tracing/docker-compose.contract.yml
node --test scripts/myrmidon/tracing/tracing-contract.myrmidon.test.mjs   # pin assertion fails
git checkout -- docker/tracing/docker-compose.contract.yml                 # restore, rerun green
```