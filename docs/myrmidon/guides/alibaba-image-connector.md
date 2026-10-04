# alibaba-image connector: free image generation and editing for agents

> Russian version: [alibaba-image-connector.ru.md](alibaba-image-connector.ru.md)

The alibaba-image connector gives agents image generation and editing through
the company's free Alibaba DashScope key, next to the other connector
containers (media tools, google-ai). The connector is deployment-specific: its
code, image and compose fragment live in the private deployment repository
under `connectors/alibaba-image/`, and this guide covers the operational side
— bringing the container up in the deploy window and connecting it to the
bots. The connect/grant flow reuses the vendor's external-MCP surface
described in [external-mcp-connectors.md](external-mcp-connectors.md).

## What the bots get

| Tool | What it does |
| --- | --- |
| `generate_image(prompt, size, n, model, workspace_dir, agent_id)` | text to image; model, size and `n` are validated against the model registry before any request leaves |
| `edit_image(image, instruction, mask, model, size, n, workspace_dir, agent_id)` | edit one image or fuse up to three input images by instruction |

Models on the free key, pinned by the registry and its test
(`test_registry_covers_every_model_on_the_key`): `qwen-image-3.0` (the default
for generation), `qwen-image-3.0-pro`, `qwen-image-max`,
`qwen-image-edit-plus` (the default for editing), `qwen-image-edit-max`,
`wan2.7-image`, `wan2.7-image-pro`, `z-image-turbo`. The Qwen-Image and
Qwen-Image Edit models accept `n` 1–6 (`n>1` is the variations mode); the Wan
and Z-Image families accept 1–4; `ALI_IMAGE_MAX_IMAGES` caps the effective
ceiling deployment-wide (default 6). Sizes are free-form `width*height`
(with an asterisk as the separator, e.g. `1024*1024`) within per-model bounds
— 512–2048 per side for Qwen and Z-Image, 768–2048 for Wan; the Wan family
also accepts the `1K`/`2K`/`4K` shorthand. `edit_image` accepts `mask` for
interface parity, but DashScope image editing has no mask parameter: the
result carries `mask_note` saying the mask was ignored, never silently
dropped. Upscale is not offered by the DashScope image API, so no `upscale`
tool is published.

Both tools use the async DashScope flow — submit, then poll the task until it
succeeds or fails — with a 300 s task poll deadline. Failures surface as
DashScope's own machine codes with a connector-supplied friendly message
(`InvalidApiKey`, `AuthenticationError`, `Arrearage`, `Throttling`,
`ModelNotExist`, `DataInspectionFailed`, `IPInfringementSuspect`,
`InvalidParameter`, …); local validation failures report `invalid_request`,
and a missing key raises `SecretMissing` with a message that names only the
key's configured locations, never a value.

## Results and audit

Every image is written to the caller's workspace as
`<model>-<utc-timestamp>-<i>.png`, with one `<model>-<utc-timestamp>.json`
sidecar per call recording tool, agent, model, prompt/instruction, size, `n`,
request id, the DashScope `usage` block and cost metadata. Cost stays honest:
without a price entry in `ALI_IMAGE_PRICES` the estimate is
`estimated_cost_usd: null` with `pricing_source: "unset"` — the connector
never invents a price. The audit trail is an append-only JSONL file (one line
per tool call with agent id, argument *sizes*, status and latency) — never
prompt or instruction content, never key material.

## Bringing the container up in the deploy window

The connector runs as its own container from the deployment repository's
compose fragment (`connectors/alibaba-image/docker-compose.alibaba-image.yml`),
merged into the board's deployment compose; it listens on `0.0.0.0:8083`
inside the container, published to the host at `127.0.0.1:8083`:

```sh
docker compose -f connectors/alibaba-image/docker-compose.alibaba-image.yml up -d
```

The smoke probe is the streamable-HTTP endpoint (`/mcp`, JSON-RPC
`tools/list`), not a `/tools` URL; the deployment repo's live-smoke section
has the exact `tools/call` payloads per model family.

Two mounts and one volume:

- the DashScope key, from the board secret store, bind-mounted read-only at
  `/run/secrets/dashscope_api_key` (readable by uid 1000; override the source
  with `ALI_IMAGE_KEY_FILE` in the compose environment and the in-container
  path with `ALI_IMAGE_API_KEY_FILE`); the key is read on every call — the
  mounted file first, the `DASHSCOPE_API_KEY` environment variable second —
  so a rotated board secret is picked up without a restart, and it never
  appears in the image, compose file, logs or tool output;
- the shared agent workspace root (the same root the bots' workspaces live
  under; the compose default is `/srv/ali-image-workspaces`, overridden by
  `ALI_IMAGE_WORKSPACE_ROOT`) into `/workspace`, so generated files land where
  the calling agent finds them;
- a named `ali-image-data` volume at `/data` holds the JSONL audit log.

The container needs outbound HTTPS to the region endpoint —
`https://dashscope-intl.aliyuncs.com/api/v1` (Singapore, the default) or
`https://dashscope.aliyuncs.com/api/v1` (Beijing); the keys are not
interchangeable between regions, and the mounted key must match the
configured endpoint.

Service tuning knobs (all optional, `ALI_IMAGE_`-prefixed): `BASE_URL`,
`API_KEY_FILE`, `API_KEY_ENV`, `AUDIT_PATH`, `WORKSPACE_DIR`, `AGENT_ID`,
`DEFAULT_MODEL`, `REQUEST_TIMEOUT` (HTTP, default 600 s), `POLL_INTERVAL`
(default 5 s), `POLL_TIMEOUT` (default 300 s), `MAX_IMAGES`, `PRICES`,
`MCP_HOST`, `MCP_PORT`.

## Connecting it to the bots

Register the running container as an external MCP server the way the runbook
describes — one remote connection (`transport: mcp_remote`, endpoint
`http://alibaba-image-mcp:8083/`) on the board network; no credential is
entered at the board side, because the DashScope key lives in the connector's
own mounted secret. A private-network plain-HTTP endpoint is accepted because
the instance runs `PAPERCLIP_DEPLOYMENT_MODE=authenticated` with
`PAPERCLIP_DEPLOYMENT_EXPOSURE=private`; do not flip exposure to `public`
while the connector is connected. Then grant it to exactly the agents that
need image tools; per-agent grants default to deny, so an unlisted agent sees
nothing. In this deployment the grants are the work designer, the bbq SMM and
the designer agents; the shared "creative tools" registration is the place
those grants live.

For bots in containers the connector can also be wired as a shared
`MYRMIDON_BOT_MCP_SERVERS` entry the way media tools are — see
[../media-tools.md](../media-tools.md); the container name
`alibaba-image-mcp` must be reachable from the bots network by that name.

## What this deployment must check before going live

- The key file answers and is non-empty (a missing or empty key fails every
  call with `SecretMissing` before any request leaves).
- One live smoke per model family — one generation on `qwen-image-3.0`, one
  on `wan2.7-image-pro`, one on `z-image-turbo`, and one edit on
  `qwen-image-edit-plus`; acceptance: each call returns non-empty
  `image_paths` and a `metadata_path`, and the files exist under the agent's
  workspace with the matching `usage` block.
- The connector container is on a network the board server can resolve and
  reach; the workspace mount points at the same root the bots use.

## Related

- [external-mcp-connectors.md](external-mcp-connectors.md) — the connect and
  grant runbook this connector follows.
- [../media-tools.md](../media-tools.md) — the media tools MCP service, the
  pattern for a connector container shared with bot containers.
