"""OPE-3288: расширенный тест полного media_shim_full.py — subprocess_run_shim с контрактом
CompletedProcess. Прогон в песочнице против живого стенда (поднимем его снова).
Важно: run_ffmpeg с inputs=None должен сам найти входные файлы в argv (алиасы)."""

import os
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("MEDIA_TOOLS_URL", "http://127.0.0.1:18081")
TOKFILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mediastand/bot_token.txt")
os.environ.setdefault("MEDIA_TOOLS_TOKEN", open(TOKFILE).read().strip())

# Эмулируем контейнер бота: ffmpeg «отсутствует»
_orig_which = shutil.which


def _fake_which(name):
    if name in ("ffmpeg", "ffprobe"):
        return None
    return _orig_which(name)


shutil.which = _fake_which

import media_shim_full as media_shim  # noqa: E402

MASTER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shorts_result.mp4")
fails = []


def check(label, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + label + ((" | " + detail) if detail else ""))
    if not cond:
        fails.append(label)


# 1) subprocess_run_shim: типичный вызов из render-ветки post_media_prep
tmpd = tempfile.mkdtemp(prefix="ope3288_shim2_")
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

# 2) контроль результата через video_info
info, err = media_shim.video_info(out)
check("render 1080x1920", info.get("width") == 1080 and info.get("height") == 1920, str(info))
check("render duration", info.get("duration") is not None, str(info.get("duration")))

# 3) провал: битый вход → rc=1, stderr не пустой
bad_argv = ["ffmpeg", "-y", "-loglevel", "error", "-i", os.path.join(tmpd, "missing.mp4"),
            "-c:v", "libx264", out + "2.mp4"]
cp2 = media_shim.subprocess_run_shim(bad_argv, cwd=tmpd)
check("bad input rc=1", cp2.returncode == 1, "rc=%s" % cp2.returncode)
check("bad input stderr non-empty", bool(getattr(cp2, "stderr", "")), repr(getattr(cp2, "stderr", ""))[:80])

# 4) интерфейс patch_tail
tail = media_shim.patch_tail()
check("patch_tail non-trivial", 21 <= len(tail.splitlines()) <= 40, str(len(tail.splitlines())))

print()
print("FAILURES:", fails if fails else "none")
sys.exit(1 if fails else 0)
