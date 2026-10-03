# Applying the bot-side media scripts in the live bot workspace

The scripts live in the repository under `tools/media-mcp/bot-scripts/` (this
directory). The full variant is stored here as `media_shim.py` — the name the
patch tail imports, so no renaming is needed at install time.

Audience: whoever has access to the profile container with the live bot
workspace (the shared `tools/posts` tree the bots run from). Run under the
same uid as the tree owners.

## Contents of the deliverable

- `media_client.py` — the MCP media-mcp client (stdlib-only, the bot
  container's Python 3.13).
- `media_shim.py` — the drop-in layer: `video_info` (the `_video_info`
  contract), `run_ffmpeg` / `subprocess_run_shim` (the CompletedProcess
  contract), `patch_tail()`.
- `test_media_client.py`, `test_media_shim_full.py`, `shorts_gate.py` — the
  checks.
- All files: copy them next to each other; the patch tail applies to
  `post_media_prep.py` (section 3).

## 1. Install the modules

Copy `media_client.py` and `media_shim.py` into the bot workspace directory
that holds the post-processing scripts (the `tools/posts` directory the bots
run from).

(Only the full variant is stored in the repository, under the name
`media_shim.py` — the name imported by the patch tail. The light variant is
not needed: the presence of a local ffmpeg switches the behavior back without
a separate file.)

## 2. Bot environment variables (the post-processing bots' containers)

```sh
export MEDIA_TOOLS_URL=http://media-mcp:8080   # the name inside the bot docker network
export MEDIA_TOOLS_TOKEN=<bot token>           # the bot's entry in the service's config/bots.json
# optional: MEDIA_TOOLS_POLL_INTERVAL (s, default 2),
# MEDIA_TOOLS_POLL_TIMEOUT (s, default 1800)
```

## 3. Patch post_media_prep.py (the tail, ~21 lines)

Append the block from `media_shim.patch_tail()` to the end of the file —

```sh
python3 -c "import media_shim; open('patch_tail.txt','w').write(media_shim.patch_tail())"
```

then append `patch_tail.txt` to the bot workspace's `post_media_prep.py`.

The block swaps `_video_info` (ffprobe -> media_probe, same contract) and
wraps `subprocess.run` for `argv[0]=='ffmpeg'` through the service — only when
no local ffmpeg exists. The existing 66 ffmpeg / 2 ffprobe call sites
themselves do not change.

## 4. media_look.py

The two ffmpeg call sites — wrap with the same `media_shim.run_ffmpeg`: replace
`subprocess.run([... 'ffmpeg' ...])` with `media_shim.run_ffmpeg(argv, cwd=...)`
or add the same tail (the clip conversion there is simple: `-i in -ss/-t out`).

## 5. Verification after applying (in the bot container, no ffmpeg)

```sh
cd tools/posts
python3 test_media_shim_full.py     # PASS against a live media-mcp
python3 shorts_gate.py <master.mp4> # Shorts 9:16, <=58 s — PASS
sha256sum post_media_prep.py        # record before/after the patch
```

## 6. Acceptance criterion

The video post-processing bot: a real master -> the select/render step of
post_media_prep -> Shorts ≤58 s, 9:16 -> verify with probe+sha256. Done = every
step runs live, the log goes into the tracking ticket.
