# Image generation MCP service for container bots

Bot images carry no image-generation client. Instead, one MCP service exposes a single
`generate_image` tool and calls the model gateway (`/v1/images/generations`, OpenAI-compatible)
on the bot's behalf. Code — `tools/image-mcp/`; the image is built by
`.github/workflows/myrmidon-image-mcp.yml`.

```
bot ──MCP/HTTP──▶ image-mcp ──HTTP──▶ model gateway  /v1/images/generations
  network myrmidon-bots      │                    (base URL and model allow-list from settings)
                             └─ per-bot store: generated images, 48 h TTL, quota per bot
```

## Tools

| Tool | What it does |
|---|---|
| `generate_image` | prompt, model (allow-list), size (allow-list), n (1..4), optional negative_prompt; returns the produced files |
| `file_get` | one stored image as base64 (small files) |
| `file_list` | your images with sizes, the remaining quota and the remaining daily budget |
| `file_delete` | delete one of your images |

`generate_image` makes one upstream attempt. On `upstream_error` the bot retries; the service does
not retry, so a bot is never charged twice for one call. A failed call spends no budget.

Every failure carries a stable code that the bot branches on:

| Code | Meaning |
|---|---|
| `image_disabled` | the tool is not enabled for this bot, or its daily budget is zero |
| `invalid_prompt` | prompt missing, empty or longer than the limit |
| `invalid_model` | the model is not in the service allow-list |
| `invalid_size` | the size is not in the service allow-list |
| `invalid_n` | n is outside 1..4 |
| `budget_exceeded` | the daily generation budget is used up; the message carries the remainder |
| `upstream_error` | the gateway was unreachable or answered with an error |
| `document_too_large` | a generated image is larger than the per-file limit |
| `quota_exceeded` | the bot's storage quota is full; delete files with `file_delete` |

## Result format

```json
{"files": [{"file_id": "…", "name": "image-1.png", "bytes": 123456,
            "content_type": "image/png", "sha256": "…", "download": "/v1/files/…",
            "base64": "…"}],
 "model": "…", "n": 1, "request_id": "…"}
```

`base64` is present for files up to `IMAGE_MAX_INLINE_RESULT_BYTES` (4 MiB by default). A larger
file gets `inline_skipped` instead and is downloaded with
`curl -o out.png "http://image-mcp:8080/v1/files/<file_id>"` (same authentication as the MCP call).
The gateway may answer with `data[].b64_json` or with `data[].url`; both are supported, and a link
is downloaded by the service.

## Bot authentication

`config/bots.json` (sample — `tools/image-mcp/config.example.json`), the key is the bot name:

- `peer_host`: the bot container's name on the Docker network (`myrmidon-bot-<botKey>`). The facade
  compares it with the source address. This works with the shared `MYRMIDON_BOT_MCP_SERVERS` entry
  that sets `"noAuth": true`. Bots must call the name `image-mcp` inside the bots network: the host
  gateway address or a published port hides the source, and the bots become indistinguishable.
- `token_sha256`: the bot's own bearer (only the hash is stored). The shared entry gives every bot
  one token, so a personal token needs a separate entry per bot. Set it together with `peer_host`
  and both conditions must hold.
- `tools`: which tools the bot may call; `quota_bytes`, `rate_per_min`: its own limits.
- `generations_per_day`: the daily generation budget, reset at UTC midnight. `0` disables generation
  for the bot. When the field is absent, `IMAGE_GENERATIONS_PER_DAY` applies. One image counts as
  one generation, so an `n`-image call spends `n`.

## Limits

- Per bot: storage quota 2 GiB (`IMAGE_BOT_QUOTA_BYTES`), 48 h retention (`IMAGE_FILE_TTL_HOURS`),
  `rate_per_min` requests a minute.
- One generated image: at most 32 MiB (`IMAGE_MAX_FILE_BYTES`).
- Inline base64 in a result: at most 4 MiB (`IMAGE_MAX_INLINE_RESULT_BYTES`); the MCP request body
  is at most 24 MiB (`IMAGE_MAX_REQUEST_BYTES`).
