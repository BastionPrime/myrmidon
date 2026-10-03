"""OPE-3288: тест media_client.py на живом локальном стенде media-mcp (тот же протокол,
тот же контракт, что у боевого media-mcp в сети ботов). Проверяем API, которым будет
пользоваться патченый post_media_prep.py: probe, ffmpeg_run (Shorts 9:16), download."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ["MEDIA_TOOLS_URL"] = "http://127.0.0.1:18081"
os.environ["MEDIA_TOOLS_TOKEN"] = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                    "mediastand/bot_token.txt")).read().strip()

import media_client  # noqa: E402

failures = []


def check(label, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + label + (" | " + detail if detail else ""))
    if not cond:
        failures.append(label)


# 1. probe на результате e2e (реальный mp4)
pr = media_client.probe("shorts_result.mp4")
v = next(s for s in pr["streams"] if s.get("codec_type") == "video")
check("probe duration", abs(float(pr["format"]["duration"]) - 12.0) < 0.5, pr["format"]["duration"])
check("probe size 1080x1920", v.get("width") == 1080 and v.get("height") == 1920)

# 2. ffmpeg_run: Shorts-конвейер из «мастера» (shorts_result.mp4 как донор):
#    кроп до 9:16 уже сделан; теперь задача: конверт + подрезка до 58 c + faststart.
outs = media_client.ffmpeg_run(
    spec={"inputs": [{"file": "master", "start": 0, "duration": 10}],
          "video_filter": "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1",
          "output": {"name": "shorts_final.mp4", "format": "mp4", "video_codec": "libx264",
                     "crf": 23, "preset": "veryfast", "max_duration": 58, "faststart": True}},
    files={"master": "shorts_result.mp4"},
    out_dir="/srv/dev/OPE-3288/scratch/out")
check("ffmpeg_run outputs", len(outs) == 1, str(outs))
o = outs[0]
check("ffmpeg_run local_path", os.path.exists(o.get("local_path", "")), o.get("local_path", ""))

# 3. probe результата ffmpeg_run
pr2 = media_client.probe(o["local_path"])
v2 = next(s for s in pr2["streams"] if s.get("codec_type") == "video")
check("result duration <= 58", float(pr2["format"]["duration"]) <= 58.0, pr2["format"]["duration"])
check("result 1080x1920", v2.get("width") == 1080 and v2.get("height") == 1920,
      "%sx%s" % (v2.get("width"), v2.get("height")))

# 4. loudness на видео без аудио → ожидаем понятную ошибку
try:
    media_client.loudness(o["local_path"])
    check("loudness no-audio raises", False, "no error raised")
except media_client.MediaError as e:
    check("loudness no-audio raises", True, str(e)[:120])

# 5. большая загрузка через REST upload (спрайт > 24 МиБ? нет — просто проверка REST-пути)
big = "/srv/dev/OPE-3288/scratch/big_test.bin"
with open(big, "wb") as fh:
    fh.write(os.urandom(25 * 2 ** 20))
meta = media_client.upload(big)
check("upload REST", "id" in meta and meta.get("size") == 25 * 2 ** 20, str(meta)[:120])
media_client._delete_quiet(meta["id"])

print()
print("FAILURES:", failures if failures else "none")
sys.exit(1 if failures else 0)
