"""Typed job specs and their translation to argv. Pure functions, no I/O.

The bot never supplies an argv. It supplies a small JSON spec; this module
validates it against allow-lists and builds the command line. The same code
runs in the facade (fail early) and in the worker (defence in depth).
"""

from __future__ import annotations

import re
from typing import Any

ALIAS_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._-]{0,79}$")
OUT_NAME_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._%-]{0,79}$")

MAX_FILTER_LEN = 4000
MAX_INPUTS = 12
MAX_DURATION_S = 3600.0
MAX_FRAMES = 300
MAX_DIM = 8192


class SpecError(ValueError):
    """The spec is invalid; the message is safe to show the bot."""


# --- ffmpeg -----------------------------------------------------------------

VIDEO_CODECS = {"libx264", "libx265", "libvpx-vp9", "libaom-av1", "mjpeg", "png", "gif", "libwebp", "copy", "none"}
AUDIO_CODECS = {"aac", "libmp3lame", "libopus", "libvorbis", "flac", "pcm_s16le", "copy", "none"}
FORMATS = {
    "mp4": "mp4", "mov": "mov", "mkv": "matroska", "webm": "webm", "gif": "gif",
    "mp3": "mp3", "m4a": "ipod", "wav": "wav", "ogg": "ogg", "flac": "flac", "opus": "opus",
    "png": "image2", "jpg": "image2", "webp": "webp",
}
PRESETS = {"ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow"}
PIX_FMTS = {"yuv420p", "yuv422p", "yuv444p", "rgb24", "rgba", "gray", "yuva420p"}
# Generators that read nothing from disk or network.
LAVFI_SOURCES = {"color", "nullsrc", "testsrc", "testsrc2", "smptebars", "anullsrc", "sine", "anoisesrc", "gradients"}
# Filters that take a file argument: option name -> validator kind.
FILE_FILTERS = {"subtitles": {"filename", "fontsdir"}, "ass": {"filename", "fontsdir"}}
ALLOWED_FILTERS = {
    # video
    "scale", "scale2ref", "crop", "pad", "fps", "format", "setsar", "setdar", "setpts", "trim", "overlay",
    "hflip", "vflip", "transpose", "rotate", "eq", "colorbalance", "hue", "colorchannelmixer", "unsharp",
    "gblur", "boxblur", "drawbox", "fade", "xfade", "zoompan", "thumbnail", "select", "tile", "blend",
    "colorkey", "chromakey", "palettegen", "paletteuse", "loop", "reverse", "vignette", "split", "null",
    "fifo", "concat", "minterpolate", "tblend", "framestep", "lut", "lutyuv", "lutrgb", "negate",
    # audio
    "atrim", "asetpts", "amix", "amerge", "aresample", "atempo", "volume", "loudnorm", "ebur128", "dynaudnorm",
    "alimiter", "acompressor", "sidechaincompress", "afade", "adelay", "apad", "aformat", "anull", "asplit",
    "areverse", "aloop", "acrossfade", "highpass", "lowpass", "equalizer", "silenceremove", "silencedetect",
    "volumedetect", "astats", "pan", "channelsplit", "channelmap", "aecho", "areverse", "asetrate", "atempo",
    # analysis
    "cropdetect", "blackdetect", "freezedetect", "scdet", "signalstats", "showinfo",
} | set(FILE_FILTERS)


def _is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def check_alias(name: Any, aliases: set[str] | None = None) -> str:
    if not isinstance(name, str) or not ALIAS_RE.match(name) or ".." in name:
        raise SpecError(f"bad file alias {name!r}")
    if aliases is not None and name not in aliases:
        raise SpecError(f"file {name!r} is not among the job inputs")
    return name


def split_filtergraph(graph: str) -> list[tuple[str, str]]:
    """Return [(filter_name, raw_args)] for every filter in a filtergraph string."""
    if not isinstance(graph, str) or not graph.strip():
        raise SpecError("empty filter")
    if len(graph) > MAX_FILTER_LEN or "\n" in graph or "\r" in graph or "\x00" in graph:
        raise SpecError("filter too long or has control characters")
    parts: list[str] = []
    buf: list[str] = []
    quote = False
    bracket = 0
    i = 0
    while i < len(graph):
        c = graph[i]
        if c == "\\" and i + 1 < len(graph):
            buf.append(graph[i : i + 2])
            i += 2
            continue
        if c == "'":
            quote = not quote
        elif not quote:
            if c == "[":
                bracket += 1
            elif c == "]":
                bracket = max(0, bracket - 1)
            elif c in ",;" and bracket == 0:
                parts.append("".join(buf))
                buf = []
                i += 1
                continue
        buf.append(c)
        i += 1
    if quote:
        raise SpecError("unbalanced quote in filter")
    parts.append("".join(buf))
    out: list[tuple[str, str]] = []
    for p in parts:
        p = re.sub(r"^(\s*\[[^\]]*\])+", "", p)  # leading pad labels
        p = re.sub(r"(\[[^\]]*\]\s*)+$", "", p)  # trailing pad labels
        p = p.strip()
        if not p:
            continue
        name, _, args = p.partition("=")
        name = name.split("@", 1)[0].strip()
        out.append((name, args))
    if not out:
        raise SpecError("empty filter")
    return out


