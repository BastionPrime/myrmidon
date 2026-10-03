"""myrmidon(MEDIA-SCRIPTS): patch layer for post_media_prep.py — reroutes direct
ffmpeg/ffprobe subprocess calls to the media service. Applied on top of the live
post_media_prep.py in the bot workspace (the shim() function is inserted before
main, and the call sites are intercepted).

Strategy: local ffmpeg/ffprobe remain the FAST PATH (for environments that have
the binaries), and when they are absent the path automatically goes to the media
service (bot container). This keeps smm/operator working in environments with
local binaries and fixes video post-processing inside the bot container.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess

# --- media client (see media_client.py in the same directory) ---------------
import sys as _sys
import sys

_dir = os.path.dirname(os.path.abspath(__file__))
if _dir not in _sys.path:
    _sys.path.insert(0, _dir)

try:
    import media_client
    _HAS_MEDIA = True
except Exception:
    _HAS_MEDIA = False


class MediaFallbackError(RuntimeError):
    pass


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None


def ffprobe_available() -> bool:
    return shutil.which("ffprobe") is not None


def video_info(path: str) -> tuple[dict, str | None]:
    """myrmidon(MEDIA-SCRIPTS): {duration, size, ...} of a video file. Local
    ffprobe when present, otherwise media_probe. Returns (info, error) —
    the same contract the callers' _video_info helper had."""
    if ffprobe_available():
        try:
            proc = subprocess.run(
                ["ffprobe", "-v", "error", "-show_entries", "format=duration,size",
                 "-of", "json", path], capture_output=True, text=True, timeout=20)
            if proc.returncode != 0:
                return {}, (proc.stderr or "ffprobe failed").strip()
            return json.loads(proc.stdout).get("format", {}), None
        except (subprocess.TimeoutExpired, ValueError, OSError) as e:
            return {}, "ffprobe: %s" % e
    if not _HAS_MEDIA:
        return {}, None  # the old best-effort behavior for select: {}, not an error
    try:
        pr = media_client.probe(path)
    except media_client.MediaError as e:
        return {}, "media_probe: %s" % e
    fmt = pr.get("format", {})
    v = next((s for s in pr.get("streams", []) if s.get("codec_type") == "video"), {})
    info = {"duration": fmt.get("duration"), "size": fmt.get("size")}
    if v.get("width"):
        info["width"] = v["width"]
        info["height"] = v["height"]
    if v.get("r_frame_rate"):
        info["r_frame_rate"] = v["r_frame_rate"]
    return info, None


def run_ffmpeg(argv: list[str], inputs: dict[str, str] | None = None,
               output_path: str | None = None, cwd: str | None = None) -> int:
    """myrmidon(MEDIA-SCRIPTS): run ffmpeg. Locally — subprocess; in the bot
    container — argv conversion into a media service spec (a subset of the
    filters used by post_media_prep is supported: crop, scale, pad, setsar,
    overlay, drawtext (via subtitles/ass — service specs only), trim/atrim,
    concat via filter_complex, fade).

    argv[0] == 'ffmpeg'. Returns the exit code. Local output is written to
    output_path. For complex argv not covered by the spec, the conversion
    fails loudly (rc=1 with stderr text) so the failure is never silent."""
    if ffmpeg_available():
        proc = subprocess.run(argv, capture_output=True, text=True, cwd=cwd)
        return proc.returncode
    return media_ffmpeg_argv(argv, inputs, output_path, cwd)


# --- argv -> spec conversion --------------------------------------------------
# Only what actually appears in the bot post-processing scripts is supported.
# Anything else is a loud refusal.


