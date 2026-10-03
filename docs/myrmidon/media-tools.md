# Shared media and office tools for container bots

> Russian version: [media-tools.ru.md](media-tools.ru.md)

The bot image carries no ffmpeg, LibreOffice, poppler or Tesseract. Instead of putting them
into every container, they live in separate services and the bot gets a single MCP address.
The code is in `tools/media-mcp/`; images are built by
`.github/workflows/myrmidon-media-tools.yml`.

```
bot ──MCP/HTTP──▶ media-mcp (facade) ──▶ media-worker  (ffmpeg, ffprobe, pdftoppm)
  myrmidon-bots network   │        ├──▶ gotenberg     (LibreOffice, Chromium; ready image pinned by digest)
                          │        └──▶ tika          (Tika full + Tesseract rus+eng)
                          └─ media-backend network: internal, no egress and no direct bot access
```

## Tools

| Tool | What it does |
|---|---|
| `file_put`, `file_get`, `file_list`, `file_delete` | the bot's private store (quota, retention) |
| `media_probe` | ffprobe: duration, streams, codecs |
| `audio_loudness` | EBU R128 loudness (LUFS, LRA, peak) |
| `ffmpeg_submit`, `job_status`, `job_cancel` | editing and transcoding via a queue; a spec with allowlists, not raw argv |
| `image_transform` | scale, crop, rotate, format (jpg/png/webp) |
| `pdf_to_images` | PDF pages to png/jpeg (poppler), up to 40 per call |
| `office_to_pdf` | docx/xlsx/pptx/odt/… to PDF (Gotenberg, LibreOffice) |
| `html_to_pdf` | an HTML string and local assets to PDF (Chromium without JavaScript, only own assets load) |
| `extract_text` | document text or image/scan OCR (Tika, Tesseract rus+eng) |
| `dwg_convert` | DWG/DXF → DXF, SVG, PDF (LibreDWG + ezdxf), see below |

The service runs no arbitrary node or shell scripts. Live pages are rendered by the browser
MCP; `html_to_pdf` has no URL mode.

## Files

- Small: base64 in the call (`{"base64": "...", "name": "a.docx"}` or `file_put`); request up
  to 24 MiB, inline result up to 4 MiB.
- Large: `curl -T video.mp4 "http://media-mcp:8080/v1/files?name=video.mp4"` and
  `curl -o out.mp4 "http://media-mcp:8080/v1/files/<file_id>"`, the identity check is the
  same as for the MCP call.
- Each bot has its own directory; a file id is checked and a foreign file cannot be opened.
  Per-bot quota 4 GiB, file up to 512 MiB, retention 48 h.
- Everything the bot keeps on disk counts against the quota: files, incomplete uploads and
  job directories (`jobs/<id>/in`, `out`). A job result is bounded by the quota remainder
  (both per file and across all job files); on overrun the job fails, `in/` and `out/` are
  deleted immediately, not on the retention deadline.
- The shared ceiling across all bots: `MEDIA_SPOOL_MAX_BYTES` (default 64 GiB) and
  `MEDIA_SPOOL_MIN_FREE_BYTES` (2 GiB free space on the spool filesystem); beyond that no
  new data is accepted. The second limit only works when the spool sits on its own
  size-bounded filesystem, not on the host's root disk (see «Deploying»).
- `extract_text` and `office_to_pdf` accept a file up to 64 MiB (`MEDIA_MAX_CONVERT_BYTES`);
  the file is streamed to the converter. A Tika answer is read only up to `max_chars`
  (`truncated: true`, `chars` is then a lower bound), a PDF from Gotenberg is streamed to a
  file and cut off at 128 MiB (`MEDIA_MAX_PDF_BYTES`) or at the quota remainder.

## DWG/DXF (dwg_convert)

`dwg_convert` brings back the host's dwg2dxf/dwg2SVG as a media-service tool (the bot image
has no CAD utilities; a separate bot image is forbidden by CONVENTIONS §8). Input is `.dwg`
or `.dxf`, output is DXF, SVG or PDF:

- `kind=dxf`: the DXF is written by LibreDWG (DWG input) or ezdxf (DXF input, version
  `dxf_version` R12…R2018, default R2010). Note: LibreDWG writes the DXF of the input's own
  revision (up to r2013), `dxf_version` applies to DXF input only.
- `kind=svg`: rendered by ezdxf (SVGBackend); `width`/`height` (default 1600×1200) is the
  page size.
- `kind=pdf`: rendered through SVG + LibreOffice, if the worker image has LibreOffice; the
  base image does not — the worker refuses honestly («ask for svg»), the PDF path is left
  for an image with LibreOffice.
- The result is a regular file in the bot's store (same quota and retention), with
  `inline=true` small files come back base64.
- The tool is synchronous (timeout 300 s); output limits are the same as for the worker's
  other jobs.

Post-deploy check: convert a test DWG to DXF and SVG, round-trip DXF→DXF with a version
change.

## Bot authentication

`config/bots.json` (the sample is `tools/media-mcp/config.example.json`), key = bot name:

- `peer_host`: the bot container's name in the docker network (`myrmidon-bot-<botKey>`);
  the facade checks the source address against it. Works with the shared
  `MYRMIDON_BOT_MCP_SERVERS` entry with `"noAuth": true`.
  Address the service as `media-mcp` inside the bots network: the host gateway address or a
  published port hide the source, and the bots become indistinguishable.