def _split_args(args: str) -> list[str]:
    parts, buf, quote, i = [], [], False, 0
    while i < len(args):
        c = args[i]
        if c == "\\" and i + 1 < len(args):
            buf.append(args[i : i + 2])
            i += 2
            continue
        if c == "'":
            quote = not quote
        if c == ":" and not quote:
            parts.append("".join(buf))
            buf = []
        else:
            buf.append(c)
        i += 1
    parts.append("".join(buf))
    return parts


def check_filtergraph(graph: str, aliases: set[str]) -> str:
    for name, args in split_filtergraph(graph):
        if name not in ALLOWED_FILTERS:
            raise SpecError(f"filter {name!r} is not allowed")
        if name in FILE_FILTERS:
            allowed_keys = FILE_FILTERS[name]
            for idx, part in enumerate(_split_args(args)):
                if not part:
                    continue
                key, sep, val = part.partition("=")
                if not sep:  # positional: subtitles=<filename>
                    key, val = ("filename" if idx == 0 else ""), part
                if key == "force_style":
                    continue
                if key not in allowed_keys:
                    raise SpecError(f"option {key!r} of {name} is not allowed")
                val = val.strip("'")
                if key == "fontsdir":
                    if val != ".":
                        raise SpecError("fontsdir must be '.' (fonts are uploaded next to the inputs)")
                else:
                    check_alias(val, aliases)
        else:
            # No other filter may reach for a path or URL.
            if re.search(r"(^|[=:\s'])(/|\.\./|file:|https?:|ftp:|pipe:|concat:|subfile:|tcp:|udp:)", args, re.I):
                raise SpecError(f"filter {name!r} has a path or URL argument")
    return graph


def _check_num(v: Any, name: str, lo: float, hi: float) -> float:
    if not _is_num(v) or not lo <= v <= hi:
        raise SpecError(f"{name} must be a number in [{lo}, {hi}]")
    return float(v)


