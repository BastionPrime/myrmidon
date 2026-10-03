"""myrmidon(MEDIA-SCRIPTS): test of media_client.py against a live local media-mcp
stand (the same protocol and contract as the production media-mcp in the bot
network). Covers the API the patched post_media_prep.py will use: probe,
ffmpeg_run (Shorts 9:16), download, upload.

The stand URL and the bot token are provided by the environment
(MEDIA_TOOLS_URL / MEDIA_TOOLS_TOKEN); a token file next to this test is used
as a fallback. A sample video is generated when ffmpeg is available locally,
otherwise an existing sample must be supplied via SAMPLE.
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
if not os.environ.get("MEDIA_TOOLS_URL"):
    os.environ["MEDIA_TOOLS_URL"] = "http://127.0.0.1:18081"
_tokfile = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mediastand/bot_token.txt")
if not os.environ.get("MEDIA_TOOLS_TOKEN") and os.path.isfile(_tokfile):
    os.environ["MEDIA_TOOLS_TOKEN"] = open(_tokfile).read().strip()

import media_client  # noqa: E402

SAMPLE = os.environ.get("SAMPLE") or os.path.join(tempfile.gettempdir(), "shorts_sample.mp4")

failures = []


def check(label, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + label + (" | " + detail if detail else ""))
    if not cond:
        failures.append(label)


# 0. produce a local sample when ffmpeg exists (a 12 s 1080x1920 clip)
if not os.path.exists(SAMPLE):
    import subprocess
    rc = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi",
                         "-i", "testsrc2=size=1080x1920:rate=30:duration=12",
                         "-c:v", "libx264", "-preset", "veryfast", SAMPLE]).returncode
    if rc != 0:
        print("sample generation failed; set SAMPLE to an existing video")
        sys.exit(2)

# 1. probe the sample (a real mp4)
pr = media_client.probe(SAMPLE)
v = next(s for s in pr["streams"] if s.get("codec_type") == "video")
check("probe duration", abs(float(pr["format"]["duration"]) - 12.0) < 0.5, pr["format"]["duration"])
check("probe size 1080x1920", v.get("width") == 1080 and v.get("height") == 1920)

# 2. ffmpeg_run: the Shorts pipeline from the "master" (the sample as the donor):
#    the crop to 9:16 is already done; the task now is conversion + a cut to
#    10 s + faststart.
out_dir = tempfile.mkdtemp(prefix="media_client_test_")
outs = media_client.ffmpeg_run(
    spec={"inputs": [{"file": "master", "start": 0, "duration": 10}],
          "video_filter": "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1",
          "output": {"name": "shorts_final.mp4", "format": "mp4", "video_codec": "libx264",
                     "crf": 23, "preset": "veryfast", "max_duration": 58, "faststart": True}},
    files={"master": SAMPLE},
    out_dir=out_dir)
check("ffmpeg_run outputs", len(outs) == 1, str(outs))
o = outs[0]
check("ffmpeg_run local_path", os.path.exists(o.get("local_path", "")), o.get("local_path", ""))

# 3. probe the ffmpeg_run result
pr2 = media_client.probe(o["local_path"])
v2 = next(s for s in pr2["streams"] if s.get("codec_type") == "video")
check("result duration <= 58", float(pr2["format"]["duration"]) <= 58.0, pr2["format"]["duration"])
check("result 1080x1920", v2.get("width") == 1080 and v2.get("height") == 1920,
      "%sx%s" % (v2.get("width"), v2.get("height")))

# 4. loudness on a video without audio -> expect a clear error
try:
    media_client.loudness(o["local_path"])
    check("loudness no-audio raises", False, "no error raised")
except media_client.MediaError as e:
    check("loudness no-audio raises", True, str(e)[:120])

# 5. a large upload through the REST path (a 25 MiB random blob)
big = os.path.join(out_dir, "big_test.bin")
with open(big, "wb") as fh:
    fh.write(os.urandom(25 * 2 ** 20))
meta = media_client.upload(big)
check("upload REST", "id" in meta and meta.get("size") == 25 * 2 ** 20, str(meta)[:120])
media_client._delete_quiet(meta["id"])

print()
print("FAILURES:", failures if failures else "none")
sys.exit(1 if failures else 0)