def media_ffmpeg_argv(argv: list[str], inputs: dict[str, str] | None = None,
                       output_path: str | None = None, cwd: str | None = None) -> int:
    if not _HAS_MEDIA:
        raise MediaFallbackError("ffmpeg is not available and the media service is "
                                 "not configured (MEDIA_TOOLS_URL/MEDIA_TOOLS_TOKEN)")
    try:
        spec, alias_map = _argv_to_spec(argv, output_path)
    except MediaFallbackError as e:
        sys.stderr.write("[media-ffmpeg] %s\n" % e)
        return 1
    files = {alias: (os.path.join(cwd, p) if cwd and not os.path.isabs(p) else p)
             for alias, p in (inputs or alias_map).items()}
    out_dir = os.path.dirname(output_path) if output_path else (cwd or ".")
    try:
        outs = media_client.ffmpeg_run(spec, files=files, out_dir=out_dir)
    except (media_client.MediaError, OSError) as e:
        sys.stderr.write("[media-ffmpeg] %s\n" % e)
        return 1
    return 0


def _argv_to_spec(argv: list[str], output_path: str | None):
    """Minimal parser: -i (files), -vf/-af/-filter_complex, -ss/-t before -i,
    -c:v/-c:a, -crf, -preset, -r, -pix_fmt, -movflags +faststart, the output
    file. lavfi inputs and %d patterns are not supported (they do not appear
    in the bot scripts). Output-side -ss/-t (placed after the last -i) are not
    representable in the service spec: they fail loudly instead of a silent
    drop."""
    if not argv or argv[0] != "ffmpeg":
        raise MediaFallbackError("expected argv[0]=ffmpeg")
    inputs_spec: list[dict] = []
    alias_map: dict[str, str] = {}
    vf = af = fc = None
    out_opts: dict = {"format": "mp4"}
    out_name = None
    i = 1
    cur_in: dict = {}
    seen_input = False
    n = 0
    while i < len(argv):
        a = argv[i]
        if a == "-i":
            src = argv[i + 1]
            if src.startswith("lavfi:"):
                raise MediaFallbackError("lavfi inputs are not supported by the conversion")
            alias = "in%d" % n
            n += 1
            inputs_spec.append({"file": alias, **cur_in})
            alias_map[alias] = src
            cur_in = {}
            seen_input = True
            i += 2
        elif a in ("-vf", "-filter:v"):
            vf = argv[i + 1]; i += 2
        elif a in ("-af", "-filter:a"):
            af = argv[i + 1]; i += 2
        elif a == "-filter_complex":
            fc = argv[i + 1]; i += 2
        elif a == "-ss":
            if seen_input:
                raise MediaFallbackError("output-side -ss is not supported by the "
                                         "conversion; move it before -i or use an input spec")
            cur_in["start"] = float(argv[i + 1]); i += 2
        elif a in ("-t",):
            if seen_input:
                raise MediaFallbackError("output-side -t is not supported by the "
                                         "conversion; move it before -i or use an input spec")
            cur_in["duration"] = float(argv[i + 1]); i += 2
        elif a == "-c:v":
            out_opts["video_codec"] = argv[i + 1]; i += 2
        elif a == "-c:a":
            out_opts["audio_codec"] = argv[i + 1]; i += 2
        elif a == "-crf":
            out_opts["crf"] = int(argv[i + 1]); i += 2
        elif a == "-preset":
            out_opts["preset"] = argv[i + 1]; i += 2
        elif a == "-r":
            out_opts["fps"] = float(argv[i + 1]); i += 2
        elif a == "-pix_fmt":
            out_opts["pix_fmt"] = argv[i + 1]; i += 2
        elif a == "-movflags":
            if "faststart" in argv[i + 1]:
                out_opts["faststart"] = True
            i += 2
        elif a == "-y" or a.startswith("-hide") or a.startswith("-nost"):
            i += 1
        elif a == "-loglevel":
            i += 2
        elif a == "-b:v":
            out_opts["video_bitrate"] = argv[i + 1]; i += 2
        elif a == "-b:a":
            out_opts["audio_bitrate"] = argv[i + 1]; i += 2
        elif a == "-an":
            out_opts["audio_codec"] = "none"; i += 1
        elif a == "-vn":
            out_opts["video_codec"] = "none"; i += 1
        else:
            # positional output file
            if not a.startswith("-"):
                out_name = a
                ext = os.path.splitext(a)[1].lstrip(".").lower()
                if ext in ("mp4", "mov", "mkv", "webm", "gif", "mp3", "m4a", "wav", "ogg", "png", "jpg"):
                    out_opts["format"] = ext
                i += 1
            else:
                raise MediaFallbackError("not supported by the conversion: %s" % a)
    if out_name is None and output_path:
        out_name = os.path.basename(output_path)
    if out_name is None:
        raise MediaFallbackError("output file not found in argv")
    spec = {"inputs": inputs_spec, "output": {**out_opts, "name": os.path.basename(out_name)}}
    if fc:
        spec["filter_complex"] = fc
    else:
        if vf:
            spec["video_filter"] = vf
        if af:
            spec["audio_filter"] = af
    # service filter graph limits: backslashes are banned by the spec; quotes do
    # not appear in the bot scripts' filter strings
    for key in ("video_filter", "audio_filter", "filter_complex"):
        val = spec.get(key)
        if val and "\\" in val:
            raise MediaFallbackError("filter graph contains a backslash (banned by the service): %s" % key)
    return spec, alias_map
