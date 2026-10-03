"""OPE-3288: «Shorts-гейт» — минимальный эквивалент приёмочного критерия тикета,
выполняется в контейнере бота (ffmpeg НЕТ) через media_client. Ровно то, что будет
в патче post_media_prep.py как шаг проверки результата render."""
import sys
import time

sys.path.insert(0, "/tmp")
import media_client  # noqa: E402

MASTER = sys.argv[1] if len(sys.argv) > 1 else "/tmp/out/shorts_result.mp4"
OUT_DIR = "/tmp/out"

# Шаг 1: probe мастера (замена ffprobe)
pr = media_client.probe(MASTER)
v = next(s for s in pr["streams"] if s.get("codec_type") == "video")
dur = float(pr["format"]["duration"])
print("master: duration=%s size=%sx%s fps=%s" % (dur, v.get("width"), v.get("height"), v.get("r_frame_rate")))

# Шаг 2: render под Shorts: 9:16 (crop центр + scale 1080x1920), длительность <= 58
target = min(dur, 58.0)
outs = media_client.ffmpeg_run(
    spec={"inputs": [{"file": "master", "start": 0, "duration": target}],
          "video_filter": "crop=ih*9/16:ih,scale=1080:1920,setsar=1",
          "output": {"name": "shorts_final.mp4", "format": "mp4", "video_codec": "libx264",
                     "crf": 23, "preset": "veryfast", "max_duration": 58, "faststart": True}},
    files={"master": MASTER}, out_dir=OUT_DIR)
res = outs[0]["local_path"]

# Шаг 3: контроль результата СЕРВИСОМ (замена ffprobe-гейта)
pr2 = media_client.probe(res)
v2 = next(s for s in pr2["streams"] if s.get("codec_type") == "video")
d2 = float(pr2["format"]["duration"])
ok = d2 <= 58.0 and (v2.get("width"), v2.get("height")) == (1080, 1920)
print("result: duration=%s size=%sx%s" % (d2, v2.get("width"), v2.get("height")))
print("SHORTS_GATE: %s (файл %s, sha256 %s)" % ("PASS" if ok else "FAIL", res, outs[0]["sha256"]))
sys.exit(0 if ok else 1)
