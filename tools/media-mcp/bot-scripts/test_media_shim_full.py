"""myrmidon(MEDIA-SCRIPTS): the extended test of media_shim.py — the
subprocess_run_shim wrapper with the CompletedProcess contract, run against a
live media-mcp stand. Important: run_ffmpeg with inputs=None must find the
input files in argv by itself (via aliases).

The stand URL and the bot token are provided by the environment
(MEDIA_TOOLS_URL / MEDIA_TOOLS_TOKEN); a token file next to this test is used
as a fallback. A sample video is generated when ffmpeg is available locally,
otherwise an existing sample must be supplied via SAMPLE.
"""

import os
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
if not os.environ.get("MEDIA_TOOLS_URL"):
    os.environ.setdefault("MEDIA_TOOLS_URL", "http://127.0.0.1:18081")
TOKFILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mediastand/bot_token.txt")
if not os.environ.get("MEDIA_TOOLS_TOKEN") and os.path.isfile(TOKFILE):
    os.environ.setdefault("MEDIA_TOOLS_TOKEN", open(TOKFILE).read().strip())

# Emulate the bot container: ffmpeg is "absent"
_orig_which = shutil.which


def _fake_which(name):
    if name in ("ffmpeg", "ffprobe"):
        return None
    return _orig_which(name)


shutil.which = _fake_which

import media_shim  # noqa: E402

SAMPLE = os.environ.get("SAMPLE") or os.path.join(tempfile.gettempdir(), "shorts_sample.mp4")
MASTER = SAMPLE

fails = []


def check(label, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + label + ((" | " + detail) if detail else ""))
    if not cond:
        fails.append(label)


# 0. produce a local sample when ffmpeg exists (before the which() swap above
# has been applied to the generation call)
_orig_shutil_which = shutil.which
shutil.which = _orig_which
if not os.path.exists(MASTER):
    rc = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi",
                         "-i", "testsrc2=size=1080x1920:rate=30:duration=12",
                         "-c:v", "libx264", "-preset", "veryfast", MASTER]).returncode
    if rc != 0:
        print("sample generation failed; set SAMPLE to an existing video")
        sys.exit(2)
shutil.which = _fake_which

# 1) subprocess_run_shim: a typical call from the render branch of post_media_prep
tmpd = tempfile.mkdtemp(prefix="media_shim_test_")
out = os.path.join(tmpd, "render_out.mp4")
argv = ["ffmpeg", "-y", "-loglevel", "error", "-i", MASTER, "-t", "10",
        "-vf", "crop=ih*9/16:ih,scale=1080:1920,setsar=1",
        "-c:v", "libx264", "-crf", "23", "-preset", "veryfast",
        "-movflags", "+faststart", out]
cp = media_shim.subprocess_run_shim(argv, cwd=tmpd, timeout=60)
check("CompletedProcess type", isinstance(cp, subprocess.CompletedProcess), type(cp).__name__)
check("returncode == 0", cp.returncode == 0, "rc=%s" % cp.returncode)
check("output file exists", os.path.exists(out), out)
check("stderr ok", getattr(cp, "stderr", "x") == "", repr(getattr(cp, "stderr", None))[:80])

# 2) verify the result through video_info
info, err = media_shim.video_info(out)
check("render 1080x1920", info.get("width") == 1080 and info.get("height") == 1920, str(info))
check("render duration", info.get("duration") is not None, str(info.get("duration")))

# 3) failure: a missing input -> rc=1, non-empty stderr
bad_argv = ["ffmpeg", "-y", "-loglevel", "error", "-i", os.path.join(tmpd, "missing.mp4"),
            "-c:v", "libx264", out + "2.mp4"]
cp2 = media_shim.subprocess_run_shim(bad_argv, cwd=tmpd)
check("bad input rc=1", cp2.returncode == 1, "rc=%s" % cp2.returncode)
check("bad input stderr non-empty", bool(getattr(cp2, "stderr", "")), repr(getattr(cp2, "stderr", ""))[:80])

# 4) output-side -ss/-t must fail loudly, not silently drop the cut
loud_argv = ["ffmpeg", "-y", "-loglevel", "error", "-i", MASTER, "-ss", "5", "-t", "10",
             "-c:v", "libx264", out + "3.mp4"]
try:
    cp3 = media_shim.subprocess_run_shim(loud_argv, cwd=tmpd)
    check("output-side -ss/-t fails loudly", cp3.returncode == 1 and bool(cp3.stderr),
          "rc=%s" % cp3.returncode)
except Exception as e:  # noqa: BLE001
    check("output-side -ss/-t fails loudly", True, type(e).__name__)

# 5) the patch_tail interface
tail = media_shim.patch_tail()
check("patch_tail non-trivial", 21 <= len(tail.splitlines()) <= 40, str(len(tail.splitlines())))
check("patch_tail neutral marker", "myrmidon(MEDIA-SCRIPTS)" in tail and not __import__("re").search(r"OPE-\d", tail), "")

print()
print("FAILURES:", fails if fails else "none")
sys.exit(1 if fails else 0)
