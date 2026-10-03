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
| `generate_image(prompt, size, n, model?)` | text to image; the model, size and `n` (1..4) are validated against the model registry before any request leaves |
| `edit_image(image, instruction, mask?, model?)` | edit an image by instruction, optionally with a mask |

Models on the free key, pinned by the registry and its test
(`test_registry_covers_every_model_on_the_key`): `qwen-image-3.0` (the default
for generation), `qwen-image-3.0-pro`, `qwen-image-max`,
`qwen-image-edit-plus` (the default for editing), `qwen-image-edit-max`,
`wan2.7-image`, `wan2.7-image-pro`, `z-image-turbo`. Generation sizes are
`1024x1024`, `720x1280`, `1280x720` plus 1440-variants where the model supports
them; edit models take `1024x1024` and `n` is always 1.

Both tools use the async DashScope flow — submit, then poll the task until it
succeeds or fails — with a 300 s task ceiling. Stable error codes a caller can
branch on: `invalid_model`, `invalid_size`, `invalid_n`, `invalid_prompt`,
`key_unavailable`, `upstream_error`, `task_failed`, `task_timeout`.

## Results and audit

Files land in the calling session's directory under the shared workspace root:
`images/<session_id>/image-<ts>-<i>.png` with a `result.json` sidecar (prompt,
model, size, `n`, usage, cost 0.0 on the free key, per-file sha256 and bytes).
The audit trail is an append-only JSONL file in the workspace root; it records
event names and argument *sizes* only — never prompts, image bytes or key
material.

## Bringing the container up in the deploy window

The connector runs as its own container from the deployment repository's
compose fragment (`connectors/alibaba-image/docker-compose.alibaba-image.yml`),
on port `8083` (media tools use 8080, google-ai 8081/8082):

```sh
cd connectors/alibaba-image
docker compose -f docker-compose.alibaba-image.yml up -d
curl http://localhost:8083/tools   # must list generate_image and edit_image
```

Two mounts, both required:

- the DashScope key, from the board secret store, bind-mounted read-only at
  `/run/secrets/dashscope_key` (override with `ALI_MCP_KEY_FILE`); the key is
  read from the file on every call and never appears in the image, compose
  file or logs;
- the shared agent workspace root (the same root the bots' workspaces live
  under, e.g. `/srv/gai-workspaces`) into `/workspace`, so generated files land
  where the calling agent finds them.

The container needs outbound HTTPS to `https://dashscope-intl.aliyuncs.com`.
Service tuning knobs (all optional, `ALI_MCP_`-prefixed): `BASE_URL`,
`POLL_INTERVAL_S`, `TASK_TIMEOUT_S`, `MAX_PROMPT_CHARS`, `WORKSPACE_ROOT`,
`KEY_FILE`, `RESULT_DIR`.

## Connecting it to the bots

Register the running container as an external MCP server the way the runbook
describes — a private-network plain-HTTP endpoint is accepted because the
instance runs `PAPERCLIP_DEPLOYMENT_MODE=authenticated` with
`PAPERCLIP_DEPLOYMENT_EXPOSURE=private`; do not flip exposure to `public`
while the connector is connected. Then grant it to exactly the agents that
need image tools; per-agent grants default to deny, so an unlisted agent sees
nothing. In this deployment the grants are the design agents, the work
designer and the SMM bot; the shared "creative tools" registration is the
place those grants live.

For bots in containers the connector can also be wired as a shared
`MYRMIDON_BOT_MCP_SERVERS` entry the way media tools are — see
[../media-tools.md](../media-tools.md); the container name
`alibaba-image-mcp` must be reachable from the bots network by that name.

## What this deployment must check before going live

- The key file answers and is non-empty (a missing or empty file makes every
  tool call fail with `key_unavailable` before any request leaves).
- One live smoke per model family — one generation on `qwen-image-3.0`, one on
  `wan2.7-image`, one on `z-image-turbo`, and one edit on
  `qwen-image-edit-plus`; acceptance: a granted agent generates an image,
  edits it, and the files land in its workspace.
- The connector container is on a network the board server can resolve and
  reach; the workspace mount points at the same root the bots use.

## Related

- [external-mcp-connectors.md](external-mcp-connectors.md) — the connect and
  grant runbook this connector follows.
- [../media-tools.md](../media-tools.md) — the media tools MCP service, the
  pattern for a connector container shared with bot containers.
