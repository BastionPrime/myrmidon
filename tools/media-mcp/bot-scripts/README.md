# Bot-side media scripts

Client-side modules of the media service for bot scripts that used to call
local ffmpeg/ffprobe (`post_media_prep.py`, `media_look.py` in the bot
workspace, `tools/posts`). The bot image has no ffmpeg — these modules reroute
the calls to media-mcp (`docs/myrmidon/media-tools.md`) without changing the
calling code.

- `media_client.py` — a stdlib-only MCP media-tools client (probe, loudness,
  ffmpeg_submit + job_status polling, REST `/v1/files` for large files).
- `media_shim.py` — the drop-in layer: `video_info()` (the `_video_info`
  contract), `run_ffmpeg()`, `subprocess_run_shim()` (the
  `subprocess.CompletedProcess` contract) and `patch_tail()` — the tail block
  for `post_media_prep.py`. Local ffmpeg stays a fast path: an environment
  with the binary behaves exactly as before.
- `test_media_client.py`, `test_media_shim_full.py` — checks against a live
  media-mcp (a stand or production); run them from the directory with the
  modules. `SAMPLE` selects the input video; a sample is generated when a
  local ffmpeg exists.
- `shorts_gate.py` — the acceptance-criterion model: Shorts 9:16, duration
  ≤58 s, through the service from a bot container without ffmpeg.
- `patch_tail.txt` — the ready tail block for `post_media_prep.py` (generated
  by `media_shim.patch_tail()`).
- `APPLY.md` — the apply instructions for the live bot workspace (bot
  variables `MEDIA_TOOLS_URL`/`MEDIA_TOOLS_TOKEN`, patch points, checks after
  the patch).

The service image builds are unaffected by these files (`COPY src`, `COPY
tests` cover only the facade/worker Python package), but the
`myrmidon-media-tools.yml` workflow reacts to changes under
`tools/media-mcp/**` and runs the service unit tests.