- Prompt and negative prompt: at most 2000 characters (`IMAGE_MAX_PROMPT_CHARS`); `n`: 1..4
  (`IMAGE_MAX_IMAGES_PER_CALL`).
- Upstream timeout: 120 s (`IMAGE_UPSTREAM_TIMEOUT_S`).
- All bots together: `IMAGE_SPOOL_MAX_BYTES` (32 GiB by default) and `IMAGE_SPOOL_MIN_FREE_BYTES`
  (2 GiB free on the spool filesystem). The second limit works only when the spool is on its own
  size-limited filesystem, not on the host root disk (see Deploy).

## Deploy

1. Image: `ghcr.io/itkadr-git/myrmidon-image-mcp` (tags `main`, `sha-…`, `X.Y.Z`).
2. Create `config/bots.json` and `secrets/gateway_token` (the model-gateway key). The `spool` volume
   is named: the image creates `/spool` owned by uid 10001 and Docker copies the owner on first use,
   so nothing must be prepared. If the volume is bound to a host directory (`driver_opts`), give that
   directory to `chown 10001:10001`. A volume without a size limit can fill the disk: put the spool
   on its own size-limited filesystem and keep `IMAGE_SPOOL_MAX_BYTES` below its size.
3. Set `IMAGE_GATEWAY_BASE_URL` and `IMAGE_MODELS` in the environment, then
   `docker compose -f tools/image-mcp/compose.example.yml up -d` (the `myrmidon-bots` network exists).
4. Acceptance: `generate_image` with each allow-listed model returns a file; an unlisted model gives
   `invalid_model`; a second call past `generations_per_day` gives `budget_exceeded`; bot B cannot
   open a file of bot A (404); a request over `rate_per_min` gets 429.
5. Add `{"name":"image","url":"http://image-mcp:8080/mcp","noAuth":true}` to
   `MYRMIDON_BOT_MCP_SERVERS` (this restarts the bot containers).

Memory limits in the compose file: the facade 512 MiB, 1 CPU.

## Isolation notes (what the service does not promise)

- The gateway key is read from the environment variable named by `IMAGE_GATEWAY_TOKEN` (or the file
  named by `IMAGE_GATEWAY_TOKEN_FILE`). It is never stored in the configuration or in a tool result.
- The `Authorization` header goes only to `IMAGE_GATEWAY_BASE_URL`. A linked image (`data[].url`) is
  downloaded without it, because that URL is not the gateway contract and may point to another host.
- Access to the MCP address is checked by the `Host` header (`IMAGE_ALLOWED_HOSTS`, by default
  `image-mcp,image-mcp:8080`). If bots use another name, add it.
- Every bot has its own directory and its file ids are validated, so a bot cannot open another bot's
  file.

## Service settings

Environment variables of the service (not of the board): `IMAGE_BOTS_FILE`, `IMAGE_DATA_DIR`,
`IMAGE_LISTEN_HOST`, `IMAGE_LISTEN_PORT`, `IMAGE_ALLOWED_HOSTS`, `IMAGE_GATEWAY_BASE_URL`,
`IMAGE_GATEWAY_TOKEN`/`IMAGE_GATEWAY_TOKEN_FILE`, `IMAGE_MODELS`, `IMAGE_SIZES`,
`IMAGE_MAX_PROMPT_CHARS`, `IMAGE_MAX_IMAGES_PER_CALL`, `IMAGE_GENERATIONS_PER_DAY`,
`IMAGE_MAX_REQUEST_BYTES`, `IMAGE_MAX_INLINE_RESULT_BYTES`, `IMAGE_MAX_FILE_BYTES`,
`IMAGE_BOT_QUOTA_BYTES`, `IMAGE_SPOOL_MAX_BYTES`, `IMAGE_SPOOL_MIN_FREE_BYTES`,
`IMAGE_FILE_TTL_HOURS`, `IMAGE_RATE_PER_MIN`, `IMAGE_UPSTREAM_TIMEOUT_S`.
No vendor file is touched, so there are no `SETTINGS.md` and `DIVERGENCE.md` rows.