def build_ffmpeg_argv(spec: dict[str, Any], aliases: set[str], out_dir: str = "../out") -> list[str]:
    """argv for ffmpeg; cwd is the job's `in` directory, output goes to ../out."""
    inputs = spec.get("inputs")
    if not isinstance(inputs, list) or not 1 <= len(inputs) <= MAX_INPUTS:
        raise SpecError(f"inputs: 1..{MAX_INPUTS} items")
    argv = ["ffmpeg", "-nostdin", "-hide_banner", "-nostats", "-loglevel", "error", "-y", "-threads", "2"]
    for i, inp in enumerate(inputs):
        if not isinstance(inp, dict):
            raise SpecError(f"inputs[{i}] must be an object")
        if "lavfi" in inp:
            src = inp["lavfi"]
            if not isinstance(src, str) or len(src) > 300:
                raise SpecError("lavfi source must be a short string")
            for name, _ in split_filtergraph(src):
                if name not in LAVFI_SOURCES:
                    raise SpecError(f"lavfi source {name!r} is not allowed")
            if re.search(r"[/\\]|file:|https?:", src):
                raise SpecError("lavfi source has a path or URL")
            if "d=" not in src and "duration=" not in src and not _is_num(inp.get("duration")):
                raise SpecError("lavfi source needs an explicit duration (d=… or duration)")
            argv += ["-f", "lavfi"]
            if _is_num(inp.get("duration")):
                argv += ["-t", str(_check_num(inp["duration"], "duration", 0.01, MAX_DURATION_S))]
            argv += ["-i", src]
            continue
        alias = check_alias(inp.get("file"), aliases)
        argv += ["-protocol_whitelist", "file"]
        if "start" in inp:
            argv += ["-ss", str(_check_num(inp["start"], "start", 0, 86400))]
        if "duration" in inp:
            argv += ["-t", str(_check_num(inp["duration"], "duration", 0.01, MAX_DURATION_S))]
        if inp.get("loop"):
            argv += ["-loop", "1"]
        if "framerate" in inp:
            argv += ["-framerate", str(_check_num(inp["framerate"], "framerate", 1, 120))]
        argv += ["-i", alias]

    fc, vf, af = spec.get("filter_complex"), spec.get("video_filter"), spec.get("audio_filter")
    if fc and (vf or af):
        raise SpecError("filter_complex excludes video_filter/audio_filter")
    if fc:
        argv += ["-filter_complex", check_filtergraph(fc, aliases)]
    if vf:
        argv += ["-vf", check_filtergraph(vf, aliases)]
    if af:
        argv += ["-af", check_filtergraph(af, aliases)]
    for m in spec.get("maps") or []:
        if not isinstance(m, str) or not re.match(r"^(\[[A-Za-z0-9_]{1,30}\]|\d{1,2}(:[vas](:\d)?|:\d{1,2})?\??)$", m):
            raise SpecError(f"bad map {m!r}")
        argv += ["-map", m]

    out = spec.get("output")
    if not isinstance(out, dict):
        raise SpecError("output is required")
    fmt = out.get("format")
    if fmt not in FORMATS:
        raise SpecError(f"output.format must be one of {sorted(FORMATS)}")
    name = out.get("name")
    if not isinstance(name, str) or not OUT_NAME_RE.match(name) or ".." in name:
        raise SpecError("output.name: letters, digits, . _ - and %03d-style counters only")
    if "%" in name and fmt not in ("png", "jpg", "webp"):
        raise SpecError("a %d pattern is only for image formats")
    if "%" in name and not re.fullmatch(r"[^%]*%0?\d?d[^%]*", name):
        raise SpecError("only one %d counter allowed in output.name")
    vc, ac = out.get("video_codec"), out.get("audio_codec")
    if vc is not None and vc not in VIDEO_CODECS:
        raise SpecError(f"video_codec must be one of {sorted(VIDEO_CODECS)}")
    if ac is not None and ac not in AUDIO_CODECS:
        raise SpecError(f"audio_codec must be one of {sorted(AUDIO_CODECS)}")
    if vc == "none":
        argv += ["-vn"]
    elif vc:
        argv += ["-c:v", vc]
    if ac == "none":
        argv += ["-an"]
    elif ac:
        argv += ["-c:a", ac]
    if "crf" in out:
        argv += ["-crf", str(int(_check_num(out["crf"], "crf", 0, 51)))]
    if "preset" in out:
        if out["preset"] not in PRESETS:
            raise SpecError(f"preset must be one of {sorted(PRESETS)}")
        argv += ["-preset", out["preset"]]
    for key, flag in (("video_bitrate", "-b:v"), ("audio_bitrate", "-b:a")):
        if key in out:
            if not isinstance(out[key], str) or not re.fullmatch(r"\d{2,5}[kKmM]", out[key]):
                raise SpecError(f"{key} looks like 192k or 4M")
            argv += [flag, out[key]]
    if "fps" in out:
        argv += ["-r", str(_check_num(out["fps"], "fps", 1, 120))]
    if "pix_fmt" in out:
        if out["pix_fmt"] not in PIX_FMTS:
            raise SpecError(f"pix_fmt must be one of {sorted(PIX_FMTS)}")
        argv += ["-pix_fmt", out["pix_fmt"]]
    if "sample_rate" in out:
        argv += ["-ar", str(int(_check_num(out["sample_rate"], "sample_rate", 8000, 96000)))]
    if "channels" in out:
        argv += ["-ac", str(int(_check_num(out["channels"], "channels", 1, 8)))]
    if "frames" in out:
        argv += ["-frames:v", str(int(_check_num(out["frames"], "frames", 1, MAX_FRAMES)))]
    elif "%" in name:
        argv += ["-frames:v", str(MAX_FRAMES)]
    max_dur = _check_num(out.get("max_duration", MAX_DURATION_S), "max_duration", 0.01, MAX_DURATION_S)
    argv += ["-t", str(max_dur)]
    if out.get("faststart") and fmt in ("mp4", "mov", "m4a"):
        argv += ["-movflags", "+faststart"]
    if fmt in ("png", "jpg"):
        argv += ["-update", "1"] if "%" not in name else []
    argv += ["-f", FORMATS[fmt], f"{out_dir}/{name}"]
    return argv


def ffmpeg_needs_aliases(spec: dict[str, Any]) -> set[str]:
    return {i["file"] for i in spec.get("inputs", []) if isinstance(i, dict) and "file" in i}


# --- probe -------------------------------------------------------------------


def build_probe_argv(alias: str) -> list[str]:
    check_alias(alias)
    return ["ffprobe", "-v", "error", "-protocol_whitelist", "file", "-show_format", "-show_streams",
            "-of", "json", alias]


def build_loudness_argv(alias: str) -> list[str]:
    check_alias(alias)
    return ["ffmpeg", "-nostdin", "-hide_banner", "-nostats", "-protocol_whitelist", "file", "-i", alias,
            "-vn", "-af", "ebur128=peak=true", "-f", "null", "-"]


# --- images (via ffmpeg) -----------------------------------------------------