- `token_sha256`: the bot's own bearer (only the hash lives in the config). The shared
  `MYRMIDON_BOT_MCP_SERVERS` entry gives every bot one token, so a personal token still
  needs a per-bot entry; it can be combined with `peer_host`, then both must match.
- `tools`: which tools are open to the bot; `quota_bytes`, `rate_per_min`: own limits.

## Deploying

1. Images: `ghcr.io/itkadr-git/myrmidon-media-mcp`, `…-media-worker`, `…-media-tika` (tags
   `main`, `sha-…`, `X.Y.Z`); Gotenberg is pinned by digest in `compose.example.yml`.
2. Create `config/bots.json` and `secrets/worker_token` (a random string of 32+ characters).
   The `spool` volume is named: the images create `/spool` owned by user 10001, Docker copies
   the owner from the image on first use, nothing to prepare. If the volume is bound to a
   host directory (`driver_opts`, see `compose.example.yml`), the directory must be
   `chown 10001:10001`. Without a size bound the volume can eat the whole disk: put the
   spool on its own size-bounded filesystem (a partition, an LV or a loop-mounted image) and
   set `MEDIA_SPOOL_MAX_BYTES` below its size.
3. `docker compose -f tools/media-mcp/compose.example.yml up -d` (the `myrmidon-bots`
   network already exists).
4. Acceptance: `media_probe` on a short clip; `ffmpeg_submit` with `subtitles`;
   `extract_text` on a scan with Russian text; `office_to_pdf` on a docx; an `.xlsm` with an
   auto-run macro leaves no traces; bot B cannot open bot A's file; one request beyond
   `rate_per_min` gets 429.
   For `dwg_convert`: a test DWG → DXF and → SVG from a bot with the tool in `tools`.
5. Add `{"name":"media","url":"http://media-mcp:8080/mcp","noAuth":true}` to
   `MYRMIDON_BOT_MCP_SERVERS` (it restarts the bot containers).

Memory limits in compose: facade 512 MB, worker 3 GB, Gotenberg 2 GB, Tika 1.5 GB.

## Isolation boundaries (what the service does not promise)

- The `media-backend` network is internal: there is no egress, but inside it the services see
  each other. So «Chromium without a network» is wrong. Chromium in Gotenberg runs with
  `--chromium-disable-javascript=true` and
  `--chromium-allow-list=^(file:///tmp/|data:)`: only the request's own files and `data:`
  load, requests to `http(s)` to other services of the network are refused.
- Gotenberg's `/tmp` is shared by all its requests: one request's files sit next to
  another's while a conversion runs. There is no per-bot separation inside Gotenberg;
  requests to it go through two facade slots.
- ffmpeg filters: the filter string forbids the backslash (ffmpeg expands escaping twice and
  a `filename=` option can be smuggled through it to open a foreign file or address);
  `force_style` accepts only `A-Za-z0-9=,&.- ` and space.
- The worker (ffmpeg, poppler) runs under one user and sees the whole spool, i.e. every
  bot's directory. A media-parsing vulnerability gives access to all bots' files for the
  retention window. Per-bot workers do not exist yet.
- Access to the MCP address is guarded by the Host header (`MEDIA_ALLOWED_HOSTS`, default
  `media-mcp,media-mcp:8080`); if the bots use another name, add it.

## Bot-side scripts

Ready client modules for the scripts that used to call the local ffmpeg/ffprobe live in
`tools/media-mcp/bot-scripts/`: a stdlib-only MCP client (`media_client.py`), the drop-in
layer `media_shim.py` (the `video_info`/`CompletedProcess` contracts, a fast-path on the
local ffmpeg) and the instructions for applying it in the live bot tree (`APPLY.md`).
A bot script gets the address and token from `MEDIA_TOOLS_URL`/`MEDIA_TOOLS_TOKEN`; the
token is the bot's personal entry in `config/bots.json` (see «Bot authentication»).

## Facade and worker settings

Service (not board server) environment variables: `MEDIA_BOTS_FILE`, `MEDIA_DATA_DIR`,
`MEDIA_WORKER_TOKEN`/`MEDIA_WORKER_TOKEN_FILE`, `MEDIA_GOTENBERG_URL`, `MEDIA_TIKA_URL`,
`MEDIA_WORKER_URL`, `MEDIA_MAX_REQUEST_BYTES`, `MEDIA_MAX_INLINE_RESULT_BYTES`,
`MEDIA_MAX_FILE_BYTES`, `MEDIA_BOT_QUOTA_BYTES`, `MEDIA_SPOOL_MAX_BYTES`,
`MEDIA_SPOOL_MIN_FREE_BYTES`, `MEDIA_MAX_CONVERT_BYTES`, `MEDIA_MAX_PDF_BYTES`,
`MEDIA_ALLOWED_HOSTS`, `MEDIA_FILE_TTL_HOURS`, `MEDIA_MAX_ACTIVE_JOBS_PER_BOT`,
`MEDIA_RATE_PER_MIN`, `MEDIA_MAX_TEXT_CHARS`, `MEDIA_BACKEND_TIMEOUT_S`,
`WORKER_CONCURRENCY`. Vendor code is untouched, so there are no lines in `SETTINGS.md` and
`DIVERGENCE.md`.