# ---------------------------------------------------------------------------
# subprocess.run-compatible wrapper (myrmidon(MEDIA-SCRIPTS))
# ---------------------------------------------------------------------------

def subprocess_run_shim(argv, cwd=None, timeout=None):
    """A drop-in replacement for subprocess.run(argv) when argv[0]=='ffmpeg'
    and no local binary exists.

    Returns subprocess.CompletedProcess: returncode 0/1, stderr with the error
    text. The service output file is downloaded to the path of the last
    positional argument of argv (ffmpeg CLI: the single output goes last), so
    the caller finds the file exactly where it expected local ffmpeg to put
    it."""
    import subprocess as _sp

    out = None
    for tok in reversed(argv):
        if isinstance(tok, str) and not tok.startswith("-"):
            idx = argv.index(tok)
            if idx > 0 and argv[idx - 1].startswith("-"):
                continue
            out = tok
            break
    if out is None:
        cp = _sp.CompletedProcess(argv, 1)
        cp.stderr = "media-ffmpeg: output file not recognized in argv"
        return cp
    out_abs = os.path.join(cwd, out) if cwd and not os.path.isabs(out) else out
    rc = media_ffmpeg_argv(argv, inputs=None, output_path=out_abs, cwd=cwd)
    cp = _sp.CompletedProcess(argv, rc)
    cp.stderr = "" if rc == 0 else "media-ffmpeg: the service job failed (see stderr above)"
    return cp


def patch_tail() -> str:
    """The block appended to the end of post_media_prep.py (the live copy in the
    bot workspace). It swaps _video_info (same contract) and wraps subprocess.run
    for ffmpeg argv, only when no local ffmpeg exists."""
    return """
# --- myrmidon(MEDIA-SCRIPTS): media service instead of local ffmpeg --------
# The tail is appended automatically; with a local ffmpeg present nothing
# changes at all (fast path); in the bot container calls go to media-mcp.
try:
    import media_shim as _media_shim

    _video_info = _media_shim.video_info  # the _video_info contract is preserved

    if not _media_shim.ffmpeg_available():
        _subprocess_run_orig = subprocess.run

        def _subprocess_run(argv, *a, **kw):
            if isinstance(argv, (list, tuple)) and argv and argv[0] == "ffmpeg":
                return _media_shim.subprocess_run_shim(list(argv), cwd=kw.get("cwd"),
                                                       timeout=kw.get("timeout"))
            return _subprocess_run_orig(argv, *a, **kw)

        subprocess.run = _subprocess_run
except Exception:
    pass  # an environment without the media service keeps working as before
"""