IMAGE_FORMATS = {"jpg": ("mjpeg", "mjpeg"), "png": ("png", "image2"), "webp": ("libwebp", "webp")}
FITS = {"contain", "cover", "fill", "inside"}


def build_image_argv(spec: dict[str, Any], aliases: set[str], out_dir: str = "../out") -> list[str]:
    src = check_alias(spec.get("input"), aliases)
    fmt = spec.get("format", "jpg")
    if fmt not in IMAGE_FORMATS:
        raise SpecError(f"format must be one of {sorted(IMAGE_FORMATS)}")
    name = spec.get("output_name") or f"image.{fmt}"
    if not OUT_NAME_RE.match(name) or "%" in name or ".." in name:
        raise SpecError("bad output_name")
    vf: list[str] = []
    crop = spec.get("crop")
    if crop is not None:
        if not isinstance(crop, dict) or set(crop) != {"x", "y", "w", "h"}:
            raise SpecError("crop needs x, y, w, h")
        x, y = int(_check_num(crop["x"], "crop.x", 0, 100000)), int(_check_num(crop["y"], "crop.y", 0, 100000))
        w, h = int(_check_num(crop["w"], "crop.w", 1, 100000)), int(_check_num(crop["h"], "crop.h", 1, 100000))
        vf.append(f"crop={w}:{h}:{x}:{y}")
    rot = spec.get("rotate", 0)
    if rot not in (0, 90, 180, 270):
        raise SpecError("rotate is 0, 90, 180 or 270")
    vf += {0: [], 90: ["transpose=1"], 180: ["hflip", "vflip"], 270: ["transpose=2"]}[rot]
    width, height = spec.get("width"), spec.get("height")
    if width is not None or height is not None:
        wv = int(_check_num(width, "width", 1, MAX_DIM)) if width is not None else -2
        hv = int(_check_num(height, "height", 1, MAX_DIM)) if height is not None else -2
        fit = spec.get("fit", "inside")
        if fit not in FITS:
            raise SpecError(f"fit must be one of {sorted(FITS)}")
        if wv > 0 and hv > 0 and fit != "fill":
            mode = {"inside": "decrease", "contain": "decrease", "cover": "increase"}[fit]
            vf.append(f"scale={wv}:{hv}:force_original_aspect_ratio={mode}")
            if fit == "cover":
                vf.append(f"crop={wv}:{hv}")
            elif fit == "contain":
                bg = spec.get("background", "white")
                if not isinstance(bg, str) or not re.fullmatch(r"[A-Za-z]{3,20}|#?[0-9A-Fa-f]{6}", bg):
                    raise SpecError("background: a colour name or 6 hex digits")
                vf.append(f"pad={wv}:{hv}:(ow-iw)/2:(oh-ih)/2:color={'0x' + bg.lstrip('#') if re.fullmatch(r'#?[0-9A-Fa-f]{6}', bg) else bg}")
        else:
            vf.append(f"scale={wv}:{hv}")
    if fmt == "jpg":
        vf.append("format=yuvj420p")
    argv = ["ffmpeg", "-nostdin", "-hide_banner", "-nostats", "-loglevel", "error", "-y", "-threads", "2",
            "-protocol_whitelist", "file", "-i", src, "-frames:v", "1"]
    if vf:
        argv += ["-vf", ",".join(vf)]
    q = spec.get("quality")
    if q is not None:
        q = int(_check_num(q, "quality", 1, 100))
        if fmt == "jpg":
            argv += ["-q:v", str(max(2, round(31 - q * 29 / 100)))]
        elif fmt == "webp":
            argv += ["-quality", str(q)]
    codec, muxer = IMAGE_FORMATS[fmt]
    argv += ["-c:v", codec, "-update", "1", "-f", muxer, f"{out_dir}/{name}"]
    return argv


# --- pdf → images (poppler) --------------------------------------------------

MAX_PDF_PAGES = 40
MAX_DPI = 200


def build_pdf_images_argv(spec: dict[str, Any], aliases: set[str], out_dir: str = "../out") -> list[str]:
    src = check_alias(spec.get("input"), aliases)
    dpi = int(_check_num(spec.get("dpi", 110), "dpi", 30, MAX_DPI))
    first = int(_check_num(spec.get("first_page", 1), "first_page", 1, 100000))
    last = int(_check_num(spec.get("last_page", first + MAX_PDF_PAGES - 1), "last_page", first, 100000))
    if last - first + 1 > MAX_PDF_PAGES:
        raise SpecError(f"at most {MAX_PDF_PAGES} pages per call")
    fmt = spec.get("format", "png")
    if fmt not in ("png", "jpeg"):
        raise SpecError("format is png or jpeg")
    return ["pdftoppm", f"-{fmt}", "-r", str(dpi), "-f", str(first), "-l", str(last), src, f"{out_dir}/page"]
